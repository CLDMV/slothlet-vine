/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/serve-principal-units.test.vitest.mjs
 *
 * Unit-level coverage of the channel principal (#33) with a FAKE slothlet instance and hand-built
 * frames: principal normalization and the `serving.principal` diagnostic, the fail-closed setup
 * preconditions, every fail-closed path of the call gate (a gate that throws / answers junk / is
 * missing, a resolver that throws / answers junk, a scope that fails), the pipeline ORDER (`NO_LEAF`
 * beats `DENIED` beats `DATA_ONLY`), the `VINE_DENIED` wire shape, the event server-half's narrowing
 * rules (`null` = the channel; a forged sibling is ignored; a hint under the principal can only
 * narrow), `grow({ principal })`'s event half, and an explicit pin of the v1 no-principal behaviour.
 *
 * A fake is the point: `permissions.global.checkCall` does not exist on any published slothlet yet
 * (CLDMV/slothlet#508), and the fail-closed paths need a gate that misbehaves on demand. The real-
 * instance e2e lives in `e2e-loopback-principal.test.vitest.mjs`.
 */
import { describe, it, expect } from "vitest";
import { grow } from "../src/grow.mjs";
import { serve } from "../src/serve.mjs";
import { CODES } from "../src/lib/errors.mjs";
import { bindPrincipal, gate, isNarrowingHint, narrowest, normalizePrincipal } from "../src/lib/principal.mjs";
import { createPair } from "../src/transport/loopback.mjs";

/**
 * A Channel that records every outbound frame and lets a test push frames at the registered handler.
 * @param {object} [behaviour]
 * @param {boolean} [behaviour.syncSurface] - Deliver an (empty) surface frame during `onMessage` — what a grow needs to settle.
 * @returns {object} The fake channel plus test controls.
 */
function fakeChannel(behaviour = {}) {
	const sent = [];
	let handler = null;
	const channel = {
		sent,
		send(frame) {
			sent.push(frame);
		},
		onMessage(fn) {
			handler = fn;
			if (behaviour.syncSurface) fn({ type: "surface", v: 1, leaves: [] });
		},
		onClose() {},
		/**
		 * @param {unknown} frame - The frame to push at the handler.
		 * @returns {void}
		 */
		deliver(frame) {
			handler?.(frame);
		},
		/**
		 * @param {string} type - Frame type to look for.
		 * @returns {object[]} Every sent frame of that type.
		 */
		ofType(type) {
			return sent.filter((frame) => frame.type === type);
		}
	};
	return channel;
}

/**
 * A minimal stand-in for a slothlet instance with the surfaces a principal-bound end touches:
 * `api.leaves`, `permissions.control.enabled`, `permissions.global.checkCall`, `context.scope` /
 * `context.run` (both ASYNC, as on the real instance), `event.resolveLevel` / `event.on`, `caller`.
 * Every interaction is recorded on `api.log` in order, so a test can assert that the gate ran inside
 * the scope and before the leaf.
 * @param {object} [behaviour]
 * @param {Array<{path: string, kind: string}>} [behaviour.records] - What `leaves(".")` answers.
 * @param {boolean} [behaviour.enabled=true] - `permissions.control.enabled`.
 * @param {boolean} [behaviour.noPermissions] - Omit `slothlet.permissions` entirely.
 * @param {boolean} [behaviour.noCheckCall] - Omit `permissions.global.checkCall`.
 * @param {boolean} [behaviour.noResolveLevel] - Omit `event.resolveLevel`.
 * @param {boolean} [behaviour.noScope] - Omit `context.scope`.
 * @param {boolean} [behaviour.noRun] - Omit `context.run`.
 * @param {Function} [behaviour.checkCall] - Replacement gate; default allows everything.
 * @param {Function} [behaviour.scope] - Replacement scope; default runs `fn` and records `{ context, protect }`.
 * @param {Function} [behaviour.run] - Replacement run; default runs `fn` and records `context`.
 * @param {Record<string, string>|Function} [behaviour.levels] - `resolveLevel` answers keyed `"<subscriberPath>|<event>"` (`null` → `"null"`), or a function.
 * @param {boolean} [behaviour.stickyOff] - Make `event.on`'s `off()` a no-op, so a dropped subscription's listener still fires.
 * @returns {object} The fake api.
 */
function fakeApi(behaviour = {}) {
	const log = [];
	const listeners = new Map();
	const api = {
		log,
		scopes: [],
		runs: [],
		gates: [],
		resolves: [],
		/**
		 * Fire every host listener for `event`, as slothlet's emit would.
		 * @param {string} event - Event name.
		 * @param {unknown} payload - Payload.
		 * @returns {void}
		 */
		emit(event, payload) {
			for (const listener of listeners.get(event) ?? []) listener(payload, { event, at: 1, instanceID: "fake" });
		},
		slothlet: {
			api: {
				async leaves() {
					return behaviour.records ?? [{ path: "math.add", kind: "function" }];
				},
				async add(path, fn) {
					const segments = path.split(".");
					const last = segments.pop();
					let node = api;
					for (const segment of segments) node = node[segment] ??= {};
					node[last] = fn;
					return "vine-fake";
				},
				async remove() {}
			},
			caller: () => null,
			context: {
				async scope(options) {
					api.scopes.push({ context: options.context, protect: options.protect });
					log.push("scope:enter");
					if (behaviour.scope) return behaviour.scope(options);
					const value = await options.fn();
					log.push("scope:exit");
					return value;
				},
				async run(context, fn) {
					api.runs.push(context);
					log.push("run");
					if (behaviour.run) return behaviour.run(context, fn);
					return fn();
				}
			},
			event: {
				resolveLevel(subscriberPath, event) {
					api.resolves.push([subscriberPath, event]);
					const key = `${subscriberPath === null ? "null" : subscriberPath}|${event}`;
					if (typeof behaviour.levels === "function") return behaviour.levels(subscriberPath, event);
					return behaviour.levels?.[key] ?? "deny";
				},
				on(event, listener) {
					if (!listeners.has(event)) listeners.set(event, new Set());
					listeners.get(event).add(listener);
					return {
						off: () => {
							// `stickyOff` models an instance whose off() leaves the listener registered.
							if (!behaviour.stickyOff) listeners.get(event).delete(listener);
						}
					};
				}
			},
			permissions: {
				control: { enabled: behaviour.enabled ?? true },
				global: {
					checkCall(caller, target, args) {
						api.gates.push({ caller, target, args });
						log.push(`gate:${caller}->${target}`);
						return behaviour.checkCall ? behaviour.checkCall(caller, target, args) : true;
					}
				}
			}
		}
	};
	api.math = {
		add(a, b) {
			log.push("leaf");
			return a + b;
		}
	};
	if (behaviour.noCheckCall) delete api.slothlet.permissions.global.checkCall;
	if (behaviour.noPermissions) delete api.slothlet.permissions;
	if (behaviour.noResolveLevel) delete api.slothlet.event.resolveLevel;
	if (behaviour.noScope) delete api.slothlet.context.scope;
	if (behaviour.noRun) delete api.slothlet.context.run;
	return api;
}

/**
 * Serve a fake api with a principal and hand back the frame controls.
 * @param {object} [apiBehaviour] - `fakeApi` behaviour.
 * @param {object} [options] - `serve()` options (defaults to `{ principal: "remote.renderer" }`).
 * @returns {Promise<{api: object, channel: object, serving: object}>} The serving fake.
 */
async function served(apiBehaviour, options = { principal: "remote.renderer" }) {
	const api = fakeApi(apiBehaviour);
	const channel = fakeChannel();
	const serving = await serve(api, channel, options);
	// Forget the setup probe (an empty `scope`) so every recording below is the frames' own doing.
	api.log.length = 0;
	api.scopes.length = 0;
	api.runs.length = 0;
	return { api, channel, serving };
}

/**
 * Deliver one call frame and return the terminal frame it produced.
 * @param {object} channel - The fake channel.
 * @param {string} path - Leaf path.
 * @param {unknown[]} [args] - Arguments.
 * @returns {Promise<object>} The `result` / `error` frame.
 */
async function call(channel, path, args = [1, 2]) {
	const before = channel.sent.length;
	channel.deliver({ type: "call", callId: "c1", path, args });
	await tick();
	return channel.sent.slice(before).find((frame) => frame.type === "result" || frame.type === "error");
}

/**
 * Deliver one sub frame and return its ack.
 * @param {object} channel - The fake channel.
 * @param {string} subId - Subscription id.
 * @param {string} event - Event name.
 * @param {string|null} subscriberPath - Asserted identity.
 * @returns {Promise<object|undefined>} The `sub-ack` frame, if one was sent.
 */
async function sub(channel, subId, event, subscriberPath) {
	channel.deliver({ type: "sub", subId, event, subscriberPath });
	await tick();
	return channel.ofType("sub-ack").find((frame) => frame.subId === subId);
}

/**
 * Let queued microtasks and one macrotask run.
 * @returns {Promise<void>} Resolves on the next macrotask.
 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("principal — normalization and the serving.principal diagnostic", () => {
	it("a string principal is { path }, frozen, and exposed on serving.principal", async () => {
		const { serving } = await served();
		expect(serving.principal).toEqual({ path: "remote.renderer" });
		expect(Object.isFrozen(serving.principal)).toBe(true);
	});

	it("an object principal keeps its context by reference, frozen at the top level", async () => {
		const context = { actor: { id: "u42" } };
		const { serving } = await served(undefined, { principal: { path: "remote.renderer", context } });
		expect(serving.principal).toEqual({ path: "remote.renderer", context });
		expect(serving.principal.context).toBe(context);
		expect(Object.isFrozen(serving.principal)).toBe(true);
	});

	it("a function principal is exposed as the resolver itself and is evaluated PER FRAME", async () => {
		const identities = ["remote.first", { path: "remote.second" }];
		const resolver = () => identities.shift();
		const { api, channel, serving } = await served(undefined, { principal: resolver });
		expect(serving.principal).toBe(resolver);
		await call(channel, "math.add");
		await call(channel, "math.add");
		expect(api.gates.map((g) => g.caller)).toEqual(["remote.first", "remote.second"]);
	});

	it("no principal → serving.principal is null", async () => {
		const { serving } = await served(undefined, {});
		expect(serving.principal).toBeNull();
	});

	it.each([
		["a glob path", "remote.**"],
		["an empty path", ""],
		["the reserved slothlet root", "slothlet.remote"],
		["a prototype-walking segment", "__proto__.x"],
		["a non-string path", { path: 42 }],
		["a missing path", { context: {} }]
	])("rejects %s with a TypeError at serve()", async (_label, principal) => {
		await expect(serve(fakeApi(), fakeChannel(), { principal })).rejects.toThrow(TypeError);
	});

	it.each([
		["an array", []],
		["a class instance", new (class Actor {})()],
		["a string", "actor"],
		["null", null]
	])("rejects a context that is %s with a TypeError", async (_label, context) => {
		await expect(serve(fakeApi(), fakeChannel(), { principal: { path: "remote.r", context } })).rejects.toThrow(
			/context must be a plain object/
		);
	});

	it.each([[42], [true], [["remote.r"]]])("rejects a principal option of %p with a TypeError", async (principal) => {
		await expect(serve(fakeApi(), fakeChannel(), { principal })).rejects.toThrow(TypeError);
	});

	it("normalizePrincipal accepts a null-prototype object and keeps only path/context", () => {
		const raw = Object.create(null);
		raw.path = "remote.r";
		raw.extra = "dropped";
		expect(normalizePrincipal(raw, "test")).toEqual({ path: "remote.r" });
	});

	it("bindPrincipal: a resolver that throws or answers junk resolves to null instead of throwing", () => {
		expect(
			bindPrincipal(() => {
				throw new Error("re-auth pending");
			}, "test").resolve()
		).toBeNull();
		expect(bindPrincipal(() => 42, "test").resolve()).toBeNull();
		expect(bindPrincipal(() => "remote.ok", "test").resolve()).toEqual({ path: "remote.ok" });
		expect(bindPrincipal(undefined, "test")).toBeNull();
	});
});

describe("principal — fail-closed setup preconditions", () => {
	it("throws when the permission system is not enforcing (control.enabled !== true)", async () => {
		await expect(serve(fakeApi({ enabled: false }), fakeChannel(), { principal: "remote.r" })).rejects.toThrow(/permission system enabled/);
	});

	it("throws when api.slothlet.permissions is absent altogether", async () => {
		await expect(serve(fakeApi({ noPermissions: true }), fakeChannel(), { principal: "remote.r" })).rejects.toThrow(
			/permission system enabled/
		);
	});

	it("throws when event.resolveLevel is missing", async () => {
		await expect(serve(fakeApi({ noResolveLevel: true }), fakeChannel(), { principal: "remote.r" })).rejects.toThrow(/resolveLevel/);
	});

	it("throws when permissions.global.checkCall is missing, naming the slothlet change it needs", async () => {
		await expect(serve(fakeApi({ noCheckCall: true }), fakeChannel(), { principal: "remote.r" })).rejects.toThrow(
			/checkCall.*CLDMV\/slothlet#508/
		);
	});

	it("throws when context.scope is missing", async () => {
		await expect(serve(fakeApi({ noScope: true }), fakeChannel(), { principal: "remote.r" })).rejects.toThrow(
			/context\.scope\(\).*unavailable/
		);
	});

	it("throws when context.scope exists but rejects (a `scope: false` instance)", async () => {
		const api = fakeApi({
			scope: async () => {
				throw new Error("[SCOPE_DISABLED] Per-request context isolation is disabled.");
			}
		});
		await expect(serve(api, fakeChannel(), { principal: "remote.r" })).rejects.toThrow(/context\.scope\(\).*SCOPE_DISABLED/);
	});

	it("reports a probe that throws a non-Error value verbatim", async () => {
		const api = fakeApi({
			scope: async () => {
				throw "a bare string, not an Error";
			}
		});
		await expect(serve(api, fakeChannel(), { principal: "remote.r" })).rejects.toThrow(/a bare string, not an Error/);
	});

	it("throws when context.scope answers without running fn", async () => {
		const api = fakeApi({ scope: async () => undefined });
		await expect(serve(api, fakeChannel(), { principal: "remote.r" })).rejects.toThrow(/context\.scope\(\)/);
	});

	it("publishes NOTHING when a precondition fails — the surface frame is never sent", async () => {
		const channel = fakeChannel();
		await expect(serve(fakeApi({ noCheckCall: true }), channel, { principal: "remote.r" })).rejects.toThrow(TypeError);
		expect(channel.sent).toEqual([]);
	});

	it("does not touch the preconditions at all without a principal", async () => {
		const api = fakeApi({ noPermissions: true, noCheckCall: true, noScope: true, noRun: true });
		await expect(serve(api, fakeChannel())).resolves.toBeTruthy();
	});

	describe("grow({ principal }) — only the event-side preconditions", () => {
		it("does NOT require checkCall (a grow answers no calls)", async () => {
			const link = await grow(fakeApi({ noCheckCall: true, noScope: true }), fakeChannel({ syncSurface: true }), {
				principal: "remote.plugin"
			});
			await link.close();
		});

		it("requires the permission system to be enforcing", async () => {
			await expect(grow(fakeApi({ enabled: false }), fakeChannel({ syncSurface: true }), { principal: "remote.plugin" })).rejects.toThrow(
				/permission system enabled/
			);
		});

		it("requires event.resolveLevel", async () => {
			await expect(
				grow(fakeApi({ noResolveLevel: true }), fakeChannel({ syncSurface: true }), { principal: "remote.plugin" })
			).rejects.toThrow(/resolveLevel/);
		});

		it("requires a working context.run ONLY when the static principal carries a context", async () => {
			const withContext = { path: "remote.plugin", context: { actor: { id: "p" } } };
			await expect(grow(fakeApi({ noRun: true }), fakeChannel({ syncSurface: true }), { principal: withContext })).rejects.toThrow(
				/context\.run\(\).*unavailable/
			);
			const rejecting = fakeApi({
				run: async () => {
					throw new Error("[SCOPE_DISABLED] no");
				}
			});
			await expect(grow(rejecting, fakeChannel({ syncSurface: true }), { principal: withContext })).rejects.toThrow(
				/context\.run\(\).*SCOPE_DISABLED/
			);
			// No context → run is not probed; a resolver → not probed either (its answer is per frame).
			await (await grow(fakeApi({ noRun: true }), fakeChannel({ syncSurface: true }), { principal: "remote.plugin" })).close();
			await (await grow(fakeApi({ noRun: true }), fakeChannel({ syncSurface: true }), { principal: () => withContext })).close();
		});

		it("validates the principal shape exactly like serve()", async () => {
			await expect(grow(fakeApi(), fakeChannel({ syncSurface: true }), { principal: "remote.**" })).rejects.toThrow(/safe dotted path/);
		});
	});
});

describe("principal — the call gate, fail-closed on every path", () => {
	it("a gate that answers true runs the leaf and returns its value", async () => {
		const { api, channel } = await served();
		expect(await call(channel, "math.add")).toEqual({ type: "result", callId: "c1", value: 3 });
		expect(api.gates).toEqual([{ caller: "remote.renderer", target: "math.add", args: [1, 2] }]);
	});

	it("a gate that answers false → VINE_DENIED, and the leaf never runs", async () => {
		const { api, channel } = await served({ checkCall: () => false });
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
		expect(api.log).not.toContain("leaf");
	});

	it.each([
		["a non-boolean truthy answer", () => "yes"],
		["a resolved non-boolean", async () => 1],
		["a resolved false", async () => false],
		["undefined", () => undefined]
	])("a gate answering %s → VINE_DENIED", async (_label, checkCall) => {
		const { api, channel } = await served({ checkCall });
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
		expect(api.log).not.toContain("leaf");
	});

	it("a gate that throws or rejects → VINE_DENIED", async () => {
		const throwing = await served({
			checkCall: () => {
				throw new Error("engine exploded");
			}
		});
		expect((await call(throwing.channel, "math.add")).error.code).toBe(CODES.DENIED);
		const rejecting = await served({ checkCall: async () => Promise.reject(new Error("later")) });
		expect((await call(rejecting.channel, "math.add")).error.code).toBe(CODES.DENIED);
	});

	it("a gate that vanished after setup → VINE_DENIED (never a pass)", async () => {
		const { api, channel } = await served();
		delete api.slothlet.permissions.global.checkCall;
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
	});

	it("gate(): the seam itself fails closed for a missing global surface", async () => {
		expect(await gate({ slothlet: {} }, { path: "remote.r" }, "math.add", [])).toBe(false);
		expect(await gate({}, { path: "remote.r" }, "math.add", [])).toBe(false);
	});

	it("a resolver that throws → VINE_DENIED for that frame; a later good answer is judged normally", async () => {
		let fail = true;
		const { api, channel } = await served(undefined, {
			principal: () => {
				if (fail) throw new Error("re-auth in progress");
				return "remote.renderer";
			}
		});
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
		expect(api.gates).toEqual([]);
		fail = false;
		expect((await call(channel, "math.add")).type).toBe("result");
	});

	it.each([[42], [null], [{ path: "not safe" }], [{ path: "remote.r", context: [] }]])(
		"a resolver answering %p → VINE_DENIED and the gate is never asked",
		async (answer) => {
			const { api, channel } = await served(undefined, { principal: () => answer });
			expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
			expect(api.gates).toEqual([]);
			expect(api.scopes).toEqual([]);
		}
	);

	it("a scope that rejects → VINE_DENIED, and the leaf never runs outside a scope", async () => {
		let probed = false;
		const { api, channel } = await served({
			scope: async ({ fn }) => {
				// The setup probe must pass; the CALL's scope is the one that fails.
				if (!probed) {
					probed = true;
					return fn();
				}
				throw new Error("[CONTEXT_KEY_OWNED] actor is owned");
			}
		});
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
		expect(api.log).not.toContain("leaf");
	});

	it("a scope that resolves WITHOUT running fn → VINE_DENIED (no verdict is a denial)", async () => {
		let calls = 0;
		const api = fakeApi({ scope: async ({ fn }) => (calls++ === 0 ? fn() : undefined) }); // the setup probe runs fn; the call does not
		const channel = fakeChannel();
		await serve(api, channel, { principal: "remote.renderer" });
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
		expect(api.log).not.toContain("leaf");
	});
});

describe("principal — pipeline order and the context scope", () => {
	it("NO_LEAF beats DENIED: an unserved path is refused before the gate is ever asked", async () => {
		const { api, channel } = await served({ checkCall: () => false });
		expect((await call(channel, "secrets.dump")).error.code).toBe(CODES.NO_LEAF);
		expect(api.gates).toEqual([]);
		expect(api.scopes).toEqual([]);
	});

	it("DENIED beats DATA_ONLY: a function in the args of a denied call answers DENIED", async () => {
		const { channel } = await served({ checkCall: () => false });
		expect((await call(channel, "math.add", [{ cb() {} }])).error.code).toBe(CODES.DENIED);
	});

	it("an allowed call still gets the args data-only check, then the return-value check", async () => {
		const { api, channel } = await served();
		expect((await call(channel, "math.add", [() => {}])).error.code).toBe(CODES.DATA_ONLY);
		api.math.add = () => () => {};
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DATA_ONLY);
	});

	it("gate and leaf both run INSIDE the principal's scope, gate first", async () => {
		const { api, channel } = await served();
		await call(channel, "math.add");
		// The setup probe is the first scope; the call's is the second.
		expect(api.log).toEqual(["scope:enter", "gate:remote.renderer->math.add", "leaf", "scope:exit"]);
	});

	it("the scope carries principal.context with every top-level key protected", async () => {
		const context = { actor: { id: "u42" }, tenant: "t1" };
		const { api, channel } = await served(undefined, { principal: { path: "remote.renderer", context } });
		await call(channel, "math.add");
		expect(api.scopes.at(-1)).toEqual({ context, protect: ["actor", "tenant"] });
	});

	it("a principal without a context still runs inside an (empty, unprotected) scope", async () => {
		const { api, channel } = await served();
		await call(channel, "math.add");
		expect(api.scopes.at(-1)).toEqual({ context: {}, protect: [] });
	});
});

describe("principal — the VINE_DENIED wire shape", () => {
	it("names the path, never the principal, and carries no details on the wire", async () => {
		const { channel } = await served(
			{ checkCall: () => false },
			{ principal: { path: "remote.renderer", context: { actor: { id: "u42" } } } }
		);
		const frame = await call(channel, "math.add");
		expect(frame.type).toBe("error");
		expect(frame.error.code).toBe("VINE_DENIED");
		expect(frame.error.name).toBe("VineError");
		expect(frame.error.message).toBe("slothlet-vine: 'math.add' is not permitted for this channel");
		expect(frame.error.message).not.toContain("remote.renderer");
		expect(frame.error).not.toHaveProperty("principal");
		expect(frame.error).not.toHaveProperty("path");
		expect(Object.keys(frame.error).every((key) => ["name", "message", "code", "stack"].includes(key))).toBe(true);
	});

	it("arrives grow-side as a VineRemoteError with .code VINE_REMOTE and .remoteCode VINE_DENIED", async () => {
		const [near, far] = createPair();
		const serveApi = fakeApi({ checkCall: () => false });
		await serve(serveApi, far, { principal: "remote.renderer" });
		const growApi = fakeApi();
		delete growApi.math; // the fake pre-populates a local math.add; the grow must MOUNT the far one
		const link = await grow(growApi, near, { budgetMs: 1000 });
		await expect(growApi.math.add(1, 2)).rejects.toMatchObject({ code: CODES.REMOTE, remoteCode: CODES.DENIED, name: "VineError" });
		await link.close();
	});
});

describe("principal — the event server-half narrows, never widens", () => {
	/** Levels the fake instance answers, keyed `subscriberPath|event`. */
	const LEVELS = {
		"remote.renderer|jobs.done": "allow",
		"remote.renderer|billing.paid": "deny",
		"remote.renderer.audit|jobs.done": "notify",
		"remote.renderer|jobs.trace": "notify",
		"remote.renderer.audit|jobs.trace": "allow",
		"remote.admin|jobs.done": "allow",
		"remote.admin|billing.paid": "allow",
		"null|billing.paid": "allow"
	};

	it("null (a far host subscription) resolves as the CHANNEL, not as the host", async () => {
		const { api, channel } = await served({ levels: LEVELS });
		expect((await sub(channel, "s1", "billing.paid", null)).level).toBe("deny");
		expect((await sub(channel, "s2", "jobs.done", null)).level).toBe("allow");
		expect(api.resolves).toEqual([
			["remote.renderer", "billing.paid"],
			["remote.renderer", "jobs.done"]
		]);
	});

	it("a forged claim outside the principal's prefix is ignored — the channel's level is used", async () => {
		const { api, channel } = await served({ levels: LEVELS });
		expect((await sub(channel, "s1", "billing.paid", "remote.admin")).level).toBe("deny");
		expect((await sub(channel, "s2", "jobs.done", "renderer.dashboard")).level).toBe("allow");
		expect(api.resolves.some(([who]) => who === "remote.admin" || who === "renderer.dashboard")).toBe(false);
	});

	it("a hint under the principal narrows: min(channel allow, hint notify) = notify, and the payload never crosses", async () => {
		const { api, channel } = await served({ levels: LEVELS });
		expect((await sub(channel, "s1", "jobs.done", "remote.renderer.audit")).level).toBe("notify");
		api.emit("jobs.done", { secret: 1 });
		await tick();
		const [delivered] = channel.ofType("event");
		expect(delivered).toEqual({ type: "event", subId: "s1", event: "jobs.done", at: 1, instanceID: "fake" });
		expect(delivered).not.toHaveProperty("payload");
	});

	it("a hint under the principal cannot widen: min(channel notify, hint allow) = notify", async () => {
		const { channel } = await served({ levels: LEVELS });
		expect((await sub(channel, "s1", "jobs.trace", "remote.renderer.audit")).level).toBe("notify");
	});

	it("the hint must be at or UNDER the path — a same-prefix sibling (`remote.rendererX`) is not a hint", async () => {
		const { api, channel } = await served({ levels: { ...LEVELS, "remote.rendererX|jobs.done": "deny" } });
		expect((await sub(channel, "s1", "jobs.done", "remote.rendererX")).level).toBe("allow");
		expect(api.resolves).toEqual([["remote.renderer", "jobs.done"]]);
	});

	it("resolves inside context.run(principal.context) when a context is bound — at subscribe AND per emit", async () => {
		const context = { actor: { id: "u42" } };
		const { api, channel } = await served({ levels: LEVELS }, { principal: { path: "remote.renderer", context } });
		await sub(channel, "s1", "jobs.done", null);
		expect(api.runs).toEqual([context]);
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(api.runs).toEqual([context, context]);
		expect(channel.ofType("event")[0].payload).toEqual({ n: 1 });
	});

	it("re-resolves per emit: a downgrade after subscribe cuts the payload, a revoke forwards nothing", async () => {
		const levels = { ...LEVELS };
		const { api, channel } = await served({ levels });
		expect((await sub(channel, "s1", "jobs.done", null)).level).toBe("allow");
		levels["remote.renderer|jobs.done"] = "notify";
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")).toHaveLength(1);
		expect(channel.ofType("event")[0]).not.toHaveProperty("payload");
		levels["remote.renderer|jobs.done"] = "deny";
		api.emit("jobs.done", { n: 2 });
		await tick();
		expect(channel.ofType("event")).toHaveLength(1);
	});

	it.each([
		[
			"the resolver throws",
			() => {
				throw new Error("no identity");
			}
		],
		["the resolver answers junk", () => ({ path: "" })]
	])("acks deny when %s", async (_label, principal) => {
		const { api, channel } = await served({ levels: LEVELS }, { principal });
		expect((await sub(channel, "s1", "jobs.done", null)).level).toBe("deny");
		expect(api.resolves).toEqual([]);
	});

	it("acks deny when context.run rejects, when resolveLevel throws, and when it answers junk", async () => {
		const rejecting = await served(
			{
				levels: LEVELS,
				run: async () => {
					throw new Error("[SCOPE_DISABLED]");
				}
			},
			{ principal: { path: "remote.renderer", context: { a: 1 } } }
		);
		expect((await sub(rejecting.channel, "s1", "jobs.done", null)).level).toBe("deny");
		const throwing = await served({
			levels: () => {
				throw new Error("engine down");
			}
		});
		expect((await sub(throwing.channel, "s1", "jobs.done", null)).level).toBe("deny");
		const junk = await served({ levels: () => "maybe" });
		expect((await sub(junk.channel, "s1", "jobs.done", null)).level).toBe("deny");
	});

	it("a resolver that starts answering junk mid-stream stops deliveries at the next emit", async () => {
		let identity = "remote.renderer";
		const { api, channel } = await served({ levels: LEVELS }, { principal: () => identity });
		expect((await sub(channel, "s1", "jobs.done", null)).level).toBe("allow");
		identity = 42;
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")).toHaveLength(0);
	});

	it("a repeated subId while the first is still resolving registers ONE listener and ONE ack", async () => {
		const { api, channel } = await served({ levels: LEVELS });
		channel.deliver({ type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null });
		channel.deliver({ type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null });
		await tick();
		expect(channel.ofType("sub-ack")).toHaveLength(1);
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")).toHaveLength(1);
	});

	it("a close() that lands while a level is still resolving registers nothing and acks nothing", async () => {
		const { api, channel, serving } = await served({ levels: LEVELS });
		channel.deliver({ type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null });
		serving.close();
		await tick();
		expect(channel.ofType("sub-ack")).toHaveLength(0);
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")).toHaveLength(0);
	});

	it("an unsub that lands while the subscribe-time level is still resolving registers nothing", async () => {
		const { api, channel } = await served({ levels: LEVELS });
		channel.deliver({ type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null });
		channel.deliver({ type: "unsub", subId: "s1" });
		await tick();
		expect(channel.ofType("sub-ack")).toHaveLength(0);
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")).toHaveLength(0);
	});

	it("an unsub that lands while a per-emit level is still resolving drops that delivery", async () => {
		const { api, channel } = await served({ levels: LEVELS });
		await sub(channel, "s1", "jobs.done", null);
		api.emit("jobs.done", { n: 1 });
		channel.deliver({ type: "unsub", subId: "s1" });
		await tick();
		expect(channel.ofType("event")).toHaveLength(0);
	});

	it("narrowest() and isNarrowingHint() — the two helpers, directly", () => {
		expect(narrowest("allow", "notify")).toBe("notify");
		expect(narrowest("notify", "allow")).toBe("notify");
		expect(narrowest("allow", "allow")).toBe("allow");
		expect(narrowest("deny", "allow")).toBe("deny");
		expect(narrowest("allow", "bogus")).toBe("deny");
		expect(narrowest("bogus", "allow")).toBe("deny");
		expect(isNarrowingHint("remote.r", "remote.r")).toBe(true);
		expect(isNarrowingHint("remote.r.audit", "remote.r")).toBe(true);
		expect(isNarrowingHint("remote.rX", "remote.r")).toBe(false);
		expect(isNarrowingHint(null, "remote.r")).toBe(false);
	});
});

