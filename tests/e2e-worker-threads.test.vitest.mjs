/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-worker-threads.test.vitest.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:17-07:00 (1790968817)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect, afterEach } from "vitest";
import { MessageChannel, Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { grow } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError } from "../src/lib/errors.mjs";
import { createChannel, createParentChannel } from "../src/transport/worker-threads.mjs";
import { channelConformance } from "../src/testing/conformance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const WORKER_URL = new URL("./fixtures/wt-serve-worker.mjs", import.meta.url);

// The conformance suite pairs two ports of a real MessageChannel: same process, real structured-clone
// boundary, and it drives the child-side endpoint on the main thread so its code is covered.
channelConformance(
	"worker-threads",
	() => {
		const { port1, port2 } = new MessageChannel();
		return {
			a: createParentChannel(port1),
			b: createParentChannel(port2),
			/** Close both ports so the paired MessageChannel never holds the event loop between cases. @returns {void} */
			cleanup() {
				for (const port of [port1, port2]) {
					try {
						port.close();
					} catch {
						// Already closed by a case exercising close(); teardown must not mask the assertion.
					}
				}
			}
		};
	},
	{ describe, it, expect }
);

/**
 * A minimal EventEmitter standing in for the `postMessage`/`on` surface both worker-threads endpoints
 * consume — for validation and edge cases a real `Worker`/`MessagePort` cannot be made to produce on
 * demand (a non-`DataCloneError` `postMessage` throw, a double death signal, an ownership assertion).
 * @returns {EventEmitter & {postMessage: Function, close: Function, terminate: Function}} The fake target.
 */
function fakeTarget() {
	const target = new EventEmitter();
	target.postMessage = () => {};
	target.close = () => {};
	target.terminate = () => {};
	return target;
}

describe("worker-threads transport specifics", () => {
	it("rejects a non-Worker-shaped target to createChannel", () => {
		expect(() => createChannel(null)).toThrow(TypeError);
		expect(() => createChannel({})).toThrow(TypeError);
		expect(() => createChannel({ postMessage() {} })).toThrow(TypeError); // no on()
	});

	it("rejects createParentChannel() with no usable port (outside a worker, no argument)", () => {
		// On the main thread the ambient parentPort is null — exactly the scenario this guard exists
		// for: the helper called from outside a worker with nothing passed in.
		expect(() => createParentChannel()).toThrow(TypeError);
		expect(() => createParentChannel(null)).toThrow(TypeError);
		expect(() => createParentChannel({})).toThrow(TypeError); // no postMessage/on
	});

	it("parent-side close() detaches listeners but never closes/terminates the wrapped worker", () => {
		// Ownership: the caller made the worker, so only the caller ends it. This is the ROOT CAUSE of
		// the parent side's close() not notifying the far side — the wrapped target is never touched.
		const calls = [];
		const target = fakeTarget();
		target.close = () => calls.push("close");
		target.terminate = () => calls.push("terminate");
		const channel = createChannel(target);
		channel.close();
		expect(calls).toEqual([]);
		expect(() => channel.close()).not.toThrow(); // idempotent
	});

	it("child-side close() DOES close the wrapped port (ownsTarget: true)", () => {
		const calls = [];
		const port = fakeTarget();
		port.close = () => calls.push("close");
		const channel = createParentChannel(port);
		channel.close();
		expect(calls).toEqual(["close"]);
	});

	it("treats the parent-side Worker's 'error' event as far-side death", () => {
		const target = fakeTarget();
		const channel = createChannel(target);
		let info;
		channel.onClose((i) => {
			info = i;
		});
		target.emit("error", new Error("worker crashed"));
		expect(info).toMatchObject({ reason: "error" });
		expect(info.error).toBeInstanceOf(Error);
	});

	it("fires onClose at most once, even when two death events arrive", () => {
		const target = fakeTarget();
		const channel = createChannel(target);
		let fired = 0;
		channel.onClose(() => {
			fired++;
		});
		target.emit("exit", 1);
		target.emit("error", new Error("late — must not double-fire"));
		expect(fired).toBe(1);
	});

	it("ignores a non-function onMessage/onClose registration", () => {
		const target = fakeTarget();
		const channel = createChannel(target);
		expect(() => channel.onMessage(123)).not.toThrow();
		expect(() => channel.onClose("nope")).not.toThrow();
		expect(() => target.emit("message", { type: "result", callId: "c1", value: 1 })).not.toThrow();
		expect(() => target.emit("exit", 0)).not.toThrow();
	});

	it("swallows a postMessage throw that is NOT a DataCloneError (a close race, not a per-call refusal)", () => {
		const target = fakeTarget();
		target.postMessage = () => {
			throw new Error("worker is terminating"); // no .name === "DataCloneError" — a close race
		};
		const channel = createChannel(target);
		expect(() => channel.send({ type: "call", callId: "1", path: "p", args: [] })).not.toThrow();
	});
});

