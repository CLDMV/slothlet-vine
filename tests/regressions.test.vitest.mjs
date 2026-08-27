/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/regressions.test.vitest.mjs
 *
 * REGRESSION FILE. Every test here started life in an adversarial review as its own inverse: a
 * green assertion that a DEFECT was present. Each one is now written the right way round and pins
 * the FIXED behaviour, so a re-introduction of the original bug fails here rather than shipping.
 *
 * The numbering is the review's, kept deliberately so a finding can be traced from report to test:
 *
 *  1. `link.close()`'s per-path fallback is OWNERSHIP-scoped — a local module that legitimately took
 *     a vine path over (`forceOverwrite`, its own moduleID) survives the teardown intact.
 *  2. `link.leaves` lists only paths actually mounted: a collided path is reported on `collisions`,
 *     never added, and the local incumbent keeps answering there — during the link and after it.
 *  3. A far side cannot impersonate a vine link-state error: a remote `code` in the reserved `VINE_*`
 *     namespace is remapped to `VINE_REMOTE`, with the far side's spelling kept on `.remoteCode`.
 *  4. A leaf whose EXPORT name is outside the ASCII alphabet (`export function café()`) is served,
 *     mounted and callable end to end; leaves a serve declines are reported on `serving.excluded`.
 *  5. Data-only is enforced on RETURN values too: a leaf returning a function is refused serve-side
 *     with `VINE_DATA_ONLY` instead of handing the caller a live closure over a by-reference
 *     transport (and failing as an opaque clone error over a cloning one).
 *  6. Answering a call does not corrupt the served instance's own leaf records (the `Reflect.apply`
 *     dispatch) — found while verifying 4 and 5.
 *  8. The minors: mounting stops when the far side dies mid-mount; `handshakeMs` has explicit
 *     semantics for nonsense values; a hostile error object settles the call it belongs to; and
 *     `close()` releases the receive closure.
 *  9. `serve()` enforces data-only on ARGUMENTS received off the wire too, not only return values —
 *     a frame built directly against a by-reference channel (bypassing `vineStub`) could otherwise
 *     hand a live function to the local leaf.
 *  10. `grow()`'s own channel registrations — `onMessage`, and `onClose` when the transport offers
 *      one — are released on every exit, not only a successful `close()`: a handshake that fails
 *      (budget expiry, or the far side gone before the surface arrives) never returns a `link` a
 *      caller could close, so the failure path has to be the release.
 *  11. `transport/process`'s `close()` tolerates a wrapped object that doesn't implement
 *      `removeListener`/`off` — `createParentChannel`'s `proc` param is documented as
 *      test-double-friendly and is only validated for `send`/`on`, so a minimal fake must not crash
 *      `close()`.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError, fromWire } from "../src/lib/errors.mjs";
import { createPair } from "../src/transport/loopback.mjs";
import { createParentChannel } from "../src/transport/process.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const REGRESSION_DIR = path.join(here, "fixtures", "regression-api");

/** @type {Array<() => Promise<void>>} */
let teardown = [];
afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try {
			await fn();
		} catch {
			// teardown must not mask the assertion
		}
	}
	teardown = [];
});

/**
 * Compose a real slothlet instance and register its shutdown.
 * @param {string} base - Fixture directory.
 * @param {object} [options] - Extra slothlet options.
 * @returns {Promise<object>} The live instance.
 */
async function instance(base, options) {
	const api = await slothlet({ base, silent: true, ...options });
	teardown.push(async () => api.slothlet?.shutdown?.());
	return api;
}

/**
 * A far side that publishes a fixed surface and answers every call from a table.
 * @param {object} channel - The far end of a loopback pair.
 * @param {string[]} leaves - The surface to publish.
 * @param {(frame: object) => unknown} answer - Produces the result value for a call frame.
 * @returns {void}
 */
function fakeFarSide(channel, leaves, answer) {
	channel.send({ type: "surface", v: 1, leaves });
	channel.onMessage((frame) => {
		if (frame?.type === "call") channel.send({ type: "result", callId: frame.callId, value: answer(frame) });
	});
}

