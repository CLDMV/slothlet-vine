/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-worker-threads.test.vitest.mjs
 *
 * The worker-threads transport against BOTH bars from `docs/DESIGN.md`:
 *
 * - the shared Channel conformance suite, run over two paired ports of a `worker_threads.MessageChannel`
 *   (a real structured-clone boundary in one process — no second thread needed to prove the Channel
 *   contract, and it exercises the child-side `createParentChannel` on the main thread so its code is
 *   measured); and
 * - the full e2e bar over a REAL `worker_threads.Worker`: the serve side boots a genuine slothlet
 *   instance INSIDE the worker (`fixtures/wt-serve-worker.mjs`) and answers over `parentPort`; the
 *   grow side runs on the main thread and mounts forwarding stubs. Value round-trips, remote-error
 *   re-throw, permission gating on a mounted stub, budget expiry, real thread death, and teardown.
 *
 * Death detection is the transport's distinguishing property, so point 5 is done for real:
 * `worker.terminate()` actually ends the thread, the parent channel observes the `"exit"` event, and
 * every in-flight call settles `VINE_GONE` — no budget wait, no hang.
 */
import { describe, it, expect, afterEach } from "vitest";
import { MessageChannel, Worker } from "node:worker_threads";
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
 * Stand up a full vine over a REAL worker thread: spawn the serve worker, boot a grow instance on the
 * main thread, and link them with the worker-threads transport.
 * @param {object} [options]
 * @param {object} [options.permissions] - Permission config for the GROW-side instance.
 * @param {object} [options.growOptions] - Options forwarded to `grow()`.
 * @param {object} [options.serveOptions] - Options forwarded to the worker's `serve()`.
 * @param {string} [options.base] - Served api directory, relative to the fixtures dir (default: serve-api).
 * @returns {Promise<{worker: import("node:worker_threads").Worker, growApi: object, link: object, channel: object}>} The wired pair.
 */
async function wire({ permissions, growOptions, serveOptions, base } = {}) {
	const worker = new Worker(WORKER_URL, { workerData: { serveOptions, base } });
	teardown.push(async () => {
		await worker.terminate();
	});
	const growApi = await slothlet({ base: GROW_DIR, silent: true, ...(permissions ? { permissions } : {}) });
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});

	const channel = createChannel(worker);
	const link = await grow(growApi, channel, { budgetMs: 5000, ...growOptions });
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