/** Instances, workers and links to tear down after each test. @type {Array<() => Promise<void>>} */
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
 * Stand up a full vine over a REAL worker thread: boot a grow instance on the main thread, THEN spawn
 * the serve worker, and link them with the worker-threads transport.
 *
 * Ordering is load-bearing here, not incidental — but the constraint is Node's, not the transport's.
 * A `worker_threads.Worker` emits each message the worker posts as a `"message"` event, and a message
 * emitted while the `Worker` has no `"message"` listener is gone (see the header of
 * `src/transport/worker-threads.mjs`). `createChannel(worker)` is what attaches the listener; from
 * then on the transport queues any frame that arrives before `grow()` registers its handler
 * (`buffersUntilHandler: true`, CLDMV/slothlet-vine#41). So the only way to lose the worker's
 * one-shot `surface` frame is to `await` something (the grow-side boot) AFTER the worker is spawned
 * but BEFORE `createChannel(worker)` runs. `createChannel(worker)` follows `new Worker(...)` in the
 * same tick here, which closes that gap entirely. See the regression tests below for the failure this
 * avoids and proof the ordering matters.
 * @param {object} [options]
 * @param {object} [options.permissions] - Permission config for the GROW-side instance.
 * @param {object} [options.growOptions] - Options forwarded to `grow()`.
 * @param {object} [options.serveOptions] - Options forwarded to the worker's `serve()`.
 * @param {string} [options.base] - Served api directory, relative to the fixtures dir (default: serve-api).
 * @param {number} [options.bootDelayMs] - Extra delay awaited BEFORE the grow-side boot, standing in
 *   for "the boot is slow" (a busy machine, a heavier api tree). Since the delay sits before the boot,
 *   and the boot sits before the worker is spawned, this never widens the post-spawn gap — it exists
 *   only so the regression tests below can make "a slow boot" deterministic without racing real timing.
 * @returns {Promise<{worker: import("node:worker_threads").Worker, growApi: object, link: object, channel: object}>} The wired pair.
 */
async function wire({ permissions, growOptions, serveOptions, base, bootDelayMs } = {}) {
	if (bootDelayMs) {
		await new Promise((resolve) => setTimeout(resolve, bootDelayMs));
	}
	const growApi = await slothlet({ base: GROW_DIR, silent: true, ...(permissions ? { permissions } : {}) });
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});

	const worker = new Worker(WORKER_URL, { workerData: { serveOptions, base } });
	teardown.push(async () => {
		await worker.terminate();
	});

	const channel = createChannel(worker);
	const link = await grow(growApi, channel, { budgetMs: 5000, ...growOptions });
	teardown.push(async () => {
		await link.close();
		channel.close();
	});
	return { worker, growApi, link, channel };
}

