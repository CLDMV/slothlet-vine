/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-loopback-context.test.vitest.mjs
 *	@Date: 2026-10-06T12:00:00-07:00 (1791313200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-06T12:00:00-07:00 (1791313200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

// Per-call requested context (#79): `link.with()` / `grow({ context })` on the grow side, the
// `serve({ context })` host check on the serve side, the protected merge into the call's context
// scope, and old/new interop — against REAL slothlet instances, over loopback and websocket.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError } from "../src/lib/errors.mjs";
import { createPair } from "../src/transport/loopback.mjs";
import { createChannel as createWsChannel } from "../src/transport/websocket.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = path.join(here, "fixtures", "context-api");
const CONTEXT_GROW_DIR = path.join(here, "fixtures", "context-grow-api");

/** Teardown callbacks, run in reverse after each test. @type {Array<() => Promise<void>|void>} */
let teardown = [];
/** Every ws server stood up, closed in afterAll as a backstop. @type {Set<import("ws").WebSocketServer>} */
const servers = new Set();

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try {
			await fn();
		} catch {
			// Teardown must never mask the assertion that already failed.
		}
	}
	teardown = [];
});

afterAll(async () => {
	for (const wss of servers) await new Promise((resolve) => wss.close(() => resolve()));
	servers.clear();
});

/**
 * Create a real instance and register its shutdown.
 * @param {object} options - `slothlet()` options.
 * @returns {Promise<object>} The instance.
 */
async function instance(options) {
	const api = await slothlet({ silent: true, ...options });
	teardown.push(async () => api.slothlet?.shutdown?.());
	return api;
}

/**
 * A served context-api instance and a grown one over loopback.
 * @param {object} [serveOptions] - `serve()` options.
 * @param {object} [growOptions] - `grow()` options.
 * @param {object} [serveInstance] - Extra `slothlet()` options for the serving instance.
 * @returns {Promise<{ serveApi: object, growApi: object, serving: object, link: object }>} The pair.
 */
async function linked(serveOptions = {}, growOptions = {}, serveInstance = {}) {
	const serveApi = await instance({ base: CONTEXT_DIR, ...serveInstance });
	const growApi = await instance({ base: CONTEXT_GROW_DIR });
	const [near, far] = createPair();
	const serving = await serve(serveApi, far, serveOptions);
	const link = await grow(growApi, near, { budgetMs: 2000, ...growOptions });
	teardown.push(async () => {
		await link.close();
		serving.close();
	});
	return { serveApi, growApi, serving, link };
}

/**
 * A RAW peer on one channel end: records every frame and sends hand-built ones — an old (pre-#79)
 * implementation, or a page script with a socket.
 * @param {object} channel - The channel end to drive.
 * @returns {object} The peer controls.
 */