describe("finding 1 — close() removes what the link still OWNS, never local reality", () => {
	it("leaves a local forceOverwrite takeover intact, and still unmounts the paths it kept", async () => {
		const api = await instance(GROW_DIR);
		const [near, far] = createPair();
		fakeFarSide(far, ["fresh.leaf", "other.leaf"], (frame) => `REMOTE(${frame.path})`);

		const link = await grow(api, near, { handshakeMs: 5000, budgetMs: 2000 });
		expect(link.leaves).toEqual(["fresh.leaf", "other.leaf"]);
		expect(await api.fresh.leaf()).toBe("REMOTE(fresh.leaf)");

		// Local reality legitimately takes one path over, with its OWN moduleID.
		await api.slothlet.api.add("fresh.leaf", () => "LOCAL", { moduleID: "my-local-module", forceOverwrite: true });
		expect(await api.fresh.leaf()).toBe("LOCAL");

		await link.close();

		// The takeover survives: the vine no longer owns that path, so it is not the vine's to remove.
		expect(typeof api.fresh.leaf).toBe("function");
		expect(await api.fresh.leaf()).toBe("LOCAL");
		// The path the link DID still own is gone — teardown is still a real teardown.
		expect(api.other?.leaf).toBeUndefined();
	});

	it("still unmounts every stub when nothing took a path over", async () => {
		const api = await instance(GROW_DIR);
		const [near, far] = createPair();
		fakeFarSide(far, ["fresh.leaf"], () => "REMOTE");

		const link = await grow(api, near, { handshakeMs: 5000, budgetMs: 2000 });
		expect(typeof api.fresh.leaf).toBe("function");
		await link.close();
		expect(api.fresh?.leaf).toBeUndefined();
	});
});

describe("finding 2 — link.leaves lists only what is actually mounted", () => {
	it("reports a collided path on collisions ONLY, and never mounts it", async () => {
		const api = await instance(GROW_DIR);
		const [near, far] = createPair();
		fakeFarSide(far, ["caller.secret", "fresh.leaf"], (frame) => `REMOTE(${frame.path})`);

		const link = await grow(api, near, { handshakeMs: 5000, budgetMs: 2000 });
		teardown.push(async () => link.close());

		expect(link.collisions).toEqual(["caller.secret"]);
		expect(link.leaves).toEqual(["fresh.leaf"]);
		expect(link.leaves).not.toContain("caller.secret");
		// The three lists stay disjoint — a path is mounted, skipped or collided, never two of them.
		expect(link.skipped).toEqual([]);

		// The local incumbent still answers there; the far leaf was never reachable at that path.
		await expect(api.caller.secret()).rejects.toThrow();
		expect(await api.fresh.leaf()).toBe("REMOTE(fresh.leaf)");
	});

	it("leaves the collided local incumbent answering after close()", async () => {
		const api = await instance(GROW_DIR);
		const [near, far] = createPair();
		fakeFarSide(far, ["caller.echo"], () => "REMOTE");

		const link = await grow(api, near, { handshakeMs: 5000, budgetMs: 2000 });
		expect(link.collisions).toEqual(["caller.echo"]);
		await link.close();

		// The vine borrowed nothing at that path, so it gives nothing back: the local module is intact.
		expect(typeof api.caller.echo).toBe("function");
	});
});

describe("finding 3 — a far side cannot impersonate a vine link-state error", () => {
	it("remaps a reserved VINE_* code to VINE_REMOTE and keeps the original on .remoteCode", () => {
		const spoof = fromWire({ name: "VineError", message: "the link was closed", code: "VINE_CLOSED", stack: "remote" });

		// The consumer's documented branch — `err instanceof VineError && err.code === CODES.CLOSED` —
		// no longer fires for something that arrived over the wire.
		expect(spoof).toBeInstanceOf(VineError);
		expect(spoof.code).toBe(CODES.REMOTE);
		expect(spoof.code).not.toBe(CODES.CLOSED);
		// Nothing is lost: what the far side actually said is still readable.
		expect(spoof.remoteCode).toBe("VINE_CLOSED");
		expect(spoof.remoteStack).toBe("remote");
		expect(spoof).toBeInstanceOf(VineRemoteError);
	});

	it("remaps every reserved code, not just the link-state ones", () => {
		for (const code of Object.values(CODES)) {
			const spoof = fromWire({ name: "VineError", message: "spoof", code });
			expect(spoof.code).toBe(CODES.REMOTE);
			expect(spoof.remoteCode).toBe(code);
		}
	});

	it("still adopts an ordinary application code verbatim", () => {
		const real = fromWire({ name: "BoomError", message: "kaboom", code: "E_BOOM" });
		expect(real.code).toBe("E_BOOM");
		expect(real.remoteCode).toBe("E_BOOM");
	});

	it("cannot drive a caller's teardown branch from across a live link", async () => {
		const api = await instance(GROW_DIR);
		const [near, far] = createPair();
		far.send({ type: "surface", v: 1, leaves: ["fresh.leaf"] });
		far.onMessage((frame) => {
			if (frame?.type === "call") {
				far.send({ type: "error", callId: frame.callId, error: { name: "VineError", message: "closed", code: CODES.CLOSED } });
			}
		});

		const link = await grow(api, near, { handshakeMs: 5000, budgetMs: 2000 });
		teardown.push(async () => link.close());

		let caught;
		try {
			await api.fresh.leaf();
		} catch (err) {
			caught = err;
		}
		expect(caught.code).toBe(CODES.REMOTE);
		expect(caught.remoteCode).toBe(CODES.CLOSED);
		// And the link really is still open — the spoof did not describe reality.
		expect(typeof api.fresh.leaf).toBe("function");
	});
});

