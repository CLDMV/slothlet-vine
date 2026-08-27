/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/grow-serve-units.test.vitest.mjs
 *
 * Unit-level coverage of the failure paths `grow` and `serve` are built around but which a healthy
 * loopback e2e never reaches: a transport whose `send` throws, an `add()` slothlet refuses, a
 * `remove()` that silently unmounts nothing, a `leaves()` that throws for a stale moduleID, a leaf
 * that vanished between publication and invocation, and a synchronous transport that delivers the
 * surface frame during registration.
 *
 * These use FAKE api and channel objects on purpose — the point is to drive states a real slothlet
 * instance and a healthy loopback pair cannot be made to produce on demand.
 */
import { describe, it, expect, vi } from "vitest";
import { grow } from "../src/grow.mjs";
import { serve } from "../src/serve.mjs";
import { CODES } from "../src/lib/errors.mjs";

/**
 * A Channel whose behaviour each test tailors.
 * @param {object} [behaviour]
 * @param {(frame: object) => void} [behaviour.onSend] - Called for every outbound frame; may throw.
 * @param {boolean} [behaviour.syncSurface] - Deliver a surface frame synchronously during `onMessage`.
 * @param {string[]} [behaviour.leaves] - Leaves for the synchronous surface.
 * @param {boolean} [behaviour.noOnClose] - Omit `onClose` entirely.
 * @param {boolean} [behaviour.syncClose] - Fire the close handler synchronously during registration.
 * @param {boolean} [behaviour.throwOnReRegister] - Throw on every `onMessage()` call after the first,
 *   modeling a transport that refuses a handler re-registration once already registered.
 * @returns {object} The fake channel plus test controls.
 */
function fakeChannel(behaviour = {}) {
	const sent = [];
	let handler = null;
	let closeHandler = null;
	let onMessageCalls = 0;
	const channel = {
		sent,
		send(frame) {
			sent.push(frame);
			behaviour.onSend?.(frame);
		},
		onMessage(fn) {
			onMessageCalls++;
			if (behaviour.throwOnReRegister && onMessageCalls > 1) {
				throw new Error("this fake transport refuses a re-registration");
			}
			handler = fn;
			if (behaviour.syncSurface) fn({ type: "surface", v: 1, leaves: behaviour.leaves ?? ["far.leaf"] });
		},
		/**
		 * Push a frame at the registered handler, as the transport would.
		 * @param {unknown} frame - The frame.
		 * @returns {void}
		 */
		deliver(frame) {
			handler?.(frame);
		},
		/**
		 * Fire the registered close handler.
		 * @param {object} [info] - Close info.
		 * @returns {void}
		 */
		fireClose(info) {
			closeHandler?.(info);
		}
	};
	if (!behaviour.noOnClose) {
		channel.onClose = (fn) => {
			closeHandler = fn;
			if (behaviour.syncClose) fn({ reason: "already-dead" });
		};
	}
	return channel;
}

/**
 * A minimal stand-in for a slothlet instance. `leaves()` models the real one closely enough for the
 * teardown path: a moduleID answers the paths that module currently OWNS, an id nobody mounted
 * throws `API_LEAVES_UNKNOWN_MODULE`, and a `forceOverwrite` takeover reassigns ownership of the
 * path to the taking module.
 * @param {object} [behaviour]
 * @param {Record<string, Array<{path: string, kind: string}>>} [behaviour.records] - `leaves()` answers by key.
 * @param {(key: string) => void} [behaviour.onLeaves] - Called before answering; may throw.
 * @param {(path: string) => void} [behaviour.onAdd] - Called on `add`; may throw.
 * @param {(key: string) => void} [behaviour.onRemove] - Called on `remove`.
 * @param {boolean} [behaviour.removeIsNoop] - Model the colon-moduleID bug: `remove(id)` unmounts nothing.
 * @returns {object} The fake api.
 */