function rawPeer(channel) {
	const frames = [];
	channel.onMessage((frame) => frames.push(frame));
	/**
	 * @param {(frame: object) => boolean} predicate - Frame to wait for.
	 * @returns {Promise<object>} The first matching frame.
	 */
	async function waitFor(predicate) {
		const deadline = Date.now() + 3000;
		for (;;) {
			const hit = frames.find(predicate);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	let seq = 0;
	return {
		frames,
		waitFor,
		surface: () => waitFor((frame) => frame.type === "surface"),
		/**
		 * @param {string} leaf - Leaf path.
		 * @param {unknown[]} [args] - Arguments.
		 * @param {object} [extra] - Extra frame keys (e.g. `{ context }`).
		 * @returns {Promise<object>} The terminal frame.
		 */
		call(leaf, args = [], extra = {}) {
			const callId = `raw#${++seq}`;
			channel.send({ type: "call", callId, path: leaf, args, ...extra });
			return waitFor((frame) => (frame.type === "result" || frame.type === "error") && frame.callId === callId);
		},
		send: (frame) => channel.send(frame)
	};
}

/**
 * The remote code a far-side refusal carries, asserting it crossed as a `VineRemoteError`.
 * @param {Promise<unknown>} promise - The call.
 * @returns {Promise<string|undefined>} `.remoteCode`.
 */
async function remoteCode(promise) {
	const err = await promise.then(
		() => null,
		(e) => e
	);
	expect(err).toBeInstanceOf(VineRemoteError);
	expect(err.code).toBe(CODES.REMOTE);
	return err.remoteCode;
}

const acceptAll = (requested) => requested;

describe("requested context — accept, narrow, refuse (loopback, no principal)", () => {
	it("accept: the leaf sees the requested keys; the surface advertised it; link.context is true", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		expect(link.context).toBe(true);
		expect(await link.with({ project: "A" }, () => growApi.work.read())).toEqual({ project: "A", actor: null, extra: null });
		// Outside the extent, nothing is attached.
		expect(await growApi.work.read()).toEqual({ project: null, actor: null, extra: null });
	});

	it("the extent crosses a grow-side module boundary and an async hop; `with` forwards args and returns fn's value", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		expect(await link.with({ project: "B" }, () => growApi.relay.read())).toMatchObject({ project: "B" });
		expect(await link.with({ project: "C" }, (a, b) => a + b, 2, 3)).toBe(5);
	});

	it("narrow: the check answers a subset — the dropped key never reaches the scope", async () => {
		const seen = [];
		const { growApi, link } = await linked({
			context: (requested, call) => {
				seen.push({ requested, call });
				return { project: requested.project };
			}
		});
		const got = await link.with({ project: "A", extra: { depth: 1 } }, () => growApi.work.read());
		expect(got).toEqual({ project: "A", actor: null, extra: null });
		expect(seen).toEqual([{ requested: { project: "A", extra: { depth: 1 } }, call: { principal: null, path: "work.read", args: [] } }]);
	});

	it("narrow: the check may also CHANGE a value (e.g. canonicalize it)", async () => {
		const { growApi, link } = await linked({ context: (requested) => ({ project: String(requested.project).toUpperCase() }) });
		expect(await link.with({ project: "a" }, () => growApi.work.read())).toMatchObject({ project: "A" });
	});

	it("refuse: false, null, a throw, a rejection, or junk are all VINE_CONTEXT — and the leaf never runs", async () => {
		const answers = [
			() => false,
			() => null,
			() => undefined,
			() => true,
			() => {
				throw new Error("no such project");
			},
			async () => {
				throw new Error("async no");
			},
			() => ["project"],
			() => ({ project: "A", cb: () => {} }),
			() => new (class Ctx {})()
		];
		for (const answer of answers) {
			const { serveApi, growApi, link } = await linked({ context: answer });
			expect(await remoteCode(link.with({ project: "A" }, () => growApi.work.read()))).toBe(CODES.CONTEXT);
			expect(await serveApi.work.count()).toBe(0);
		}
	});

	it("the refusal names the path only; the host's own error never crosses", async () => {
		const { growApi, link } = await linked({
			context: () => {
				throw new Error("secret detail");
			}
		});
		const err = await link.with({ project: "A" }, () => growApi.work.read()).catch((e) => e);
		expect(err.message).toMatch(/requested context for 'work\.read' is not accepted/);
		expect(err.message).not.toMatch(/secret detail/);
	});

	it("an async check is awaited", async () => {
		const { growApi, link } = await linked({
			context: async (requested) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return requested;
			}
		});
		expect(await link.with({ project: "A" }, () => growApi.work.read())).toMatchObject({ project: "A" });
	});

	it("the check sees a private copy — mutating it changes nothing that was asked", async () => {
		const { growApi, link } = await linked({
			context: (requested) => {
				const answer = { project: requested.project };
				requested.project = "mutated";
				return answer;
			}
		});
		expect(await link.with({ project: "A" }, () => growApi.work.read())).toMatchObject({ project: "A" });
	});
});

describe("requested context — protection of the accepted keys", () => {
	it("a leaf cannot reassign an accepted key (CONTEXT_KEY_PROTECTED)", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		const err = await link.with({ project: "A" }, () => growApi.work.tamper()).catch((e) => e);
		expect(err).toBeInstanceOf(VineRemoteError);
		expect(err.remoteCode ?? err.code).toMatch(/CONTEXT_KEY_PROTECTED/);
	});

	it("nor a nested field of one", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		const err = await link.with({ extra: { depth: 1 } }, () => growApi.work.deep()).catch((e) => e);
		expect(err.remoteCode ?? err.code).toMatch(/CONTEXT_KEY_PROTECTED/);
	});

	it("the accepted context lives on the call: concurrent extents over ONE link carry their own", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		const [a, b] = await Promise.all([
			link.with({ project: "A" }, () => growApi.work.slow(30)),
			link.with({ project: "B" }, () => growApi.work.slow(5))
		]);
		expect([a, b]).toEqual(["A", "B"]);
	});
});