describe("finding 4 — a unicode-named leaf crosses the vine, and declined leaves are reported", () => {
	it("serves, mounts and calls a leaf whose export name is non-ASCII", async () => {
		const serveApi = await instance(REGRESSION_DIR);
		const growApi = await instance(GROW_DIR);

		const records = await serveApi.slothlet.api.leaves(".", { details: true });
		expect(records.some((record) => record.path === "intl.café" && record.kind === "function")).toBe(true);

		const [near, far] = createPair();
		const serving = await serve(serveApi, far, { paths: ["intl"] });
		teardown.push(async () => serving.close());
		expect(serving.leaves).toEqual(["intl.café", "intl.ok"]);

		const link = await grow(growApi, near, { handshakeMs: 5000, budgetMs: 2000 });
		teardown.push(async () => link.close());
		expect(link.leaves).toEqual(["intl.café", "intl.ok"]);
		expect(await growApi.intl["café"]()).toBe("coffee");
	});

	it("reports leaves the paths filter declined on serving.excluded", async () => {
		const serveApi = await instance(REGRESSION_DIR);
		const [, far] = createPair();
		const serving = await serve(serveApi, far, { paths: ["intl"] });
		teardown.push(async () => serving.close());

		expect(serving.excluded).toEqual(["factory.make", "factory.nested", "factory.plain", "factory.receive"]);
		expect(serving.excluded.some((leaf) => serving.leaves.includes(leaf))).toBe(false);
	});

	it("reports leaves the safety guard declined on serving.excluded", async () => {
		const api = {
			slothlet: {
				api: {
					async leaves() {
						return [
							{ path: "math.add", kind: "function" },
							{ path: "slothlet.api.remove", kind: "function" },
							{ path: "__proto__.pwn", kind: "function" },
							{ path: "math.answer", kind: "data" }
						];
					}
				}
			}
		};
		const [, far] = createPair();
		const serving = await serve(api, far);
		expect(serving.leaves).toEqual(["math.add"]);
		// Refused callable leaves are visible; a data record was never a candidate and is not "excluded".
		expect(serving.excluded).toEqual(["__proto__.pwn", "slothlet.api.remove"]);
		expect(serving.excluded).not.toContain("math.answer");
	});
});

