/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-post-message.test.vitest.mjs
 *
 * The post-message transport against BOTH the shared Channel conformance suite AND the full e2e bar
 * from `docs/DESIGN.md`, run over a REAL structured-clone postMessage boundary.
 *
 * ## The boundary, and why it is faithful
 *
 * Both the conformance pair and the e2e link ride a node `worker_threads` `MessageChannel`
 * (`{ port1, port2 }`). Unlike loopback — which passes frames BY REFERENCE inside one realm — a
 * `worker_threads` MessageChannel serializes every frame with the structured-clone algorithm even
 * when both ports live on the same thread: the receiver gets a COPY (verified: `ev.data !== sent`),
 * `Date`/`Map` survive, and a frame containing a function throws `DataCloneError` at `postMessage`
 * exactly as it would across a real worker. Delivery is genuinely asynchronous (a macrotask), and
 * the port's own `message`/`close` events are the real ones the transport wraps in production. It is
 * the SAME port surface a browser `Worker`, a browser `MessagePort`, and a real `worker_threads`
 * `Worker` expose — so a same-thread MessageChannel exercises the transport's cloning boundary and
 * async delivery without the extra process a real `Worker` would add, and (the point that decides it
 * for the death test) node's MessagePort propagates a `'close'` to the peer, giving point 5 a real
 * far-side-death signal to settle on.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError } from "../src/lib/errors.mjs";
import { createChannel } from "../src/transport/post-message.mjs";
import { channelConformance } from "../src/testing/conformance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(here, "fixtures", "serve-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const REGRESSION_DIR = path.join(here, "fixtures", "regression-api");

// ── Channel conformance ────────────────────────────────────────────────────────────────────────
// A fresh MessageChannel per pair; the harness closes both ends (which closes the ports) itself.
channelConformance(
	"post-message (worker_threads MessageChannel)",
	() => {
		const { port1, port2 } = new MessageChannel();
		return { a: createChannel(port1), b: createChannel(port2) };
	},
	{ describe, it, expect }
);

// ── e2e over the real port boundary ──────────────────────────────────────────────────────────────

/** Instances, links and ports to tear down after each test. @type {Array<() => Promise<void>>} */
let teardown = [];

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

/**
 * Stand up a full vine over a worker_threads MessageChannel: a serving instance from `serveDir`, a
 * growing instance from the grow fixtures, and a link between them. `grow()` is started BEFORE
 * `serve()` runs so its receive handler is registered before the surface frame is posted — the
 * post-message transport declares `buffersUntilHandler: false`, so a surface delivered before the
 * handler exists would be dropped rather than replayed.
 * @param {object} [options]
 * @param {object} [options.permissions] - Permission config for the GROW-side instance.
 * @param {object} [options.growOptions] - Options forwarded to `grow()`.
 * @param {object} [options.serveOptions] - Options forwarded to `serve()`.
 * @param {string} [options.serveDir] - Which serve fixture directory to load.
 * @returns {Promise<{serveApi: object, growApi: object, link: object, serving: object, near: object, far: object}>} The wired pair.
 */
async function wire({ permissions, growOptions, serveOptions, serveDir = SERVE_DIR } = {}) {
	// Every teardown is registered IMMEDIATELY after the resource it tears down is created — not
	// batched at the end — so a failure partway through (e.g. serve()/grow() throwing) still lets
	// everything already created be torn down instead of leaking until afterAll's backstop.
	const serveApi = await slothlet({ base: serveDir, silent: true });
	teardown.push(async () => {
		await serveApi.slothlet?.shutdown?.();
	});
	const growApi = await slothlet({ base: GROW_DIR, silent: true, ...(permissions ? { permissions } : {}) });
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});

	const { port1, port2 } = new MessageChannel();
	const near = createChannel(port1);
	const far = createChannel(port2);
	teardown.push(() => {
		near.close();
		far.close();
	});

	// grow() is started BEFORE serve() so its receive handler is registered before the surface frame
	// is posted (see the file header) — .catch a no-op here so a later serve() throw cannot leave this
	// promise unhandled; `link = await growing` below still observes the real outcome.
	const growing = grow(growApi, near, { budgetMs: 5000, ...growOptions });
	growing.catch(() => {});
	const serving = await serve(serveApi, far, serveOptions);
	teardown.push(() => {
		serving.close();
	});
	const link = await growing;
	teardown.push(async () => {
		await link.close();
	});
	return { serveApi, growApi, link, serving, near, far };
}