describe("grow({ principal }) — the event server-half on the grow end", () => {
	it("resolves a far host subscription (null) as the grow end's principal", async () => {
		const api = fakeApi({ levels: { "remote.plugin|jobs.done": "notify", "null|jobs.done": "allow" } });
		const channel = fakeChannel({ syncSurface: true });
		const link = await grow(api, channel, { principal: "remote.plugin" });
		expect((await sub(channel, "s1", "jobs.done", null)).level).toBe("notify");
		expect(api.resolves).toEqual([["remote.plugin", "jobs.done"]]);
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")[0]).not.toHaveProperty("payload");
		await link.close();
	});

	it("runs the resolution inside context.run(principal.context)", async () => {
		const context = { actor: { id: "plugin-1" } };
		const api = fakeApi({ levels: { "remote.plugin|jobs.done": "allow" } });
		const channel = fakeChannel({ syncSurface: true });
		const link = await grow(api, channel, { principal: { path: "remote.plugin", context } });
		expect((await sub(channel, "s1", "jobs.done", "remote.other")).level).toBe("allow");
		expect(api.runs.at(-1)).toBe(context);
		await link.close();
	});

	it("a stray call frame is still ignored on a principal-bound grow end", async () => {
		const api = fakeApi();
		const channel = fakeChannel({ syncSurface: true });
		const link = await grow(api, channel, { principal: "remote.plugin" });
		channel.deliver({ type: "call", callId: "stray", path: "math.add", args: [] });
		await tick();
		expect(channel.ofType("result")).toEqual([]);
		expect(channel.ofType("error")).toEqual([]);
		expect(api.gates).toEqual([]);
		await link.close();
	});
});