function fakeApi(behaviour = {}) {
	const tree = {};
	/** @type {Map<string, Set<string>>} moduleID → the paths it owns. */
	const owners = new Map();
	const api = {
		tree,
		owners,
		removed: [],
		slothlet: {
			api: {
				async leaves(key) {
					behaviour.onLeaves?.(key);
					if (behaviour.records && key in behaviour.records) return behaviour.records[key];
					if (owners.has(key)) return [...owners.get(key)].map((path) => ({ path, kind: "data" }));
					if (key === ".") return behaviour.records?.["."] ?? [];
					throw new Error(`[API_LEAVES_UNKNOWN_MODULE] No module found for '${key}'.`);
				},
				async add(path, fn, options = {}) {
					behaviour.onAdd?.(path);
					const segments = path.split(".");
					const last = segments.pop();
					let node = api;
					for (const segment of segments) {
						if (node[segment] === undefined) node[segment] = {};
						node = node[segment];
					}
					const free = node[last] === undefined;
					if (free || options.forceOverwrite) node[last] = fn;
					if (free || options.forceOverwrite) {
						const id = options.moduleID ?? "module-id";
						for (const paths of owners.values()) paths.delete(path);
						if (!owners.has(id)) owners.set(id, new Set());
						owners.get(id).add(path);
					}
					return options.moduleID ?? "module-id";
				},
				async remove(key) {
					api.removed.push(key);
					behaviour.onRemove?.(key);
					if (behaviour.removeIsNoop && !key.includes(".")) return;
					if (owners.has(key)) owners.delete(key);
					else for (const paths of owners.values()) paths.delete(key);
					if (key.includes(".") || behaviour.records) {
						const segments = key.split(".");
						const last = segments.pop();
						let node = api;
						for (const segment of segments) node = node?.[segment];
						if (node) delete node[last];
					}
				}
			}
		}
	};
	return api;
}

describe("serve — collection edge cases", () => {
	it("skips a module key whose leaves() throws, and still serves the rest", async () => {
		const api = fakeApi({
			records: { ".": [{ path: "math.add", kind: "function" }] },
			onLeaves(key) {
				if (key === "stale") throw new Error("API_LEAVES_UNKNOWN_MODULE");
			}
		});
		const channel = fakeChannel();
		const serving = await serve(api, channel, { modules: ["stale"] });
		expect(serving.leaves).toEqual(["math.add"]);
	});

	it("unions a named module's leaves into the surface", async () => {
		const api = fakeApi({
			records: { ".": [{ path: "math.add", kind: "function" }], "ext-1": [{ path: "exts.one.go", kind: "function" }] }
		});
		const serving = await serve(api, fakeChannel(), { modules: ["ext-1"] });
		expect(serving.leaves).toEqual(["exts.one.go", "math.add"]);
	});

	it("tolerates a leaves() answer that is not an array", async () => {
		const api = fakeApi();
		api.slothlet.api.leaves = async () => "not an array";
		const serving = await serve(api, fakeChannel());
		expect(serving.leaves).toEqual([]);
	});

	it("drops non-function records and unsafe paths from the surface", async () => {
		const api = fakeApi({
			records: {
				".": [
					{ path: "math.add", kind: "function" },
					{ path: "math.answer", kind: "data" },
					{ path: "math", kind: "namespace" },
					{ path: "slothlet.api.remove", kind: "function" },
					{ path: "__proto__.pwn", kind: "function" },
					{ kind: "function" },
					null
				]
			}
		});
		const serving = await serve(api, fakeChannel());
		expect(serving.leaves).toEqual(["math.add"]);
	});

	it("ignores a NON-ARRAY paths option, but reads an unsatisfiable array as fail-closed", async () => {
		const api = fakeApi({ records: { ".": [{ path: "math.add", kind: "function" }] } });
		expect((await serve(api, fakeChannel(), { paths: "tools" })).leaves).toEqual(["math.add"]);
		expect((await serve(api, fakeChannel(), { paths: [] })).leaves).toEqual([]);
		expect((await serve(api, fakeChannel(), { paths: ["", 7] })).leaves).toEqual([]);
	});
});

