/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/early-frames.test.vitest.mjs
 *	@Date: 2026-09-28T03:15:48+00:00 (1790565348)
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
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { MessageChannel, Worker } from "node:worker_threads";
import { WebSocketServer, WebSocket } from "ws";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import * as workerThreads from "../src/transport/worker-threads.mjs";
import * as postMessage from "../src/transport/post-message.mjs";
import * as processTransport from "../src/transport/process.mjs";
import * as websocket from "../src/transport/websocket.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const SERVE_DIR = path.join(here, "fixtures", "serve-api");
const WORKER_URL = new URL("./fixtures/wt-serve-worker.mjs", import.meta.url);
const CHILD = path.join(here, "fixtures", "proc-serve-child.mjs");

/** A short handshake: the surface is already sitting in the transport, so it must not be waited for. */
const GROW_OPTIONS = { budgetMs: 5000, handshakeMs: 2000 };

/** Teardown steps registered as resources are created. @type {Array<() => unknown>} */
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
 * Boot the grow-side instance.
 * @returns {Promise<object>} The grow api.
 */
async function bootGrowApi() {
	const api = await slothlet({ base: GROW_DIR, silent: true });
	teardown.push(() => api.slothlet?.shutdown?.());
	return api;
}

/**
 * Grow over `channel` (created earlier by the caller) and prove the link works end to end.
 * @param {object} api - The grow api.
 * @param {object} channel - The channel created before anything was awaited.
 * @returns {Promise<void>}
 */
async function growAndProve(api, channel) {
	const link = await grow(api, channel, GROW_OPTIONS);
	teardown.push(async () => {
		await link.close();
		channel.close();
	});
	expect(link.leaves).toContain("math.add");
	expect(await api.math.add(2, 3)).toBe(5);
}

describe("a surface frame that arrives between createChannel() and grow() is not lost (#41)", () => {
	it("worker-threads: createChannel(worker) at spawn, surface arrives, THEN grow()", async () => {
		const api = await bootGrowApi();
		const worker = new Worker(WORKER_URL, { workerData: {} });
		teardown.push(() => worker.terminate());
		const channel = workerThreads.createChannel(worker);

		const [frame] = await once(worker, "message"); // the surface has reached this thread
		expect(frame.type).toBe("surface");
		await growAndProve(api, channel);
	});

	it("post-message: createChannel(port) first, serve() publishes, THEN grow()", async () => {
		const api = await bootGrowApi();
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(() => serveApi.slothlet?.shutdown?.());
		const { port1, port2 } = new MessageChannel();
		teardown.push(() => {
			port1.close();
			port2.close();
		});
		const channel = postMessage.createChannel(port1);
		const arrived = once(port1, "message");
		await serve(serveApi, postMessage.createChannel(port2));

		const [event] = await arrived;
		expect(event.data?.type ?? event.type).toBe("surface");
		await growAndProve(api, channel);
	});

	it("process: createChannel(child) at fork, surface arrives, THEN grow()", async () => {
		const api = await bootGrowApi();
		const child = fork(CHILD, [], { serialization: "advanced", stdio: "ignore" });
		teardown.push(() => child.kill());
		const channel = processTransport.createChannel(child);

		const [frame] = await once(child, "message");
		expect(frame.type).toBe("surface");
		await growAndProve(api, channel);
	});

	it("websocket: createChannel(socket) at construction, surface arrives, THEN grow()", async () => {
		const api = await bootGrowApi();
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(() => serveApi.slothlet?.shutdown?.());
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		teardown.push(() => new Promise((resolve) => wss.close(() => resolve())));
		await once(wss, "listening");
		wss.on("connection", (socket) => {
			void serve(serveApi, websocket.createChannel(socket));
		});

		const socket = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
		teardown.push(() => socket.terminate());
		const channel = websocket.createChannel(socket);

		const [data] = await once(socket, "message");
		expect(JSON.parse(String(data)).type).toBe("surface");
		await growAndProve(api, channel);
	});
});