describe("e2e over post-message — a handshake failure still lets every already-created resource be torn down", () => {
	it("does not leak the ports or the slothlet instances when grow() never sees a surface", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		const { port1, port2 } = new MessageChannel();
		const near = createChannel(port1);
		const far = createChannel(port2);
		// Deliberately never serve() the far port — grow()'s handshake has nothing to receive and must
		// fail on its own budget rather than hang.

		let caught;
		try {
			await grow(growApi, near, { handshakeMs: 50 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineError);
		expect(caught.code).toBe(CODES.BUDGET);

		// Every resource created before the failure is still cleanly disposable — the property wire()'s
		// own eager teardown registration now guarantees on every path, not just the success path.
		near.close();
		far.close();
		await serveApi.slothlet.shutdown();
		await growApi.slothlet.shutdown();
	});
});

describe("e2e over post-message — the served surface", () => {
	it("publishes only CALLABLE leaves and mounts them at identical paths", async () => {
		const { serving, link, growApi } = await wire();
		expect(serving.leaves).toEqual(["math.add", "tools.boom", "tools.echo", "tools.secret", "tools.secretCallCount", "tools.slow"]);
		expect(serving.leaves).not.toContain("math.answer");
		expect(link.leaves).toEqual(serving.leaves);
		expect(link.skipped).toEqual([]);
		expect(link.collisions).toEqual([]);
		expect(typeof growApi.math.add).toBe("function");
		expect(typeof growApi.tools.echo).toBe("function");
	});
});

describe("e2e over post-message — point 1: sync + async round-trips", () => {
	it("returns the right value for a sync far leaf", async () => {
		const { growApi } = await wire();
		expect(await growApi.math.add(2, 3)).toBe(5);
	});

	it("returns the right value for an async far leaf", async () => {
		const { growApi } = await wire();
		expect(await growApi.tools.echo("hi")).toBe("echo:hi");
	});

	it("round-trips through a real MODULE caller, not just the host handle", async () => {
		const { growApi } = await wire();
		expect(await growApi.caller.echo("via-self")).toBe("echo:via-self");
	});

	it("keeps concurrent calls correlated across the clone boundary", async () => {
		const { growApi } = await wire();
		const results = await Promise.all([growApi.math.add(1, 1), growApi.tools.echo("a"), growApi.math.add(10, 5), growApi.tools.echo("b")]);
		expect(results).toEqual([2, "echo:a", 15, "echo:b"]);
	});

	it("refuses a function ARGUMENT at the edge, before anything is posted (VINE_DATA_ONLY)", async () => {
		const { growApi } = await wire();
		await expect(growApi.tools.echo({ onDone: () => {} })).rejects.toMatchObject({
			code: CODES.DATA_ONLY,
			path: "tools.echo",
			location: "arg[0].onDone"
		});
	});
});

describe("e2e over post-message — point 2: remote errors re-throw as VineRemoteError", () => {
	it("preserves the far error's name, message and code", async () => {
		const { growApi } = await wire();
		let caught;
		try {
			await growApi.tools.boom();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.name).toBe("BoomError");
		expect(caught.message).toBe("kaboom from the far side");
		expect(caught.code).toBe("E_BOOM");
		expect(caught.remoteStack).toContain("kaboom from the far side");
	});
});

describe("e2e over post-message — point 3: slothlet's permission gate covers mounted stubs", () => {
	it("denies a module's call to a denied stub, and the call never crosses the boundary", async () => {
		const { growApi } = await wire({
			permissions: { defaultPolicy: "allow", rules: [{ caller: "caller.**", target: "tools.secret", effect: "deny" }] }
		});

		let caught;
		try {
			await growApi.caller.secret();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(caught.code).toBe("PERMISSION_DENIED");
		expect(caught).not.toBeInstanceOf(VineError);

		// The gate fires BEFORE the stub body runs, so nothing was posted: the far side's own counter,
		// read back over the same vine, is the proof.
		expect(await growApi.tools.secretCallCount()).toBe(0);

		// A leaf the same caller IS permitted to reach still works — the deny is targeted.
		expect(await growApi.caller.echo("ok")).toBe("echo:ok");
		expect(await growApi.tools.secretCallCount()).toBe(0);
	});

	it("lets the same call through when no rule denies it", async () => {
		const { growApi } = await wire({ permissions: { defaultPolicy: "allow", rules: [] } });
		expect(await growApi.caller.secret()).toBe("top-secret");
		expect(await growApi.tools.secretCallCount()).toBe(1);
	});
});

describe("e2e over post-message — point 4: VINE_BUDGET", () => {
	it("settles a slow call with VINE_BUDGET and ignores the late result", async () => {
		const { growApi, link } = await wire({ growOptions: { budgetMs: 50 } });
		let caught;
		try {
			await growApi.tools.slow(400);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineError);
		expect(caught.code).toBe(CODES.BUDGET);
		expect(caught.path).toBe("tools.slow");
		expect(caught.budgetMs).toBe(50);

		// The far side answers later; settle-once means the frame is dropped and the link stays sane.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await growApi.math.add(1, 1)).toBe(2);
		expect(link.leaves).toContain("tools.slow");
	});

	it("does not fire the budget for a call that answers in time", async () => {
		const { growApi } = await wire({ growOptions: { budgetMs: 2000 } });
		expect(await growApi.tools.slow(20)).toBe("slow:20");
	});
});

describe("e2e over post-message — point 5: far-side death settles in-flight calls with VINE_GONE", () => {
	it("settles pending calls and resolves link.closed when the far port closes", async () => {
		const { growApi, link, far } = await wire({ growOptions: { budgetMs: 10_000 } });
		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 20));

		far.close(); // closing the serve-side port fires 'close' on the grow-side port

		await expect(inFlight).rejects.toMatchObject({ code: CODES.GONE });
		await expect(link.closed).resolves.toMatchObject({ reason: "gone" });
	});

	it("fails a call made after the far side died, without waiting for a budget", async () => {
		const { growApi, far } = await wire({ growOptions: { budgetMs: 10_000 } });
		far.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const started = Date.now();
		await expect(growApi.math.add(1, 1)).rejects.toMatchObject({ code: CODES.GONE });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("e2e over post-message — point 6: link.close() unmounts and settles VINE_CLOSED", () => {
	it("removes the stubs from the api and settles in-flight calls", async () => {
		const { growApi, link } = await wire({ growOptions: { budgetMs: 10_000 } });
		expect(typeof growApi.tools.echo).toBe("function");

		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await link.close();

		await expect(inFlight).rejects.toMatchObject({ code: CODES.CLOSED });
		expect(growApi.tools).toBeUndefined();
		expect(growApi.math).toBeUndefined();
		await expect(link.closed).resolves.toMatchObject({ reason: "closed" });
	});

	it("is idempotent, and the grow instance's OWN leaves survive", async () => {
		const { growApi, link } = await wire();
		await link.close();
		await link.close();
		expect(typeof growApi.caller.echo).toBe("function");
	});
});

describe("e2e over post-message — data-only return values are rejected serve-side, never posted", () => {
	it("surfaces a function-valued return as VINE_REMOTE / remoteCode VINE_DATA_ONLY (serve rejects before send)", async () => {
		// A raw DataCloneError would prove the frame reached postMessage; instead the serve side finds
		// the function first and answers with an error frame, so grow re-throws it as a remote error.
		const { growApi } = await wire({ serveDir: REGRESSION_DIR });
		let caught;
		try {
			await growApi.factory.make();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.code).toBe(CODES.REMOTE);
		expect(caught.remoteCode).toBe(CODES.DATA_ONLY);
		expect(caught.message).toContain("data-only");
	});

	it("still round-trips ordinary data untouched over the clone boundary", async () => {
		const { growApi } = await wire({ serveDir: REGRESSION_DIR });
		expect(await growApi.factory.plain()).toEqual({ ok: 1, list: [1, 2, 3] });
	});
});

// ── Transport-specific unit assertions (the branches the wired e2e cannot reach on its own) ───────

/**
 * A minimal `addEventListener`-style port whose listeners are captured for direct, manual invocation —
 * so a message/death event can be replayed AFTER `removeEventListener` already ran, reproducing a race
 * (an event already in flight when `close()` synchronously detaches) that a real port cannot be made to
 * reproduce on demand.
 * @returns {{postMessage: Function, addEventListener: Function, removeEventListener: Function, close: Function, _fire: Function, _fireRaced: Function}}
 */
function fakePort() {
	/** @type {Map<string, Set<Function>>} What is actually attached right now. */
	const live = new Map();
	/** @type {Map<string, Function[]>} Every listener ever attached, for racing a removed one. */
	const everAttached = new Map();
	return {
		postMessage() {},
		addEventListener(event, fn) {
			if (!live.has(event)) live.set(event, new Set());
			live.get(event).add(fn);
			if (!everAttached.has(event)) everAttached.set(event, []);
			everAttached.get(event).push(fn);
		},
		removeEventListener(event, fn) {
			live.get(event)?.delete(fn);
		},
		close() {},
		/** Dispatch through the LIVE listener set — an ordinary, currently-attached event. */
		_fire(event, payload) {
			for (const fn of live.get(event) ?? []) fn(payload);
		},
		/** Invoke the most recently attached listener directly, even once removed — the race. */
		_fireRaced(event, payload) {
			const fns = everAttached.get(event) ?? [];
			fns[fns.length - 1]?.(payload);
		}
	};
}

describe("post-message transport specifics", () => {
	it("declares its capabilities on both ends", () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1);
		const b = createChannel(port2);
		for (const channel of [a, b]) {
			expect(channel.capabilities).toEqual({ structuredClone: true, codec: "none", buffersUntilHandler: false });
		}
		a.close();
		b.close();
	});

	it("rejects a non-port with a TypeError", () => {
		expect(() => createChannel(null)).toThrow(TypeError);
		expect(() => createChannel({})).toThrow(TypeError);
		expect(() => createChannel({ postMessage: 7 })).toThrow(TypeError);
	});

	it("rejects an EventEmitter-shaped port (postMessage + on, no addEventListener) — e.g. a node Worker handle", () => {
		// No addEventListener AND a real .on() is exactly a node worker_threads Worker's shape: it
		// would otherwise fall into the legacy onmessage= branch, which Node's Worker never reads —
		// every inbound frame silently dropped forever with no error anywhere.
		expect(() =>
			createChannel({
				postMessage() {},
				on() {}
			})
		).toThrow(TypeError);
		expect(() =>
			createChannel({
				postMessage() {},
				on() {}
			})
		).toThrow(/worker_threads Worker handle/);
	});

	it("structured-clones the frame — the receiver gets a copy, not the same reference", async () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1);
		const b = createChannel(port2);
		const sent = { type: "result", callId: "c1", value: { deep: { n: 1 } } };
		const seen = [];
		b.onMessage((m) => seen.push(m));
		a.send(sent);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toBe(sent);
		expect(seen[0]).toEqual(sent);
		a.close();
		b.close();
	});

	it("drops frames that arrive before onMessage is registered (buffersUntilHandler: false)", async () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1);
		const b = createChannel(port2);
		a.send({ type: "result", callId: "early", value: "early" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const seen = [];
		b.onMessage((m) => seen.push(m.callId));
		a.send({ type: "result", callId: "late", value: "late" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual(["late"]);
		a.close();
		b.close();
	});

	it("send() after close is a silent no-op, and close() is idempotent", async () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1);
		const b = createChannel(port2);
		const seen = [];
		b.onMessage((m) => seen.push(m));
		a.close();
		expect(() => a.close()).not.toThrow();
		expect(() => a.send({ type: "result", callId: "c1", value: 1 })).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual([]);
		b.close();
	});

	it("ignores a non-function onMessage / onClose registration", async () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1);
		const b = createChannel(port2);
		expect(() => b.onMessage(null)).not.toThrow();
		expect(() => b.onClose("nope")).not.toThrow();
		a.send({ type: "result", callId: "c1", value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		a.close();
		b.close();
	});

	it("insulates the transport from a throwing receive handler", async () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1);
		const b = createChannel(port2);
		b.onMessage(() => {
			throw new Error("handler blew up");
		});
		expect(() => a.send({ type: "result", callId: "c1", value: 1 })).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const seen = [];
		b.onMessage((m) => seen.push(m.callId));
		a.send({ type: "result", callId: "c2", value: 2 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual(["c2"]);
		a.close();
		b.close();
	});

	it("swallows a postMessage that throws rather than faulting the core", () => {
		let calls = 0;
		const flakyPort = {
			postMessage() {
				calls++;
				throw new Error("port refused the frame");
			},
			addEventListener() {},
			removeEventListener() {},
			close() {}
		};
		const channel = createChannel(flakyPort);
		expect(() => channel.send({ type: "result", callId: "c1", value: 1 })).not.toThrow();
		expect(calls).toBe(1);
		channel.close();
	});

	it("works over a legacy onmessage= port with no addEventListener, and detaches on close", async () => {
		// A port that exposes ONLY the `onX=` setter surface — the fallback path a browser-legacy or
		// minimal port takes. Message delivery must still work; close() must null the setter.
		const listeners = { onmessage: null, onmessageerror: null };
		const legacyPort = {
			postMessage(frame) {
				// Echo the frame back to our own onmessage, wrapped as an event, on the next tick.
				queueMicrotask(() => listeners.onmessage?.({ data: frame }));
			},
			set onmessage(fn) {
				listeners.onmessage = fn;
			},
			get onmessage() {
				return listeners.onmessage;
			},
			set onmessageerror(fn) {
				listeners.onmessageerror = fn;
			},
			get onmessageerror() {
				return listeners.onmessageerror;
			},
			close() {}
		};
		const channel = createChannel(legacyPort);
		const seen = [];
		channel.onMessage((m) => seen.push(m.callId));
		channel.send({ type: "result", callId: "legacy", value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual(["legacy"]);
		expect(typeof listeners.onmessage).toBe("function");
		channel.close();
		expect(listeners.onmessage).toBeNull();
	});

	it("unwraps a raw frame (no event.data wrapper) from a minimal port, and fires its onmessageerror death setter", async () => {
		// A minimal legacy port that hands the frame straight to onmessage — no MessageEvent wrapper —
		// exercises the defensive `: event` fallback, and its onmessageerror setter drives death detection.
		const listeners = { onmessage: null, onmessageerror: null };
		const rawPort = {
			postMessage(frame) {
				queueMicrotask(() => listeners.onmessage?.(frame)); // raw object, no `.data`
			},
			set onmessage(fn) {
				listeners.onmessage = fn;
			},
			get onmessage() {
				return listeners.onmessage;
			},
			set onmessageerror(fn) {
				listeners.onmessageerror = fn;
			},
			get onmessageerror() {
				return listeners.onmessageerror;
			}
			// no close() — close() must tolerate the missing method
		};
		const channel = createChannel(rawPort);
		const seen = [];
		channel.onMessage((m) => seen.push(m.callId));
		channel.send({ type: "result", callId: "raw", value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual(["raw"]);

		let deathReason;
		channel.onClose((info) => {
			deathReason = info?.reason;
		});
		listeners.onmessageerror(); // the medium reports a failed deserialize
		expect(deathReason).toBe("messageerror");
		expect(() => channel.close()).not.toThrow(); // no close() on the port
	});

	it("fires onClose exactly once with the event reason, and lets extra deathEvents opt in", async () => {
		const { port1, port2 } = new MessageChannel();
		const a = createChannel(port1, { deathEvents: ["exit"] }); // union with the defaults; harmless here
		const b = createChannel(port2);
		let fired = 0;
		let reason;
		a.onClose((info) => {
			fired++;
			reason = info?.reason;
		});
		b.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fired).toBe(1);
		expect(reason).toBe("close");
		a.close();
	});

	it("drops a message that arrives after a local close() (a race the listener removal loses)", () => {
		const port = fakePort();
		const channel = createChannel(port);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		channel.close();
		expect(() => port._fireRaced("message", { data: { type: "result", callId: "late", value: 1 } })).not.toThrow();
		expect(seen).toEqual([]);
	});

	it("ignores a death event once already fired, and once already closed", () => {
		// A duplicate/late signal after a REAL close has already been reported.
		const port = fakePort();
		const channel = createChannel(port);
		let fired = 0;
		channel.onClose(() => {
			fired++;
		});
		port._fire("close");
		port._fire("close");
		expect(fired).toBe(1);

		// A death event that was already in flight when a LOCAL close() ran.
		const port2 = fakePort();
		const channel2 = createChannel(port2);
		let fired2 = 0;
		channel2.onClose(() => {
			fired2++;
		});
		channel2.close();
		expect(() => port2._fireRaced("close", undefined)).not.toThrow();
		expect(fired2).toBe(0);
	});

	it("ignores invalid entries in a custom deathEvents list, and still wires the valid ones", () => {
		const port = fakePort();
		const channel = createChannel(port, { deathEvents: [123, "", "custom"] });
		let info;
		channel.onClose((i) => {
			info = i;
		});
		expect(() => port._fire("custom")).not.toThrow();
		expect(info).toMatchObject({ reason: "custom" });
	});
});