/**
 * REGRESSION FIXTURE — intentionally reproduces the PRE-FIX `wire()` ordering: spawn the worker, THEN
 * await the grow-side boot, and only THEN attach the channel (which is where the transport attaches
 * its `"message"` listener to the `Worker`, and `grow()` registers the receive handler). Kept here,
 * isolated from `wire()` itself, solely to prove the race the reordering above closes — it must never
 * be "fixed" to match `wire()`.
 *
 * A fixed delay alone does not make the race deterministic: on a heavily loaded machine the worker's
 * own boot can outlast the delay, the surface frame then lands after `createChannel(worker)`, and
 * the repro "passes" by accident. So the fixture also waits until the `Worker` has actually emitted
 * the `surface` message while it had NO `"message"` listener — observed through a spy on
 * `worker.emit`, since attaching a listener to watch for it would be the very thing that prevents
 * the loss.
 * @param {number} bootDelayMs - Extra delay awaited before the grow-side boot.
 * @returns {Promise<{worker: import("node:worker_threads").Worker, growApi: object, link: object, channel: object}>} The wired pair.
 */
async function wireOldOrderingRepro(bootDelayMs) {
	const worker = new Worker(WORKER_URL, { workerData: {} });
	teardown.push(async () => {
		await worker.terminate();
	});
	const surfaceEmittedUnheard = new Promise((resolve) => {
		const emit = worker.emit.bind(worker);
		worker.emit = (event, ...args) => {
			if (event === "message" && args[0]?.type === "surface" && worker.listenerCount("message") === 0) resolve();
			return emit(event, ...args);
		};
	});

	await Promise.all([surfaceEmittedUnheard, new Promise((resolve) => setTimeout(resolve, bootDelayMs))]);
	const growApi = await slothlet({ base: GROW_DIR, silent: true });
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});

	const channel = createChannel(worker);
	const link = await grow(growApi, channel, { budgetMs: 5000, handshakeMs: 2000 });
	teardown.push(async () => {
		await link.close();
		channel.close();
	});
	return { worker, growApi, link, channel };
}

describe("e2e over worker_threads — the served surface", () => {
	it("mounts the far side's callable leaves at their identical dotted paths", async () => {
		const { growApi, link } = await wire();
		expect(link.leaves).toEqual(["math.add", "tools.boom", "tools.echo", "tools.secret", "tools.secretCallCount", "tools.slow"]);
		expect(link.collisions).toEqual([]);
		expect(typeof growApi.math.add).toBe("function");
		expect(typeof growApi.tools.echo).toBe("function");
	});

	it("honours a serve-side paths filter across the boundary", async () => {
		const { link } = await wire({ serveOptions: { paths: ["tools"] } });
		expect(link.leaves.every((leaf) => leaf.startsWith("tools."))).toBe(true);
		expect(link.leaves).not.toContain("math.add");
	});
});

describe("e2e over worker_threads — point 1: sync + async round-trips", () => {
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

	it("keeps concurrent calls correlated across the thread boundary", async () => {
		const { growApi } = await wire();
		const results = await Promise.all([growApi.math.add(1, 1), growApi.tools.echo("a"), growApi.math.add(10, 5), growApi.tools.echo("b")]);
		expect(results).toEqual([2, "echo:a", 15, "echo:b"]);
	});
});

describe("e2e over worker_threads — point 2: remote errors re-throw as VineRemoteError", () => {
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

	it("surfaces a data-only RETURN value (function) as VINE_REMOTE / remoteCode VINE_DATA_ONLY", async () => {
		const { growApi } = await wire({ base: "wt-func-api" });
		let caught;
		try {
			await growApi.leaf.fn();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.code).toBe(CODES.REMOTE);
		expect(caught.remoteCode).toBe(CODES.DATA_ONLY);
	});
});

describe("e2e over worker_threads — point 3: slothlet's permission gate covers mounted stubs", () => {
	it("denies a module's call to a denied stub, and the call never reaches the worker", async () => {
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

		// The gate fires BEFORE the stub body runs, so nothing crossed the boundary: the worker's own
		// counter, read back over the same vine, is the proof.
		expect(await growApi.tools.secretCallCount()).toBe(0);

		// A leaf the same caller IS permitted to reach still works.
		expect(await growApi.caller.echo("ok")).toBe("echo:ok");
		expect(await growApi.tools.secretCallCount()).toBe(0);
	});

	it("lets the same call through when no rule denies it", async () => {
		const { growApi } = await wire({ permissions: { defaultPolicy: "allow", rules: [] } });
		expect(await growApi.caller.secret()).toBe("top-secret");
		expect(await growApi.tools.secretCallCount()).toBe(1);
	});
});