describe("requested context — merged with the channel principal", () => {
	const PERMISSIONS = {
		defaultPolicy: "deny",
		rules: [
			{ caller: "remote.renderer", target: "work.count", effect: "allow" },
			{ caller: "remote.renderer", target: "work.tamper", effect: "allow" },
			// The rule condition sees the accepted requested context.
			{ caller: "remote.renderer", target: "work.read", effect: "allow", condition: (ctx) => ctx?.project === "A" }
		]
	};
	const RENDERER = { path: "remote.renderer", context: { actor: { id: "u42" } } };

	it("the check runs after the principal is resolved and sees it; checkCall's condition sees the accepted key", async () => {
		const seen = [];
		const { serveApi, growApi, link } = await linked(
			{
				principal: RENDERER,
				context: (requested, { principal }) => {
					seen.push(principal.path);
					return requested;
				}
			},
			{},
			{ permissions: PERMISSIONS }
		);
		expect(await link.with({ project: "A" }, () => growApi.work.read())).toEqual({ project: "A", actor: { id: "u42" }, extra: null });
		expect(await remoteCode(link.with({ project: "B" }, () => growApi.work.read()))).toBe(CODES.DENIED);
		expect(seen).toEqual(["remote.renderer", "remote.renderer"]);
		expect(await serveApi.work.count()).toBe(1);
	});

	it("on one link: a refused context is VINE_CONTEXT, an accepted one the rules refuse is VINE_DENIED", async () => {
		const { growApi, link } = await linked(
			{ principal: RENDERER, context: (requested) => (requested.project === "X" ? false : requested) },
			{},
			{ permissions: PERMISSIONS }
		);
		expect(await remoteCode(link.with({ project: "X" }, () => growApi.work.read()))).toBe(CODES.CONTEXT);
		expect(await remoteCode(link.with({ project: "B" }, () => growApi.work.read()))).toBe(CODES.DENIED);
		expect(await link.with({ project: "A" }, () => growApi.work.read())).toMatchObject({ project: "A" });
	});

	it("a principal key always wins over a requested one of the same name", async () => {
		const { growApi, link } = await linked({ principal: RENDERER, context: acceptAll }, {}, { permissions: PERMISSIONS });
		const got = await link.with({ project: "A", actor: { id: "mallory" } }, () => growApi.work.read());
		expect(got.actor).toEqual({ id: "u42" });
	});

	it("a refused context is VINE_CONTEXT before the gate — the rules are never asked", async () => {
		// An explicit deny audits `permission:denied` whenever the gate is asked — so its absence proves
		// the gate never was. The control serve (accepting check) shows the audit does fire.
		const permissions = { defaultPolicy: "deny", rules: [{ caller: "remote.renderer", target: "work.read", effect: "deny" }] };
		const audited = async (check, code) => {
			const { serveApi, growApi, link } = await linked({ principal: RENDERER, context: check }, {}, { permissions });
			const audits = [];
			serveApi.slothlet.lifecycle.on("permission:denied", (payload) => audits.push(payload));
			expect(await remoteCode(link.with({ project: "A" }, () => growApi.work.read()))).toBe(code);
			await new Promise((resolve) => setTimeout(resolve, 20));
			return audits.filter((d) => d.caller === "remote.renderer" && d.target === "work.read");
		};
		expect(await audited(acceptAll, CODES.DENIED)).not.toEqual([]);
		expect(await audited(() => false, CODES.CONTEXT)).toEqual([]);
	});

	it("accepted keys are protected alongside the principal's", async () => {
		const { growApi, link } = await linked({ principal: RENDERER, context: acceptAll }, {}, { permissions: PERMISSIONS });
		const err = await link.with({ project: "A" }, () => growApi.work.tamper()).catch((e) => e);
		expect(err.remoteCode ?? err.code).toMatch(/CONTEXT_KEY_PROTECTED/);
	});

	it("a call without a requested context is unchanged — the check is not consulted", async () => {
		let asked = 0;
		const { growApi } = await linked(
			{
				principal: RENDERER,
				context: (requested) => {
					asked++;
					return requested;
				}
			},
			{},
			{ permissions: PERMISSIONS }
		);
		expect(await growApi.work.count()).toBe(0);
		expect(asked).toBe(0);
	});

	it("around receives the accepted context (a copy), runs inside the scope, and sees null without one", async () => {
		const seen = [];
		const { growApi, link } = await linked(
			{
				principal: RENDERER,
				context: (requested) => ({ project: requested.project }),
				around: ({ context, invoke }) => {
					seen.push(context);
					return invoke();
				}
			},
			{},
			{ permissions: PERMISSIONS }
		);
		await link.with({ project: "A", extra: 1 }, () => growApi.work.read());
		await growApi.work.count();
		expect(seen).toEqual([{ project: "A" }, null]);
	});
});

