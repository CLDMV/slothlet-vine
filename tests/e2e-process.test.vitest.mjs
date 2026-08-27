/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-process.test.vitest.mjs
 *
 * The process (child_process IPC) transport: the shared Channel conformance suite PLUS the full e2e
 * bar from `docs/DESIGN.md`, the latter over a REAL forked child process.
 *
 * ## Two boundaries, on purpose
 *
 * - **Conformance** runs against an IN-MEMORY duplex that mimics the exact surface the transport
 *   consumes — `send(msg, cb)`, `on("message"|"exit"|"disconnect"|"error")`, `connected`,
 *   `disconnect()` — with structured-clone delivery on `setImmediate` (advanced-serialization
 *   fidelity, asynchronous like a real IPC hop). Forking a fresh child for each of the ~15 conformance
 *   cases would be needlessly heavy and slow, and the conformance suite tests the CHANNEL contract, not
 *   the OS boundary; the fake reproduces the surface faithfully, so the contract is exercised honestly.
 *   Both fake ends are wrapped with `createChannel` (the parent-side endpoint) so `close()`/`onClose`
 *   have their disconnecting semantics.
 * - **The 6-point e2e** uses a REAL `fork(...)` with `{ serialization: "advanced" }`: the serve side
 *   boots a real slothlet instance in the child (`tests/fixtures/proc-serve-child.mjs`) and the grow
 *   side runs in this process. Nothing here is faked — killing the child is a real SIGTERM, and the
 *   parent detects the death over the real IPC channel.
 *
 * The child-side endpoint (`createParentChannel`) is covered directly by a specifics test against the
 * fake (attaching it to the real vitest IPC would corrupt vitest's own result channel) and end-to-end
 * inside the real forked child.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import slothlet from "@cldmv/slothlet";

import { grow } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError } from "../src/lib/errors.mjs";
import { channelConformance } from "../src/testing/conformance.mjs";
import { createChannel, createParentChannel } from "../src/transport/process.mjs";

// The SERVE side boots inside the forked child (see fixtures/proc-serve-child.mjs); the grow side —
// and therefore the only slothlet instance this process builds — is the grow-api fixture.
const here = path.dirname(fileURLToPath(import.meta.url));
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const CHILD = path.join(here, "fixtures", "proc-serve-child.mjs");

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * In-memory duplex mimicking the ChildProcess IPC surface, for conformance.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A pair of connected fakes, each mimicking the slice of `ChildProcess` the transport touches. A
 * `send` on one delivers, structured-cloned and on the next `setImmediate`, as a `"message"` event on
 * the other; `disconnect()` on either flips both to disconnected and emits `"disconnect"` on both.
 * @returns {{ a: EventEmitter, b: EventEmitter }} The two fake endpoints.
 */
function makeFakeChildPair() {
	const a = new EventEmitter();
	const b = new EventEmitter();
	a.connected = true;
	b.connected = true;

	/**
	 * @param {EventEmitter} from - Sender.
	 * @param {EventEmitter} to - Receiver.
	 * @returns {(message: object, cb?: (err: Error|null) => void) => boolean} A ChildProcess-like send.
	 */
	function makeSend(from, to) {
		return (message, cb) => {
			if (!from.connected) {
				const err = new Error("channel closed");
				if (typeof cb === "function") setImmediate(() => cb(err));
				else throw err;
				return false;
			}
			// structuredClone mirrors advanced (V8) serialization — a real Date/Map/Set survives the hop.
			const cloned = structuredClone(message);
			setImmediate(() => {
				if (to.connected) to.emit("message", cloned);
			});
			if (typeof cb === "function") setImmediate(() => cb(null));
			return true;
		};
	}

	/**
	 * @returns {void} Flip both ends disconnected and notify both (idempotent).
	 */
	function disconnect() {
		if (!a.connected && !b.connected) return;
		a.connected = false;
		b.connected = false;
		setImmediate(() => {
			a.emit("disconnect");
			b.emit("disconnect");
		});
	}

	a.send = makeSend(a, b);
	b.send = makeSend(b, a);
	a.disconnect = disconnect;
	b.disconnect = disconnect;
	return { a, b };
}