describe("e2e over worker_threads — point 4: VINE_BUDGET", () => {
	it("settles a slow call with VINE_BUDGET and ignores the late result", async () => {
		// Small per-CALL budget, but a generous HANDSHAKE budget: a real worker's boot easily exceeds
		// 50ms, and the point here is the call budget, not the surface deadline.
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

		// The worker answers later; settle-once means the frame is dropped and the link stays usable.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await growApi.math.add(1, 1)).toBe(2);
		expect(link.leaves).toContain("tools.slow");
	});

	it("does not fire the budget for a call that answers in time", async () => {
		const { growApi } = await wire({ growOptions: { budgetMs: 2000 } });
		expect(await growApi.tools.slow(20)).toBe("slow:20");
	});
});

describe("e2e over worker_threads — point 5: worker.terminate() settles in-flight calls VINE_GONE", () => {
	it("proves thread death: a mid-call terminate settles pending calls and resolves link.closed", async () => {
		const { growApi, link, worker } = await wire({ growOptions: { budgetMs: 30_000 } });

		let exited = false;
		worker.once("exit", () => {
			exited = true;
		});

		const inFlight = growApi.tools.slow(5000);
		await new Promise((resolve) => setTimeout(resolve, 50));

		const started = Date.now();
		await worker.terminate(); // the thread is really gone — not a graceful close

		await expect(inFlight).rejects.toMatchObject({ code: CODES.GONE });
		await expect(link.closed).resolves.toMatchObject({ reason: "gone" });
		// The settle came from the observed "exit" event, well before the 30s budget could have fired.
		expect(Date.now() - started).toBeLessThan(2000);
		expect(exited).toBe(true);
	});

	it("fails a call made after the thread died, without waiting for a budget", async () => {
		const { growApi, worker } = await wire({ growOptions: { budgetMs: 30_000 } });
		await worker.terminate();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const started = Date.now();
		await expect(growApi.math.add(1, 1)).rejects.toMatchObject({ code: CODES.GONE });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("e2e over worker_threads — point 6: link.close() unmounts and settles VINE_CLOSED", () => {
	it("removes the stubs from the api and settles in-flight calls", async () => {
		const { growApi, link } = await wire({ growOptions: { budgetMs: 30_000 } });
		expect(typeof growApi.tools.echo).toBe("function");

		const inFlight = growApi.tools.slow(5000);
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

describe("e2e over worker_threads — regression: attach the channel before anything is awaited after spawning the worker", () => {
	// A Worker drops any message it emits before a "message" listener is attached — and the listener is
	// attached by createChannel(worker). A slow grow-side boot AFTER the worker is spawned but BEFORE
	// createChannel(worker) widens that window past the worker posting its `surface` frame. (Once the
	// channel exists, the transport queues early frames — see tests/early-frames.test.vitest.mjs.)
	// BOOT_DELAY_MS only has to outlast how quickly the worker fixture posts `surface` after spawning —
	// comfortably true here even under load, since the worker still has to load its own module graph
	// and boot its own slothlet instance before it can serve.
	const BOOT_DELAY_MS = 1000;

	it("the pre-fix ordering (spawn worker, await boot, THEN attach) drops the surface frame under a slow boot", async () => {
		let caught;
		try {
			await wireOldOrderingRepro(BOOT_DELAY_MS);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineError);
		expect(caught.code).toBe(CODES.BUDGET);
	});

	it("the fixed wire() (boot before spawning the worker) still receives the surface frame under the same slow boot", async () => {
		const { growApi, link } = await wire({ bootDelayMs: BOOT_DELAY_MS, growOptions: { handshakeMs: 2000 } });
		expect(link.leaves).toContain("math.add");
		expect(await growApi.math.add(2, 3)).toBe(5);
	});
});