describe("requested context — no check configured", () => {
	it("the surface does not advertise it; the grow refuses LOCALLY and sends nothing", async () => {
		const serveApi = await instance({ base: CONTEXT_DIR });
		const growApi = await instance({ base: CONTEXT_GROW_DIR });
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		const sent = [];
		const send = near.send.bind(near);
		near.send = (frame) => {
			sent.push(frame);
			send(frame);
		};
		const link = await grow(growApi, near, { budgetMs: 2000 });
		teardown.push(async () => {
			await link.close();
			serving.close();
		});
		expect(link.context).toBe(false);
		const err = await link.with({ project: "A" }, () => growApi.work.read()).catch((e) => e);
		expect(err).toBeInstanceOf(VineError);
		expect(err).not.toBeInstanceOf(VineRemoteError);
		expect(err.code).toBe(CODES.CONTEXT);
		expect(sent.filter((frame) => frame.type === "call")).toEqual([]);
		// A call with no requested context works as ever.
		expect(await growApi.work.read()).toMatchObject({ project: null });
	});

	it("a hand-built frame carrying one is refused serve-side (VINE_CONTEXT) — never silently ignored", async () => {
		const serveApi = await instance({ base: CONTEXT_DIR });
		const [near, far] = createPair();
		const peer = rawPeer(near);
		const serving = await serve(serveApi, far);
		teardown.push(() => serving.close());
		const surface = await peer.surface();
		expect(surface).not.toHaveProperty("context");
		expect((await peer.call("work.read", [], { context: { project: "A" } })).error.code).toBe(CODES.CONTEXT);
		expect(await serveApi.work.count()).toBe(0);
		expect((await peer.call("work.read")).value).toEqual({ project: null, actor: null, extra: null });
	});
});

describe("requested context — data-only", () => {
	it("grow side: link.with() refuses a non-plain or function-bearing context before anything runs", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		let ran = 0;
		const fn = () => {
			ran++;
			return growApi.work.read();
		};
		for (const bad of [{ cb() {} }, { nested: [1, () => 2] }, [1], "A", 7, new Date(), new (class Ctx {})(), { s: Symbol("x") }]) {
			const err = await link.with(bad, fn).catch((e) => e);
			expect(err).toBeInstanceOf(VineError);
			expect(err.code).toBe(CODES.DATA_ONLY);
		}
		expect(ran).toBe(0);
		await expect(link.with({ project: "A" }, "not a function")).rejects.toThrow(TypeError);
	});

	it("grow side: the error names where the function was", async () => {
		const { link } = await linked({ context: acceptAll });
		const err = await link.with({ a: { onDone() {} } }, () => 1).catch((e) => e);
		expect(err.location).toBe("context.a.onDone");
	});

	it("serve side: a hand-built frame's context is held to the same rules — VINE_DATA_ONLY, the check never asked", async () => {
		let asked = 0;
		const serveApi = await instance({ base: CONTEXT_DIR });
		const [near, far] = createPair();
		const peer = rawPeer(near);
		const serving = await serve(serveApi, far, {
			context: (requested) => {
				asked++;
				return requested;
			}
		});
		teardown.push(() => serving.close());
		expect((await peer.surface()).context).toBe(true);
		for (const bad of [{ cb: () => {} }, "A", [1], 7, true]) {
			expect((await peer.call("work.read", [], { context: bad })).error.code).toBe(CODES.DATA_ONLY);
		}
		expect(asked).toBe(0);
		// `null` is "no context", not a fault.
		expect((await peer.call("work.read", [], { context: null })).value).toMatchObject({ project: null });
		expect(asked).toBe(0);
	});
});