describe("serve — answering edge cases", () => {
	/**
	 * @param {object} [behaviour] - Channel behaviour.
	 * @param {object} [apiBehaviour] - Api behaviour.
	 * @returns {Promise<{api: object, channel: object, serving: object}>} A serving fake.
	 */
	async function serving(behaviour, apiBehaviour) {
		const api = fakeApi({ records: { ".": [{ path: "math.add", kind: "function" }] }, ...apiBehaviour });
		api.math = { add: (a, b) => a + b };
		const channel = fakeChannel(behaviour);
		return { api, channel, serving: await serve(api, channel, undefined) };
	}

	it("publishes the surface as its first frame", async () => {
		const { channel } = await serving();
		expect(channel.sent[0]).toEqual({ type: "surface", v: 1, leaves: ["math.add"] });
	});

	it("answers VINE_NO_LEAF when the published path no longer resolves", async () => {
		const { api, channel } = await serving();
		delete api.math;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		await tick();
		expect(channel.sent.at(-1).error.code).toBe(CODES.NO_LEAF);
	});

	it("answers VINE_NO_LEAF when the path resolves to a non-function", async () => {
		const { api, channel } = await serving();
		api.math.add = 42;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [] });
		await tick();
		expect(channel.sent.at(-1).error.code).toBe(CODES.NO_LEAF);
	});

	it("answers VINE_NO_LEAF when an intermediate segment is a primitive", async () => {
		const { api, channel } = await serving();
		api.math = 7;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [] });
		await tick();
		expect(channel.sent.at(-1).error.code).toBe(CODES.NO_LEAF);
	});

	it("substitutes an error frame when the result cannot be sent", async () => {
		let failNext = false;
		const { channel } = await serving({
			onSend(frame) {
				if (frame.type === "result" && failNext) throw new Error("could not be cloned");
			}
		});
		failNext = true;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		await tick();
		const last = channel.sent.at(-1);
		expect(last.type).toBe("error");
		expect(last.error.code).toBe(CODES.BAD_FRAME);
	});

	it("gives up quietly when the substitute error frame ALSO cannot be sent", async () => {
		const { channel } = await serving({
			onSend(frame) {
				if (frame.type !== "surface") throw new Error("channel is dead");
			}
		});
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		await expect(tick()).resolves.toBeUndefined();
	});

	it("swallows a send failure for the surface frame itself (no callId to answer on)", async () => {
		const api = fakeApi({ records: { ".": [{ path: "math.add", kind: "function" }] } });
		const channel = fakeChannel({
			onSend(frame) {
				if (frame.type === "surface") throw new Error("dead on arrival");
			}
		});
		await expect(serve(api, channel)).resolves.toBeTruthy();
	});

	it("does not answer a call that lands after close()", async () => {
		const { channel, serving: handle } = await serving();
		handle.close();
		const before = channel.sent.length;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		await tick();
		expect(channel.sent.length).toBe(before);
	});

	it("still guards a call delivered after close() when the transport refuses the handler re-registration", async () => {
		// close() releases the receive closure by re-registering a no-op via channel.onMessage(); if the
		// transport refuses that call the ORIGINAL handler stays live, and its own internal `closed`
		// check is what keeps it from answering. Cover that fallback path directly.
		const { channel, serving: handle } = await serving({ throwOnReRegister: true });
		expect(() => handle.close()).not.toThrow();
		const before = channel.sent.length;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		await tick();
		expect(channel.sent.length).toBe(before);
	});

	it("does not answer an ERROR for a call that failed only after close()", async () => {
		const api = fakeApi({ records: { ".": [{ path: "slow.go", kind: "function" }] } });
		let fail;
		api.slow = { go: () => new Promise((_, reject) => (fail = reject)) };
		const channel = fakeChannel();
		const handle = await serve(api, channel);
		const before = channel.sent.length;
		channel.deliver({ type: "call", callId: "c1", path: "slow.go", args: [] });
		await tick();
		handle.close();
		fail(new Error("late failure"));
		await tick();
		expect(channel.sent.length).toBe(before);
	});

	it("describes a non-Error send failure without inventing a message", async () => {
		const api = fakeApi({ records: { ".": [{ path: "math.add", kind: "function" }] } });
		api.math = { add: (a, b) => a + b };
		let armed = false;
		const channel = fakeChannel({
			onSend(frame) {
				if (frame.type === "result" && armed) throw "a bare string, not an Error";
			}
		});
		await serve(api, channel);
		armed = true;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		await tick();
		expect(channel.sent.at(-1).error.message).toContain("a bare string, not an Error");
	});

	it("does not answer a call whose leaf resolves only after close() (the in-flight race)", async () => {
		const api = fakeApi({ records: { ".": [{ path: "slow.go", kind: "function" }] } });
		let release;
		api.slow = { go: () => new Promise((resolve) => (release = resolve)) };
		const channel = fakeChannel();
		const handle = await serve(api, channel);
		const before = channel.sent.length;
		channel.deliver({ type: "call", callId: "c1", path: "slow.go", args: [] });
		await tick();
		handle.close();
		release("late");
		await tick();
		expect(channel.sent.length).toBe(before);
	});
});