describe("finding 5 — data-only is enforced on RETURN values, not only arguments", () => {
	/**
	 * Wire a real serve of the regression fixtures to a real grow.
	 * @returns {Promise<object>} The growing instance.
	 */
	async function wired() {
		const serveApi = await instance(REGRESSION_DIR);
		const growApi = await instance(GROW_DIR);
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		teardown.push(async () => serving.close());
		const link = await grow(growApi, near, { handshakeMs: 5000, budgetMs: 2000 });
		teardown.push(async () => link.close());
		return growApi;
	}

	it("refuses a leaf that returns a bare function instead of delivering the closure", async () => {
		const growApi = await wired();
		let caught;
		try {
			await growApi.factory.make();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		// Serve-side vine errors cross as remote errors like any other, so the vine code lands on
		// `.remoteCode` (finding 3's remapping) — `.code` says only "this came from over there".
		expect(caught.remoteCode).toBe(CODES.DATA_ONLY);
		expect(caught.code).toBe(CODES.REMOTE);
		expect(caught.message).toContain("data-only");
	});

	it("finds a function buried in the returned graph and names where it was", async () => {
		const growApi = await wired();
		await expect(growApi.factory.nested()).rejects.toThrow(/value\.deep\.onDone/);
	});

	it("still returns ordinary data untouched", async () => {
		const growApi = await wired();
		expect(await growApi.factory.plain()).toEqual({ ok: 1, list: [1, 2, 3] });
	});
});

describe("finding 6 — answering a call does not corrupt the served instance's records", () => {
	it("keeps a called leaf reported as a callable leaf, with no Function.prototype members", async () => {
		const serveApi = await instance(REGRESSION_DIR);
		const growApi = await instance(GROW_DIR);
		const [near, far] = createPair();
		const first = await serve(serveApi, far, { paths: ["intl"] });
		teardown.push(async () => first.close());
		const link = await grow(growApi, near, { handshakeMs: 5000, budgetMs: 2000 });
		teardown.push(async () => link.close());

		expect(await growApi.intl["café"]()).toBe("coffee");

		// A `leaf.apply(parent, args)` dispatch would have turned `intl.café` into a NAMESPACE owning
		// `intl.café.apply`, and this second serve would publish that instead of the leaf itself.
		const [, other] = createPair();
		const second = await serve(serveApi, other, { paths: ["intl"] });
		teardown.push(async () => second.close());
		expect(second.leaves).toEqual(["intl.café", "intl.ok"]);
		expect(second.leaves.some((leaf) => /\.(apply|call|bind)$/.test(leaf))).toBe(false);
	});
});

describe("finding 8a — mounting stops when the far side dies mid-mount", () => {
	it("mounts nothing further and reports the rest as skipped", async () => {
		let fireClose = null;
		let added = 0;
		const channel = {
			send() {},
			onMessage(handler) {
				handler({ type: "surface", v: 1, leaves: ["a.one", "b.two", "c.three"] });
			},
			onClose(handler) {
				fireClose = handler;
			}
		};
		const api = {
			slothlet: {
				api: {
					async add() {
						// The peer dies while the mount loop is still walking the manifest.
						if (++added === 1) fireClose({ reason: "peer-died" });
					},
					async remove() {},
					async leaves() {
						return [];
					}
				}
			}
		};

		const link = await grow(api, channel, { handshakeMs: 1000, budgetMs: 1000 });
		expect(added).toBe(1);
		expect(link.leaves).toEqual(["a.one"]);
		expect(link.skipped).toEqual(["b.two", "c.three"]);
		await expect(link.closed).resolves.toMatchObject({ reason: "gone" });
	});
});

describe("finding 8b — handshakeMs has explicit semantics, never a silent forever-wait", () => {
	/**
	 * A channel that never publishes a surface.
	 * @returns {object} The silent channel.
	 */
	function silent() {
		return { send() {}, onMessage() {} };
	}

	/**
	 * A slothlet stand-in with nothing mounted.
	 * @returns {object} The fake api.
	 */
	function bareApi() {
		return {
			slothlet: {
				api: {
					async add() {},
					async remove() {},
					async leaves() {
						return [];
					}
				}
			}
		};
	}

	it.each([
		["null", null],
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["a string", "50"]
	])("falls back to the default budget for %s rather than waiting forever", async (_label, handshakeMs) => {
		const started = Date.now();
		await expect(grow(bareApi(), silent(), { budgetMs: 40, handshakeMs })).rejects.toMatchObject({ code: CODES.BUDGET, budgetMs: 40 });
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("treats Infinity as the documented opt-out and keeps waiting", async () => {
		const growing = grow(bareApi(), silent(), { budgetMs: 30, handshakeMs: Number.POSITIVE_INFINITY });
		const raced = await Promise.race([growing.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 200))]);
		expect(raced).toBe("pending");
	});
});

describe("finding 8c — a hostile error frame still settles the call it belongs to", () => {
	it("rejects immediately instead of degrading to a budget wait", async () => {
		const api = await instance(GROW_DIR);
		const [near, far] = createPair();
		far.send({ type: "surface", v: 1, leaves: ["fresh.leaf"] });
		far.onMessage((frame) => {
			if (frame?.type !== "call") return;
			far.send({
				type: "error",
				callId: frame.callId,
				error: {
					get name() {
						throw new Error("gotcha");
					},
					get message() {
						throw new Error("gotcha");
					},
					get code() {
						throw new Error("gotcha");
					},
					get stack() {
						throw new Error("gotcha");
					}
				}
			});
		});

		const link = await grow(api, near, { handshakeMs: 5000, budgetMs: 5000 });
		teardown.push(async () => link.close());

		const started = Date.now();
		let caught;
		try {
			await api.fresh.leaf();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.code).toBe(CODES.REMOTE);
		expect(caught.name).toBe("Error");
		expect(caught.message).toBe("");
		// The point of the fix: this settled on the frame, not on the 5s budget.
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe("finding 8d — close() releases the receive closure", () => {
	it("re-registers a handler that is no longer the link's, and ignores later frames", async () => {
		/** @type {Function[]} */
		const handlers = [];
		const channel = {
			send() {},
			onMessage(handler) {
				handlers.push(handler);
				if (handlers.length === 1) handler({ type: "surface", v: 1, leaves: ["far.leaf"] });
			}
		};
		const api = {
			slothlet: {
				api: {
					async add() {},
					async remove() {},
					async leaves() {
						return [];
					}
				}
			}
		};

		const link = await grow(api, channel, { handshakeMs: 1000, budgetMs: 1000 });
		expect(handlers).toHaveLength(1);

		await link.close();
		expect(handlers).toHaveLength(2);
		expect(handlers[1]).not.toBe(handlers[0]);
		// The replacement is inert: a late frame is neither answered nor thrown into the transport.
		expect(() => handlers[1]({ type: "result", callId: "whatever", value: 1 })).not.toThrow();
	});
});

describe("finding 9 — data-only is enforced on ARGUMENTS serve-side too, not only grow-side", () => {
	it("refuses a call frame built directly against the channel, before the leaf ever runs", async () => {
		// vineStub already refuses a function-bearing argument before it ever sends a frame (grow.mjs),
		// but that only covers frames a legitimate vineStub call built. Nothing stops a frame
		// constructed directly against the channel — possible only over a by-reference transport like
		// loopback, where no serialization step would otherwise refuse a live function reference — from
		// reaching serve() with a function hiding in `args`. This bypasses vineStub entirely to prove
		// serve() itself is the backstop.
		const serveApi = await instance(REGRESSION_DIR);
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		teardown.push(() => serving.close());

		const reply = await new Promise((resolve) => {
			near.onMessage((frame) => {
				if (frame.type !== "surface") resolve(frame);
			});
			near.send({ type: "call", callId: "hostile", path: "factory.receive", args: [1, () => "should never run"] });
		});

		expect(reply.type).toBe("error");
		expect(reply.error.code).toBe(CODES.DATA_ONLY);
		expect(reply.error.message).toContain("data-only");
		expect(reply.error.message).toContain("arg[1]");
	});

	it("still answers a call whose arguments are ordinary data", async () => {
		const serveApi = await instance(REGRESSION_DIR);
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		teardown.push(() => serving.close());

		const reply = await new Promise((resolve) => {
			near.onMessage((frame) => {
				if (frame.type !== "surface") resolve(frame);
			});
			near.send({ type: "call", callId: "clean", path: "factory.receive", args: [{ nested: [1, 2, 3] }] });
		});

		expect(reply.type).toBe("result");
		expect(reply.value).toEqual({ ran: true, value: { nested: [1, 2, 3] } });
	});
});

/**
 * A slothlet stand-in with nothing mounted — enough surface for grow() to mount and unmount against.
 * @returns {object} The fake api.
 */
function bareGrowApi() {
	return {
		slothlet: {
			api: {
				async add() {},
				async remove() {},
				async leaves() {
					return [];
				}
			}
		}
	};
}

describe("finding 10a — close() also releases the onClose registration, not only onMessage", () => {
	it("re-registers a channel.onClose handler that is no longer the link's", async () => {
		/** @type {Function[]} */
		const messageHandlers = [];
		/** @type {Function[]} */
		const closeHandlers = [];
		const channel = {
			send() {},
			onMessage(handler) {
				messageHandlers.push(handler);
				if (messageHandlers.length === 1) handler({ type: "surface", v: 1, leaves: [] });
			},
			onClose(handler) {
				closeHandlers.push(handler);
			}
		};

		const link = await grow(bareGrowApi(), channel, { handshakeMs: 1000, budgetMs: 1000 });
		expect(closeHandlers).toHaveLength(1);

		await link.close();
		expect(closeHandlers).toHaveLength(2);
		expect(closeHandlers[1]).not.toBe(closeHandlers[0]);
		// The replacement is inert: a late far-side-death notification is neither acted on nor thrown.
		expect(() => closeHandlers[1]({ reason: "peer-closed" })).not.toThrow();
	});
});

describe("finding 10b — a failed handshake releases the channel registrations too, since no link is ever returned to close", () => {
	it("re-registers inert onMessage/onClose handlers when the handshake budget expires", async () => {
		/** @type {Function[]} */
		const messageHandlers = [];
		/** @type {Function[]} */
		const closeHandlers = [];
		const channel = {
			send() {},
			onMessage(handler) {
				messageHandlers.push(handler);
			},
			onClose(handler) {
				closeHandlers.push(handler);
			}
		};

		await expect(grow(bareGrowApi(), channel, { budgetMs: 30, handshakeMs: 30 })).rejects.toMatchObject({ code: CODES.BUDGET });

		expect(messageHandlers).toHaveLength(2);
		expect(messageHandlers[1]).not.toBe(messageHandlers[0]);
		expect(() => messageHandlers[1]({ type: "result", callId: "x", value: 1 })).not.toThrow();

		expect(closeHandlers).toHaveLength(2);
		expect(closeHandlers[1]).not.toBe(closeHandlers[0]);
		expect(() => closeHandlers[1]({ reason: "peer-closed" })).not.toThrow();
	});

	it("releases the registrations when the far side is gone before the surface arrives too", async () => {
		/** @type {Function[]} */
		const messageHandlers = [];
		/** @type {Function[]} */
		const closeHandlers = [];
		const channel = {
			send() {},
			onMessage(handler) {
				messageHandlers.push(handler);
			},
			onClose(handler) {
				closeHandlers.push(handler);
			}
		};

		const growing = grow(bareGrowApi(), channel, { handshakeMs: 1000, budgetMs: 1000 });
		growing.catch(() => {}); // observed below via .rejects — suppress the default unhandled-rejection warning
		expect(closeHandlers).toHaveLength(1);
		closeHandlers[0]({ reason: "peer-closed" }); // the far side dies before publishing its surface

		await expect(growing).rejects.toMatchObject({ code: CODES.GONE });
		expect(messageHandlers).toHaveLength(2);
		expect(messageHandlers[1]).not.toBe(messageHandlers[0]);
		expect(closeHandlers).toHaveLength(2);
		expect(closeHandlers[1]).not.toBe(closeHandlers[0]);
	});
});

describe("finding 11 — transport/process's close() tolerates a target without removeListener/off", () => {
	it("does not throw when the wrapped object lacks removeListener entirely", () => {
		const proc = {
			connected: true,
			send(message, cb) {
				if (typeof cb === "function") cb(null);
				return true;
			},
			on() {}
			// No removeListener, no off. createParentChannel's contract (see its own JSDoc) is
			// documented as send()+on() only, and `proc` is explicitly test-double-friendly.
		};

		const child = createParentChannel(proc);
		expect(() => child.close()).not.toThrow();
	});

	it("tolerates a removeListener that throws, and still detaches the rest", () => {
		const attempted = [];
		const proc = {
			connected: true,
			send() {
				return true;
			},
			on() {},
			removeListener(event) {
				attempted.push(event);
				throw new Error("hostile removeListener");
			}
		};

		const child = createParentChannel(proc);
		expect(() => child.close()).not.toThrow();
		// Both removals were attempted despite each one throwing — one bad removal must not skip the rest.
		expect(attempted).toEqual(expect.arrayContaining(["message", "disconnect"]));
	});

	it("prefers off over removeListener when both exist", () => {
		const viaOff = [];
		const viaRemoveListener = [];
		const proc = {
			connected: true,
			send() {
				return true;
			},
			on() {},
			off(event) {
				viaOff.push(event);
			},
			removeListener(event) {
				viaRemoveListener.push(event);
			}
		};

		const child = createParentChannel(proc);
		child.close();
		expect(viaOff.length).toBeGreaterThan(0);
		expect(viaRemoveListener).toEqual([]);
	});
});