describe("requested context — grow({ context }), the link default", () => {
	it("a resolver is read per call — the server holds no pin state", async () => {
		let pinned = "A";
		const { growApi } = await linked({ context: acceptAll }, { context: () => (pinned ? { project: pinned } : null) });
		expect(await growApi.work.read()).toMatchObject({ project: "A" });
		pinned = "B";
		expect(await growApi.work.read()).toMatchObject({ project: "B" });
		pinned = null;
		expect(await growApi.work.read()).toMatchObject({ project: null });
	});

	it("a static default is copied once; with() overrides it; with(null) clears it", async () => {
		const pin = { project: "A" };
		const { growApi, link } = await linked({ context: acceptAll }, { context: pin });
		pin.project = "mutated";
		expect(await growApi.work.read()).toMatchObject({ project: "A" });
		expect(await link.with({ project: "B" }, () => growApi.work.read())).toMatchObject({ project: "B" });
		expect(await link.with(null, () => growApi.work.read())).toMatchObject({ project: null });
		// Nested: the innermost extent wins, no merge.
		expect(await link.with({ project: "C", extra: 1 }, () => link.with({ project: "D" }, () => growApi.work.read()))).toEqual({
			project: "D",
			actor: null,
			extra: null
		});
	});

	it("a resolver that throws rejects that call with its own error; a non-data answer is VINE_DATA_ONLY", async () => {
		let mode = "throw";
		const { growApi } = await linked(
			{ context: acceptAll },
			{
				context: () => {
					if (mode === "throw") throw new Error("no pin");
					return { cb: () => {} };
				}
			}
		);
		await expect(growApi.work.read()).rejects.toThrow("no pin");
		mode = "junk";
		await expect(growApi.work.read()).rejects.toMatchObject({ code: CODES.DATA_ONLY });
	});

	it("a bad static default fails grow() itself", async () => {
		const growApi = await instance({ base: CONTEXT_GROW_DIR });
		const [near] = createPair();
		await expect(grow(growApi, near, { context: "A" })).rejects.toThrow(TypeError);
		await expect(grow(growApi, near, { context: { cb() {} } })).rejects.toMatchObject({ code: CODES.DATA_ONLY });
	});

	it("only holders the link minted are honoured — a function planted under the link's key is ignored", async () => {
		const { growApi, link } = await linked({ context: acceptAll });
		const forged = await growApi.slothlet.context.run({ [`${link.id}:context`]: () => ({ project: "X" }) }, () => growApi.work.read());
		expect(forged).toMatchObject({ project: null });
	});

	it("with() on one link never scopes calls over another", async () => {
		const serveApi = await instance({ base: CONTEXT_DIR });
		const otherApi = await instance({ base: path.join(here, "fixtures", "principal-api") });
		const growApi = await instance({ base: CONTEXT_GROW_DIR });
		const [a1, a2] = createPair();
		const [b1, b2] = createPair();
		const s1 = await serve(serveApi, a2, { context: acceptAll });
		const s2 = await serve(otherApi, b2, { paths: ["host"] }); // accepts no context
		const l1 = await grow(growApi, a1, { budgetMs: 2000 });
		const l2 = await grow(growApi, b1, { budgetMs: 2000 });
		teardown.push(async () => {
			await l1.close();
			await l2.close();
			s1.close();
			s2.close();
		});
		const got = await l1.with({ project: "A" }, async () => [await growApi.work.read(), await growApi.host.deps.list()]);
		expect(got).toEqual([{ project: "A", actor: null, extra: null }, ["slothlet", "slothlet-vine"]]);
	});
});