channelConformance(
	"process (in-memory fake)",
	() => {
		const { a, b } = makeFakeChildPair();
		return [createChannel(a), createChannel(b)];
	},
	{ describe, it, expect }
);

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Transport specifics — validation + the child-side endpoint against the fake.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** @returns {Promise<void>} Let queued setImmediate deliveries run. */
function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("process transport specifics", () => {
	it("declares its capabilities", () => {
		const { a } = makeFakeChildPair();
		expect(createChannel(a).capabilities).toEqual({ structuredClone: true, codec: "none", buffersUntilHandler: false });
	});

	it("rejects a non-ChildProcess to createChannel", () => {
		expect(() => createChannel(null)).toThrow(TypeError);
		expect(() => createChannel({})).toThrow(TypeError);
		expect(() => createChannel({ send() {} })).toThrow(TypeError);
	});

	it("rejects a process without an IPC channel to createParentChannel", () => {
		expect(() => createParentChannel({})).toThrow(TypeError);
		expect(() => createParentChannel(null)).toThrow(TypeError);
	});

	it("child endpoint sends, receives, and detects the parent disconnecting", async () => {
		const { a, b } = makeFakeChildPair();
		const parent = createChannel(a);
		const child = createParentChannel(b);

		const got = [];
		child.onMessage((m) => got.push(m));
		let closedInfo;
		child.onClose((info) => {
			closedInfo = info;
		});

		parent.send({ type: "surface", v: 1, leaves: ["x.y"] });
		await tick();
		expect(got).toHaveLength(1);
		expect(got[0].leaves).toEqual(["x.y"]);

		// The parent tears down → the child learns of it via onClose. The child's own close() detaches
		// without touching the channel and a send afterwards is a silent no-op.
		parent.close();
		await tick();
		expect(closedInfo).toBeTruthy();
		expect(() => child.close()).not.toThrow();
		expect(() => child.close()).not.toThrow();
		expect(() => child.send({ type: "call", callId: "z", path: "x.y", args: [] })).not.toThrow();
	});

	it("surfaces a send onto a dead channel through onClose rather than throwing", async () => {
		const { a, b } = makeFakeChildPair();
		const parent = createChannel(a);
		let closedInfo;
		parent.onClose((info) => {
			closedInfo = info;
		});
		b.disconnect(); // both ends now disconnected
		await tick();
		expect(() => parent.send({ type: "call", callId: "1", path: "p", args: [] })).not.toThrow();
		expect(closedInfo).toBeTruthy();
	});

	it("treats the child's 'error' event as far-side death", () => {
		const { a } = makeFakeChildPair();
		const parent = createChannel(a);
		let closedInfo;
		parent.onClose((info) => {
			closedInfo = info;
		});
		a.emit("error", new Error("spawn failed")); // a real ChildProcess error event
		expect(closedInfo).toMatchObject({ reason: "error" });
		expect(closedInfo.error).toBeInstanceOf(Error);
	});

	it("RETHROWS a synchronous serialization refusal without firing onClose (per-call, not link death)", () => {
		// child.send throws synchronously with NO dead-channel code when the V8 serializer rejects a
		// value (a Symbol, a value hiding a function). That is a per-call fault: the transport must let
		// it propagate so the core settles just that call VINE_BAD_FRAME — and must NOT declare the link
		// dead. (The whole-link-death behavior this replaces was the final-review defect.)
		const target = new EventEmitter();
		target.connected = true;
		target.send = () => {
			throw new TypeError("could not be cloned"); // no .code — a serializer refusal, not a dead channel
		};
		const channel = createChannel(target);
		let closedInfo;
		channel.onClose((info) => {
			closedInfo = info;
		});
		expect(() => channel.send({ type: "call", callId: "1", path: "p", args: [] })).toThrow(/could not be cloned/);
		expect(closedInfo).toBeUndefined(); // the link is NOT gone — only that one frame was refused
	});

	it("surfaces a DEAD-channel send throw through onClose, without rethrowing", () => {
		// A send throw carrying a dead-channel code (ERR_IPC_CHANNEL_CLOSED / EPIPE) is real link death:
		// the transport swallows it and reports it through onClose, so a caller that only ever sends
		// still learns the link is gone.
		const target = new EventEmitter();
		target.connected = true;
		target.send = () => {
			const err = new Error("channel closed");
			err.code = "ERR_IPC_CHANNEL_CLOSED";
			throw err;
		};
		const channel = createChannel(target);
		let closedInfo;
		channel.onClose((info) => {
			closedInfo = info;
		});
		expect(() => channel.send({ type: "call", callId: "1", path: "p", args: [] })).not.toThrow();
		expect(closedInfo).toMatchObject({ reason: "error" });
		expect(closedInfo.error.code).toBe("ERR_IPC_CHANNEL_CLOSED");
	});

	it("reports an ASYNCHRONOUS delivery failure (the send callback's err) as far-side death", async () => {
		// Reached only asynchronously, on a channel that closed under us AFTER the synchronous send
		// returned — distinct from the synchronous serialization-refusal throw covered above, and
		// unconditionally death (no classification: the comment on process.mjs's send() explains why).
		const target = new EventEmitter();
		target.connected = true;
		target.send = (message, cb) => {
			setImmediate(() => cb(new Error("delivery failed")));
		};
		const channel = createChannel(target);
		let closedInfo;
		channel.onClose((info) => {
			closedInfo = info;
		});
		channel.send({ type: "call", callId: "1", path: "p", args: [] });
		await tick();
		expect(closedInfo).toMatchObject({ reason: "error" });
		expect(closedInfo.error).toBeInstanceOf(Error);
	});

	it("ignores a non-function onMessage/onClose registration", () => {
		const { a } = makeFakeChildPair();
		const parent = createChannel(a);
		expect(() => parent.onMessage(123)).not.toThrow();
		expect(() => parent.onClose("nope")).not.toThrow();
	});

	it("child-side close() does not disconnect the shared IPC channel (leaves it to the parent)", () => {
		// Ownership: the parent already learns of the child's exit on its own 'exit' event, so the
		// child need not — and must not — tear down the channel itself. This is the ROOT CAUSE of the
		// child side's close() not notifying the parent.
		const proc = new EventEmitter();
		proc.connected = true;
		proc.send = () => {};
		proc.disconnect = () => {
			throw new Error("child must not disconnect the shared IPC channel");
		};
		const child = createParentChannel(proc);
		expect(() => child.close()).not.toThrow();
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The e2e bar over a REAL forked child.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Instances, links and children to tear down after each test. @type {Array<() => Promise<void>|void>} */
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
 * Stand up a full vine over a real forked child: the serving instance boots inside the child
 * (fixture `proc-serve-child.mjs`), the growing instance runs here, linked over the process IPC
 * channel. The child is forked with advanced serialization, as a real consumer must.
 * @param {object} [options]
 * @param {object} [options.permissions] - Permission config for the GROW-side instance.
 * @param {object} [options.growOptions] - Options forwarded to `grow()`.
 * @returns {Promise<{growApi: object, link: object, child: import("node:child_process").ChildProcess}>}
 */
async function wire({ permissions, growOptions } = {}) {
	const growApi = await slothlet({ base: GROW_DIR, silent: true, ...(permissions ? { permissions } : {}) });
	const child = fork(CHILD, [], { serialization: "advanced" });
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});
	teardown.push(() => {
		if (child.connected || child.exitCode === null) child.kill();
	});

	const channel = createChannel(child);
	const link = await grow(growApi, channel, { budgetMs: 5000, ...growOptions });
	teardown.push(async () => {
		await link.close();
	});
	return { growApi, link, child };
}

describe("e2e over process — the served surface", () => {
	it("mounts the far surface at identical dotted paths", async () => {
		const { growApi, link } = await wire();
		expect(link.leaves).toEqual(["math.add", "tools.boom", "tools.echo", "tools.secret", "tools.secretCallCount", "tools.slow"]);
		expect(link.leaves.some((leaf) => leaf.startsWith("slothlet"))).toBe(false);
		expect(typeof growApi.math.add).toBe("function");
		expect(typeof growApi.tools.echo).toBe("function");
	});
});

describe("e2e over process — point 1: sync + async round-trips", () => {
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

	it("keeps concurrent calls correlated across the boundary", async () => {
		const { growApi } = await wire();
		const results = await Promise.all([growApi.math.add(1, 1), growApi.tools.echo("a"), growApi.math.add(10, 5), growApi.tools.echo("b")]);
		expect(results).toEqual([2, "echo:a", 15, "echo:b"]);
	});
});

describe("e2e over process — point 2: remote errors re-throw as VineRemoteError", () => {
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

describe("e2e over process — point 3: slothlet's permission gate covers mounted stubs", () => {
	it("denies a module's call to a denied stub, and the call never reaches the far side", async () => {
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

		// The gate fires before the stub body runs, so nothing crossed the boundary — the far side's own
		// counter, read back over the same vine, is the proof.
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

describe("e2e over process — point 4: VINE_BUDGET", () => {
	it("settles a slow call with VINE_BUDGET and ignores the late result", async () => {
		// budgetMs is the per-CALL budget; handshakeMs is kept generous because a real fork + slothlet
		// boot takes far longer than 50ms to publish its surface (unlike the in-process loopback).
		const { growApi, link } = await wire({ growOptions: { budgetMs: 50, handshakeMs: 5000 } });
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

		// The far side answers later; settle-once drops the frame and the link stays sane.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await growApi.math.add(1, 1)).toBe(2);
		expect(link.leaves).toContain("tools.slow");
	});

	it("does not fire the budget for a call that answers in time", async () => {
		const { growApi } = await wire({ growOptions: { budgetMs: 2000 } });
		expect(await growApi.tools.slow(20)).toBe("slow:20");
	});
});

describe("e2e over process — point 5: killing the child settles in-flight calls with VINE_GONE", () => {
	it("settles pending calls and resolves link.closed when the child is killed mid-call", async () => {
		const { growApi, link, child } = await wire({ growOptions: { budgetMs: 10_000 } });
		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 50));

		child.kill(); // real SIGTERM — the child dies with the call still in flight

		await expect(inFlight).rejects.toMatchObject({ code: CODES.GONE });
		await expect(link.closed).resolves.toMatchObject({ reason: "gone" });
	});

	it("fails a call made after the child died, without waiting for a budget", async () => {
		const { growApi, child } = await wire({ growOptions: { budgetMs: 10_000 } });
		child.kill();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const started = Date.now();
		await expect(growApi.math.add(1, 1)).rejects.toMatchObject({ code: CODES.GONE });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("e2e over process — point 6: link.close() unmounts and settles VINE_CLOSED", () => {
	it("removes the stubs from the api and settles in-flight calls", async () => {
		const { growApi, link } = await wire({ growOptions: { budgetMs: 10_000 } });
		expect(typeof growApi.tools.echo).toBe("function");

		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 50));
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