describe("no principal — the v1 trusted-transport behaviour is pinned, byte for byte", () => {
	it("a raw call frame executes with host standing: no gate, no scope, a plain result", async () => {
		const { api, channel } = await served(undefined, {});
		expect(await call(channel, "math.add")).toEqual({ type: "result", callId: "c1", value: 3 });
		expect(api.gates).toEqual([]);
		expect(api.scopes).toEqual([]);
		expect(api.log).toEqual(["leaf"]);
	});

	it("a far host subscription (null) is resolved AS the host and never through a run()", async () => {
		const { api, channel } = await served({ levels: { "null|jobs.done": "allow" } }, {});
		expect((await sub(channel, "s1", "jobs.done", null)).level).toBe("allow");
		expect(api.resolves).toEqual([[null, "jobs.done"]]);
		expect(api.runs).toEqual([]);
		api.emit("jobs.done", { n: 1 });
		await tick();
		expect(channel.ofType("event")[0].payload).toEqual({ n: 1 });
	});

	it("a far module's asserted identity is resolved as-is (least privilege between well-behaved peers)", async () => {
		const { api, channel } = await served({ levels: { "renderer.dashboard|jobs.done": "notify" } }, {});
		expect((await sub(channel, "s1", "jobs.done", "renderer.dashboard")).level).toBe("notify");
		expect(api.resolves).toEqual([["renderer.dashboard", "jobs.done"]]);
	});

	it("acks deny when the instance's resolveLevel throws, or answers something that is not a level", async () => {
		const throwing = await served(
			{
				levels: () => {
					throw new Error("engine down");
				}
			},
			{}
		);
		expect((await sub(throwing.channel, "s1", "jobs.done", null)).level).toBe("deny");
		const junk = await served({ levels: () => "maybe" }, {});
		expect((await sub(junk.channel, "s1", "jobs.done", null)).level).toBe("deny");
	});

	it("a listener the instance failed to detach forwards nothing once the subscription is dropped", async () => {
		const { api, channel } = await served({ levels: { "null|jobs.done": "allow" }, stickyOff: true }, {});
		await sub(channel, "s1", "jobs.done", null);
		channel.deliver({ type: "unsub", subId: "s1" });
		api.emit("jobs.done", { n: 1 }); // the fake's off() left the listener registered
		await tick();
		expect(channel.ofType("event")).toHaveLength(0);
	});

	it("no VINE_DENIED is ever produced without a principal — even with a gate that would refuse", async () => {
		const { channel } = await served({ checkCall: () => false }, {});
		expect((await call(channel, "math.add")).type).toBe("result");
	});
});