describe("requested context — old/new interop (no FRAME_VERSION change)", () => {
	it("an old grow (no context on its frames) talks to a new serve with a check — unchanged, the check not asked", async () => {
		let asked = 0;
		const serveApi = await instance({ base: CONTEXT_DIR });
		const [near, far] = createPair();
		const peer = rawPeer(near);
		const serving = await serve(serveApi, far, {
			context: (requested) => {
				asked++;
				return requested;
			}
		});
		teardown.push(() => serving.close());
		const surface = await peer.surface();
		expect(surface.v).toBe(1); // no version bump — an old grow still mounts from this frame
		expect((await peer.call("work.read")).value).toEqual({ project: null, actor: null, extra: null });
		expect(asked).toBe(0);
	});

	it("a new grow facing an old serve (a surface without `context`) refuses a requested context locally; plain calls work", async () => {
		const growApi = await instance({ base: CONTEXT_GROW_DIR });
		const [near, far] = createPair();
		const oldServe = rawPeer(far);
		oldServe.send({ type: "surface", v: 1, leaves: ["work.read"] });
		const link = await grow(growApi, near, { budgetMs: 2000 });
		teardown.push(() => link.close());
		expect(link.context).toBe(false);
		await expect(link.with({ project: "A" }, () => growApi.work.read())).rejects.toMatchObject({ code: CODES.CONTEXT });
		expect(oldServe.frames.filter((frame) => frame.type === "call")).toEqual([]);
		// A plain call's frame carries no `context` key at all — byte for byte the v1 frame.
		const pending = growApi.work.read();
		const call = await oldServe.waitFor((frame) => frame.type === "call");
		expect(Object.keys(call).sort()).toEqual(["args", "callId", "path", "type"]);
		oldServe.send({ type: "result", callId: call.callId, value: "old" });
		expect(await pending).toBe("old");
	});

	it("a new grow facing a new serve sends `context` on the call frame only inside an extent", async () => {
		const growApi = await instance({ base: CONTEXT_GROW_DIR });
		const [near, far] = createPair();
		const newServe = rawPeer(far);
		newServe.send({ type: "surface", v: 1, leaves: ["work.read"], context: true });
		const link = await grow(growApi, near, { budgetMs: 2000 });
		teardown.push(() => link.close());
		expect(link.context).toBe(true);
		const pending = link.with({ project: "A" }, () => growApi.work.read());
		const call = await newServe.waitFor((frame) => frame.type === "call");
		expect(call.context).toEqual({ project: "A" });
		newServe.send({ type: "result", callId: call.callId, value: "ok" });
		expect(await pending).toBe("ok");
	});
});

describe("serve({ context }) setup", () => {
	it("throws a TypeError for a non-function check", async () => {
		const serveApi = await instance({ base: CONTEXT_DIR });
		const [, far] = createPair();
		await expect(serve(serveApi, far, { context: { project: "A" } })).rejects.toThrow(/context must be a function/);
	});

	it("fails closed on a `scope: false` instance — a TypeError, and no surface is published", async () => {
		const serveApi = await instance({ base: CONTEXT_DIR, scope: false });
		const [near, far] = createPair();
		const peer = rawPeer(near);
		await expect(serve(serveApi, far, { context: acceptAll })).rejects.toThrow(
			/context check needs a working api\.slothlet\.context\.scope\(\)/
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(peer.frames).toEqual([]);
	});
});

describe("requested context over websocket", () => {
	it("accepted, narrowed and refused per call over one live socket", async () => {
		const serveApi = await instance({ base: CONTEXT_DIR });
		const growApi = await instance({ base: CONTEXT_GROW_DIR });
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.add(wss);
		teardown.push(() => new Promise((resolve) => wss.close(() => resolve())));
		await once(wss, "listening");
		const { port } = wss.address();
		wss.on("connection", async (socket) => {
			const serving = await serve(serveApi, createWsChannel(socket), {
				// Only projects this (fake) user can access are accepted; `extra` is always dropped.
				context: (requested) => (requested.project === "A" ? { project: "A" } : false)
			});
			teardown.push(() => serving.close());
		});
		const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
		const channel = createWsChannel(socket);
		teardown.push(() => socket.terminate());
		const link = await grow(growApi, channel, { budgetMs: 2000 });
		teardown.push(() => link.close());
		expect(link.context).toBe(true);
		expect(await link.with({ project: "A", extra: 1 }, () => growApi.work.read())).toEqual({ project: "A", actor: null, extra: null });
		expect(await remoteCode(link.with({ project: "B" }, () => growApi.work.read()))).toBe(CODES.CONTEXT);
		expect(await growApi.work.read()).toMatchObject({ project: null });
	});
});