describe("grow — mount and teardown edge cases", () => {
	it("accepts a surface delivered SYNCHRONOUSLY during onMessage registration", async () => {
		const api = fakeApi();
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["far.leaf"] }));
		expect(link.leaves).toEqual(["far.leaf"]);
	});

	it("ignores junk frames and a second surface publication", async () => {
		const api = fakeApi();
		const channel = fakeChannel({ syncSurface: true, leaves: ["far.leaf"] });
		const link = await grow(api, channel);
		channel.deliver(null);
		channel.deliver({ type: "surface", v: 1, leaves: ["other.leaf"] });
		channel.deliver({ type: "result", callId: "never-opened", value: 1 });
		channel.deliver({ type: "error", callId: "never-opened", error: { name: "E", message: "m" } });
		expect(link.leaves).toEqual(["far.leaf"]);
		expect(api.other).toBeUndefined();
	});

	it("skips a leaf whose add() slothlet refuses", async () => {
		const api = fakeApi({
			onAdd(path) {
				if (path === "bad.leaf") throw new Error("INVALID_CONFIG_API_PATH_INVALID");
			}
		});
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["ok.leaf", "bad.leaf"] }));
		expect(link.leaves).toEqual(["ok.leaf"]);
		expect(link.skipped).toEqual(["bad.leaf"]);
	});

	it("falls back to per-path removal when remove(moduleID) unmounts nothing", async () => {
		const api = fakeApi({ removeIsNoop: true });
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["far.leaf"] }));
		expect(typeof api.far.leaf).toBe("function");
		await link.close();
		expect(api.far.leaf).toBeUndefined();
		expect(api.removed).toEqual([link.id, "far.leaf"]);
	});

	it("never mounts a collided path, and leaves it alone during teardown", async () => {
		const api = fakeApi({ removeIsNoop: true });
		api.far = { leaf: () => "local" };
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["far.leaf"] }));
		expect(link.collisions).toEqual(["far.leaf"]);
		expect(link.leaves).toEqual([]);
		await link.close();
		expect(api.far.leaf()).toBe("local");
		expect(api.removed).toEqual([link.id]);
	});

	it("treats every mounted path as owned when leaves() cannot answer", async () => {
		// Ownership is unknowable here, so the fallback keeps its original job: a remove(moduleID) that
		// unmounts NOTHING must still leave no callable stub behind.
		const api = fakeApi({ removeIsNoop: true });
		api.slothlet.api.leaves = async () => "not a record list";
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["far.leaf"] }));
		await link.close();
		expect(api.far.leaf).toBeUndefined();
		expect(api.removed).toEqual([link.id, "far.leaf"]);
	});

	it("does not remove a path the link no longer owns", async () => {
		// The unit-level twin of the e2e takeover case: the records say another module owns the path
		// now, so the per-path fallback must not touch it even though the stub is still resolvable.
		const api = fakeApi({ removeIsNoop: true });
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["far.leaf"] }));
		await api.slothlet.api.add("far.leaf", () => "local", { moduleID: "someone-else", forceOverwrite: true });
		await link.close();
		expect(api.far.leaf()).toBe("local");
		expect(api.removed).toEqual([link.id]);
	});

	it("swallows a per-path removal that throws", async () => {
		const api = fakeApi({
			removeIsNoop: true,
			onRemove(key) {
				if (key.includes(".")) throw new Error("nope");
			}
		});
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["far.leaf"] }));
		await expect(link.close()).resolves.toBeUndefined();
		await expect(link.closed).resolves.toMatchObject({ reason: "closed" });
	});

	it("treats a path that throws while being probed as un-occupied", async () => {
		const api = fakeApi();
		Object.defineProperty(api, "hostile", {
			enumerable: true,
			get() {
				throw new Error("no reading me");
			}
		});
		const link = await grow(api, fakeChannel({ syncSurface: true, leaves: ["hostile.leaf"] }));
		expect(link.collisions).toEqual([]);
	});

	it("fails the handshake when the transport reports the peer dead DURING onClose registration", async () => {
		const api = fakeApi();
		await expect(grow(api, fakeChannel({ syncClose: true }))).rejects.toMatchObject({ code: CODES.GONE });
	});

	it("works over a transport with no onClose at all", async () => {
		const api = fakeApi();
		const link = await grow(api, fakeChannel({ syncSurface: true, noOnClose: true }));
		expect(link.leaves).toEqual(["far.leaf"]);
		await link.close();
	});

	it("tolerates a handshake timer handle with no unref() (a browser-style setTimeout)", async () => {
		// Node's setTimeout returns a Timeout with unref(); a browser's returns a bare number — the
		// `timer && typeof timer.unref === "function"` guard exists for that case. Wrap the real timer
		// (so it still fires) in a handle that lacks unref(), rather than asserting a tautology.
		const realSetTimeout = globalThis.setTimeout;
		vi.stubGlobal("setTimeout", (fn, ms) => ({ id: realSetTimeout(fn, ms) }));
		try {
			const api = fakeApi();
			// No syncSurface and no syncClose — only the handshake timer can settle this call.
			await expect(grow(api, fakeChannel(), { handshakeMs: 10 })).rejects.toMatchObject({ code: CODES.BUDGET });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("ignores a well-formed 'call' frame arriving grow-side — not surface/result/error", async () => {
		const api = fakeApi();
		const channel = fakeChannel({ syncSurface: true, leaves: ["far.leaf"] });
		const link = await grow(api, channel);
		// A channel is directional; grow only expects surface/result/error. A stray (or hostile) 'call'
		// frame matches none of those and must be silently ignored, not throw or corrupt pending state.
		expect(() => channel.deliver({ type: "call", callId: "stray", path: "far.leaf", args: [] })).not.toThrow();
		expect(link.leaves).toEqual(["far.leaf"]);
		await link.close();
	});
});

describe("grow — stub dispatch edge cases", () => {
	/**
	 * @param {object} [behaviour] - Channel behaviour.
	 * @returns {Promise<{api: object, channel: object, link: object}>} A grown fake.
	 */
	async function grown(behaviour = {}) {
		const api = fakeApi();
		const channel = fakeChannel({ syncSurface: true, leaves: ["far.leaf"], ...behaviour });
		const link = await grow(api, channel, { budgetMs: 500 });
		return { api, channel, link };
	}

	it("settles VINE_BAD_FRAME when the call frame cannot be sent", async () => {
		const { api, link } = await grown({
			onSend(frame) {
				if (frame.type === "call") throw new Error("DataCloneError");
			}
		});
		await expect(api.far.leaf(1)).rejects.toMatchObject({ code: CODES.BAD_FRAME, path: "far.leaf" });
		await link.close();
	});

	it("describes a non-Error send failure without inventing a message", async () => {
		const { api, link } = await grown({
			onSend(frame) {
				if (frame.type === "call") throw "a bare string, not an Error";
			}
		});
		await expect(api.far.leaf(1)).rejects.toMatchObject({ code: CODES.BAD_FRAME });
		await expect(api.far.leaf(1)).rejects.toThrow(/a bare string, not an Error/);
		await link.close();
	});

	it("refuses a call made after close() with VINE_CLOSED", async () => {
		const { api, link } = await grown();
		const stub = api.far.leaf;
		await link.close();
		await expect(stub(1)).rejects.toMatchObject({ code: CODES.CLOSED, path: "far.leaf" });
	});

	it("refuses a call made after the far side died with VINE_GONE", async () => {
		const { api, channel, link } = await grown();
		channel.fireClose({ reason: "peer-closed" });
		await expect(api.far.leaf(1)).rejects.toMatchObject({ code: CODES.GONE, path: "far.leaf" });
		await expect(link.closed).resolves.toMatchObject({ reason: "gone", info: { reason: "peer-closed" } });
	});

	it("ignores a second close notification, and one after a local close", async () => {
		const { channel, link } = await grown();
		channel.fireClose({ reason: "first" });
		channel.fireClose({ reason: "second" });
		await expect(link.closed).resolves.toMatchObject({ info: { reason: "first" } });

		const other = await grown();
		await other.link.close();
		other.channel.fireClose({ reason: "after-local-close" });
		await expect(other.link.closed).resolves.toMatchObject({ reason: "closed" });
	});

	it("still resolves closed, not gone, when a gone notification races close() while it's still tearing down", async () => {
		const { channel, link } = await grown();
		// close() flips state.closed synchronously and then awaits the (async) unmount — the channel
		// registrations aren't released until its finally block, so the far side reporting gone WHILE
		// that unmount is still in flight reaches the original handler, not a replacement no-op. This
		// is the one case the internal `state.closed` guard exists for.
		const closing = link.close();
		channel.fireClose({ reason: "raced" });
		await closing;
		await expect(link.closed).resolves.toMatchObject({ reason: "closed" });
	});

	it("falls back to the default budget for a nonsense budgetMs", async () => {
		const api = fakeApi();
		const channel = fakeChannel({ syncSurface: true });
		const link = await grow(api, channel, { budgetMs: -1, handshakeMs: Infinity });
		expect(link.leaves).toEqual(["far.leaf"]);
		await link.close();
	});
});

/**
 * Let queued microtasks and one macrotask run.
 * @returns {Promise<void>} Resolves on the next macrotask.
 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}
