/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/regression-send-failure.test.vitest.mjs
 *
 * REGRESSION LOCK for the send-failure policy (final-review findings 1 + 2).
 *
 * A `channel.send(frame)` failure has two distinct causes and every transport now keeps them apart:
 *
 * - **The medium REFUSES this frame** — an un-serializable argument the data-only scan cannot see (a
 *   `Symbol` / a value hiding a function → `DataCloneError` on the structured-clone family and a
 *   synchronous serializer throw from `child.send`; a `BigInt` → a `JSON.stringify` throw on the
 *   websocket JSON codec). This is a PER-CALL fault: `send()` rethrows, the core settles JUST that
 *   call `VINE_BAD_FRAME`, and the link — plus every other in-flight call — stays alive.
 * - **The channel is DEAD** — that fires `onClose` and settles everything `VINE_GONE`; it is covered
 *   by each transport's own e2e (point 5) and is deliberately NOT re-tested here.
 *
 * The historical defect this locks out: `src/transport/process.mjs` treated a synchronous serializer
 * throw as far-side DEATH, so one un-cloneable argument on one call killed the WHOLE link (every
 * in-flight call `VINE_GONE`, `link.closed` → `gone`) while the child was still alive. The
 * post-message / worker-threads / websocket transports had the mirror bug in the other direction —
 * swallowing the refusal so the call hung to its full budget instead of failing fast.
 *
 * Each transport is exercised over its REAL boundary (an in-process structured-clone MessageChannel
 * hop for the port transports, a real forked child for `process`, a real `ws` socket for
 * `websocket`), so the uniform policy is proven end to end through `grow()`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { fork } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES } from "../src/lib/errors.mjs";
import { createChannel as createPostMessageChannel } from "../src/transport/post-message.mjs";
import { createParentChannel as createWorkerParentChannel } from "../src/transport/worker-threads.mjs";
import { createChannel as createProcessChannel } from "../src/transport/process.mjs";
import { createChannel as createWebSocketChannel } from "../src/transport/websocket.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(here, "fixtures", "serve-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const PROC_CHILD = path.join(here, "fixtures", "proc-serve-child.mjs");

/** @type {Array<() => Promise<void>|void>} */
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
 * Assert the fixed behaviour holds for an already-wired link: the bad call rejects `VINE_BAD_FRAME`,
 * an unrelated in-flight call still completes, and the link is NOT gone.
 * @param {object} growApi - The grow-side slothlet instance.
 * @param {object} link - The live link.
 * @param {() => Promise<unknown>} makeBadCall - Issues the call whose argument the medium refuses.
 * @returns {Promise<void>}
 */
async function assertRefusalIsPerCall(growApi, link, makeBadCall) {
	let linkClosed = false;
	link.closed.then(() => {
		linkClosed = true;
	});

	// A healthy, unrelated call is in flight when the bad frame is refused…
	const inFlight = growApi.tools.slow(200);
	await new Promise((resolve) => setTimeout(resolve, 20));

	// …the bad call fails fast with BAD_FRAME — not GONE, not a budget timeout.
	await expect(makeBadCall()).rejects.toMatchObject({ code: CODES.BAD_FRAME });

	// The unrelated in-flight call still completes, and the link keeps forwarding afterwards.
	expect(await inFlight).toBe("slow:200");
	expect(await growApi.math.add(2, 3)).toBe(5);
	expect(linkClosed).toBe(false);
	expect(link.leaves).toContain("tools.echo");
}

describe("regression: an un-serializable arg fails ONLY that call (VINE_BAD_FRAME), link stays alive", () => {
	// ── post-message (real worker_threads MessageChannel structured-clone hop) ─────────────────────
	it("post-message — a Symbol arg (DataCloneError) settles that call BAD_FRAME", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => await serveApi.slothlet?.shutdown?.());
		teardown.push(async () => await growApi.slothlet?.shutdown?.());

		const { port1, port2 } = new MessageChannel();
		const near = createPostMessageChannel(port1);
		const far = createPostMessageChannel(port2);
		const growing = grow(growApi, near, { budgetMs: 2000 });
		const serving = await serve(serveApi, far);
		const link = await growing;
		teardown.push(async () => {
			await link.close();
			serving.close();
			near.close();
			far.close();
		});

		await assertRefusalIsPerCall(growApi, link, () => growApi.tools.echo(Symbol("not-cloneable")));
	});

	// ── worker-threads (two paired MessageChannel ports, real structured-clone hop) ────────────────
	it("worker-threads — a Symbol arg (DataCloneError) settles that call BAD_FRAME", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => await serveApi.slothlet?.shutdown?.());
		teardown.push(async () => await growApi.slothlet?.shutdown?.());

		const { port1, port2 } = new MessageChannel();
		const near = createWorkerParentChannel(port1);
		const far = createWorkerParentChannel(port2);
		const growing = grow(growApi, near, { budgetMs: 2000 });
		const serving = await serve(serveApi, far);
		const link = await growing;
		teardown.push(async () => {
			await link.close();
			serving.close();
			near.close();
			far.close();
		});

		await assertRefusalIsPerCall(growApi, link, () => growApi.tools.echo(Symbol("not-cloneable")));
	});

	// ── process (a REAL forked child over IPC, advanced serialization) ─────────────────────────────
	it("process — a Symbol arg (synchronous serializer throw) settles that call BAD_FRAME, child stays alive", async () => {
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => await growApi.slothlet?.shutdown?.());
		const child = fork(PROC_CHILD, [], { serialization: "advanced" });
		teardown.push(() => {
			if (child.connected || child.exitCode === null) child.kill();
		});

		const link = await grow(growApi, createProcessChannel(child), { budgetMs: 10_000, handshakeMs: 10_000 });
		teardown.push(async () => await link.close());

		await assertRefusalIsPerCall(growApi, link, () => growApi.tools.echo(Symbol("not-cloneable")));

		// The whole point of the regression: the child is demonstrably still alive and connected.
		expect(child.connected).toBe(true);
		expect(child.exitCode).toBe(null);
	}, 20_000);

	// ── websocket (a REAL ws connection on an ephemeral port; a BigInt is un-encodable JSON) ───────
	it("websocket — a BigInt arg (JSON.stringify throw) settles that call BAD_FRAME", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => await serveApi.slothlet?.shutdown?.());
		teardown.push(async () => await growApi.slothlet?.shutdown?.());

		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(wss, "listening");
		const { port } = wss.address();
		const serverSocketReady = once(wss, "connection").then(([socket]) => socket);
		const clientSocket = new WebSocket(`ws://127.0.0.1:${port}`);
		const [serverSocket] = await Promise.all([serverSocketReady, once(clientSocket, "open")]);

		const far = createWebSocketChannel(serverSocket);
		const near = createWebSocketChannel(clientSocket);
		const serving = await serve(serveApi, far);
		const link = await grow(growApi, near, { budgetMs: 2000 });
		teardown.push(async () => {
			await link.close();
			serving.close();
			try {
				clientSocket.terminate();
			} catch {
				// already gone
			}
			try {
				serverSocket.terminate();
			} catch {
				// already gone
			}
			await new Promise((resolve) => wss.close(() => resolve()));
		});

		// A Symbol would merely degrade (JSON drops it); a BigInt is what JSON.stringify actually refuses.
		await assertRefusalIsPerCall(growApi, link, () => growApi.tools.echo(10n));
	}, 20_000);
});
