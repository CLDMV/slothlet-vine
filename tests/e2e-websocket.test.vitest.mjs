/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-websocket.test.vitest.mjs
 *
 * The websocket transport against BOTH the shared Channel conformance suite and the full e2e bar from
 * `docs/DESIGN.md`, over a REAL `ws` connection on an EPHEMERAL (OS-assigned, port 0) port.
 *
 * The boundary is a genuine network hop over localhost: a real `WebSocketServer`, a real client
 * socket, the serve side running on the server-accepted socket and the grow side on the client
 * socket. Every server + socket is torn down in `afterEach` / `afterAll` so the test process exits
 * with no leaked handles or held ports, and every port is ephemeral — never a fixed one.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { once, EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError } from "../src/lib/errors.mjs";
import { createChannel, connect } from "../src/transport/websocket.mjs";
import { channelConformance } from "../src/testing/conformance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(here, "fixtures", "serve-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const CODEC_DIR = path.join(here, "fixtures", "codec-api");

/** Every server we stand up, torn down in afterAll as a final backstop. @type {Set<import("ws").WebSocketServer>} */
const servers = new Set();

/**
 * Stand up a real server + client pair on an ephemeral port and return both connected sockets.
 * @returns {Promise<{wss: import("ws").WebSocketServer, serverSocket: object, clientSocket: object}>} The live pair.
 */
async function standUpPair() {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	servers.add(wss);
	await once(wss, "listening");
	const { port } = wss.address();
	const serverSocketReady = once(wss, "connection").then(([socket]) => socket);
	const clientSocket = new WebSocket(`ws://127.0.0.1:${port}`);
	const [serverSocket] = await Promise.all([serverSocketReady, once(clientSocket, "open")]);
	return { wss, serverSocket, clientSocket };
}

/**
 * Close a server and wait for it to actually release its port.
 * @param {import("ws").WebSocketServer} wss - The server to close.
 * @returns {Promise<void>} Resolves once closed.
 */
function closeServer(wss) {
	servers.delete(wss);
	return new Promise((resolve) => wss.close(() => resolve()));
}

/**
 * Hard-tear a whole pair: terminate both sockets and release the port. Safe to call repeatedly.
 * @param {{wss: import("ws").WebSocketServer, serverSocket: object, clientSocket: object}} pair - The pair.
 * @returns {Promise<void>} Resolves once fully torn down.
 */
async function tearDownPair(pair) {
	try {
		pair.clientSocket?.terminate?.();
	} catch {
		// already gone
	}
	try {
		pair.serverSocket?.terminate?.();
	} catch {
		// already gone
	}
	await closeServer(pair.wss);
}

/** Teardown callbacks to run (in reverse) after each e2e test. @type {Array<() => Promise<void> | void>} */
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

afterAll(async () => {
	for (const wss of servers) {
		try {
			await new Promise((resolve) => wss.close(() => resolve()));
		} catch {
			// backstop only
		}
	}
	servers.clear();
});

/**
 * Stand up a full vine over a real ws boundary: a serving instance on the server-accepted socket, a
 * growing instance on the client socket, and a link between them.
 * @param {object} [options]
 * @param {object} [options.permissions] - Permission config for the GROW-side instance.
 * @param {object} [options.growOptions] - Options forwarded to `grow()`.
 * @param {object} [options.serveOptions] - Options forwarded to `serve()`.
 * @param {string} [options.serveDir] - Which serve fixture directory to load (default: `serve-api`).
 * @returns {Promise<{serveApi: object, growApi: object, link: object, serving: object, serverSocket: object, clientSocket: object, wss: object}>} The wired pair.
 */
async function wire({ permissions, growOptions, serveOptions, serveDir = SERVE_DIR } = {}) {
	// Every teardown is registered IMMEDIATELY after the resource it tears down is created — not
	// batched at the end — so a failure partway through (e.g. grow()'s handshake budget expiring)
	// still lets everything already created be torn down instead of leaking until afterAll's backstop.
	const serveApi = await slothlet({ base: serveDir, silent: true });
	teardown.push(async () => {
		await serveApi.slothlet?.shutdown?.();
	});
	const growApi = await slothlet({ base: GROW_DIR, silent: true, ...(permissions ? { permissions } : {}) });
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});

	const pair = await standUpPair();
	teardown.push(async () => {
		await tearDownPair(pair);
	});
	const far = createChannel(pair.serverSocket); // serve end — the server-accepted socket
	const near = createChannel(pair.clientSocket); // grow end — the client socket

	const serving = await serve(serveApi, far, serveOptions);
	teardown.push(() => {
		serving.close();
	});
	const link = await grow(growApi, near, { budgetMs: 5000, ...growOptions });
	teardown.push(async () => {
		await link.close();
	});

	return { serveApi, growApi, link, serving, serverSocket: pair.serverSocket, clientSocket: pair.clientSocket, wss: pair.wss };
}

describe("e2e over websocket — the JSON codec degrades predictably (never corrupts or crashes)", () => {
	it("returns a Date as an ISO string, and echoes a Date argument back as its ISO string", async () => {
		const { growApi } = await wire({ serveDir: CODEC_DIR });
		// A Date crosses as the ISO string JSON produced — not a live Date, not a corrupted frame.
		expect(await growApi.codec.when()).toBe("2020-01-02T03:04:05.000Z");
		// Same on the ARGUMENT path: the leaf echoes the value it received, and it received the ISO string.
		expect(await growApi.codec.echo(new Date("2021-06-07T08:09:10.000Z"))).toBe("2021-06-07T08:09:10.000Z");
	});

	it("returns a Map and a Set as empty objects — lossy but valid, not a crash", async () => {
		const { growApi, link } = await wire({ serveDir: CODEC_DIR });
		expect(await growApi.codec.pairs()).toEqual({});
		expect(await growApi.codec.members()).toEqual({});
		// The link is unharmed by the lossy round-trips and keeps forwarding.
		expect(await growApi.codec.when()).toBe("2020-01-02T03:04:05.000Z");
		expect(link.leaves).toContain("codec.echo");
	});
});

// ── The shared Channel conformance suite, over a real ws pair ────────────────────────────────────
channelConformance(
	"websocket",
	async () => {
		const pair = await standUpPair();
		return {
			a: createChannel(pair.serverSocket),
			b: createChannel(pair.clientSocket),
			cleanup: () => tearDownPair(pair)
		};
	},
	{ describe, it, expect }
);

describe("websocket specifics", () => {
	it("declares byte-transport capabilities (json codec, no structured clone, no pre-handler buffer)", async () => {
		const pair = await standUpPair();
		try {
			for (const socket of [pair.serverSocket, pair.clientSocket]) {
				expect(createChannel(socket).capabilities).toEqual({ structuredClone: false, codec: "json", buffersUntilHandler: false });
			}
		} finally {
			await tearDownPair(pair);
		}
	});

	it("rejects a non-ws socket with a TypeError", () => {
		expect(() => createChannel(null)).toThrow(TypeError);
		expect(() => createChannel({ send() {} })).toThrow(TypeError);
	});

	it("connect() builds a working client channel over a real server", async () => {
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.add(wss);
		await once(wss, "listening");
		const accepted = once(wss, "connection").then(([socket]) => socket);
		const { port } = wss.address();

		const clientChannel = await connect(`ws://127.0.0.1:${port}`);
		const serverSocket = await accepted;
		const serverChannel = createChannel(serverSocket);
		try {
			const received = [];
			serverChannel.onMessage((frame) => received.push(frame));
			clientChannel.send({ type: "call", callId: "c1", path: "x.y", args: [1] });
			await waitFor(() => received.length > 0);
			expect(received[0]).toEqual({ type: "call", callId: "c1", path: "x.y", args: [1] });
		} finally {
			clientChannel.close();
			try {
				serverSocket.terminate();
			} catch {
				// already gone
			}
			await closeServer(wss);
		}
	});

	it("drops a malformed (non-JSON) payload instead of throwing into the socket", async () => {
		const pair = await standUpPair();
		try {
			const channel = createChannel(pair.clientSocket);
			const received = [];
			channel.onMessage((frame) => received.push(frame));
			// Send raw garbage straight down the wire, bypassing the channel's encoder.
			pair.serverSocket.send("this is not json {");
			pair.serverSocket.send(JSON.stringify({ type: "result", callId: "ok", value: 1 }));
			await waitFor(() => received.some((frame) => frame.callId === "ok"));
			expect(received).toEqual([{ type: "result", callId: "ok", value: 1 }]);
		} finally {
			await tearDownPair(pair);
		}
	});

	it("RETHROWS an un-encodable frame (BigInt) as a per-call refusal, leaving the socket usable", async () => {
		const pair = await standUpPair();
		try {
			const channel = createChannel(pair.clientSocket);
			// JSON.stringify throws on a BigInt — the codec REFUSES the frame. send() re-raises it so the
			// core settles just that call VINE_BAD_FRAME; it must NOT kill the socket.
			expect(() => channel.send({ type: "call", callId: "big", path: "p", args: [1n] })).toThrow(TypeError);
			// The socket is unharmed — a subsequent, encodable frame still sends without throwing.
			expect(() => channel.send({ type: "call", callId: "ok", path: "p", args: [1] })).not.toThrow();
		} finally {
			await tearDownPair(pair);
		}
	});

	it("reports a real connection failure through onClose (the socket 'error' path)", async () => {
		// Bind a server, learn its port, then fully release it — a client that then connects gets
		// ECONNREFUSED, which surfaces as a socket 'error' the transport must report as a death.
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(wss, "listening");
		const { port } = wss.address();
		await new Promise((resolve) => wss.close(() => resolve()));

		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		const channel = createChannel(socket);
		try {
			let info;
			channel.onClose((closeInfo) => {
				info = closeInfo;
			});
			await waitFor(() => info !== undefined);
			expect(info.reason).toBe("error");
		} finally {
			try {
				socket.terminate();
			} catch {
				// already gone
			}
		}
	});
});

/**
 * A minimal EventEmitter standing in for the `ws` socket surface (`send`/`on`/`close`/`readyState`) —
 * for validation and edge cases a real socket over a real network hop cannot be made to produce on
 * demand: a stray 'open' while not actually OPEN, a non-Error 'error' payload, an un-decodable message
 * shape, a duplicate/late close.
 * @returns {EventEmitter & {readyState: number, send: Function, close: Function}} The fake socket.
 */
function fakeSocket() {
	const socket = new EventEmitter();
	socket.readyState = 1; // OPEN by default (0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED — the WHATWG enum)
	socket.send = () => {};
	socket.close = () => {};
	return socket;
}

describe("websocket transport specifics (fake socket)", () => {
	it("flushPending guards against a stray 'open' firing while the socket isn't actually OPEN", () => {
		const sent = [];
		const socket = fakeSocket();
		socket.readyState = 0; // CONNECTING
		socket.send = (text) => sent.push(text);
		const channel = createChannel(socket);
		channel.send({ type: "call", callId: "1", path: "p", args: [] }); // queued, still CONNECTING
		socket.readyState = 2; // CLOSING — force a non-OPEN state before the (stray) 'open' fires
		socket.emit("open");
		expect(sent).toEqual([]); // flushPending must not flush into a socket that isn't OPEN
	});

	it("stringifies a non-Error value from the socket's 'error' event", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		let info;
		channel.onClose((i) => {
			info = i;
		});
		socket.emit("error", "raw string failure");
		expect(info).toMatchObject({ reason: "error", error: "raw string failure" });
	});

	it("is a silent no-op when JSON.stringify produces undefined (send(undefined) directly)", () => {
		const sent = [];
		const socket = fakeSocket();
		socket.send = (text) => sent.push(text);
		const channel = createChannel(socket);
		expect(() => channel.send(undefined)).not.toThrow();
		expect(sent).toEqual([]);
	});

	it("ignores a non-function onMessage/onClose registration", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		expect(() => channel.onMessage(123)).not.toThrow();
		expect(() => channel.onClose("nope")).not.toThrow();
		expect(() => socket.emit("message", JSON.stringify({ type: "result", callId: "c1", value: 1 }))).not.toThrow();
		expect(() => socket.emit("close", 1000, Buffer.from(""))).not.toThrow();
	});

	it("toText: decodes a plain string message directly", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		socket.emit("message", JSON.stringify({ type: "result", callId: "str", value: 1 }));
		expect(seen).toEqual([{ type: "result", callId: "str", value: 1 }]);
	});

	it("toText: decodes a raw ArrayBuffer message", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		const text = JSON.stringify({ type: "result", callId: "ab", value: 2 });
		const buf = new TextEncoder().encode(text).buffer;
		socket.emit("message", buf);
		expect(seen).toEqual([{ type: "result", callId: "ab", value: 2 }]);
	});

	it("toText: decodes a fragmented binary message (an array of Buffer parts)", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		const text = JSON.stringify({ type: "result", callId: "frag", value: 3 });
		const half = Math.ceil(text.length / 2);
		socket.emit("message", [Buffer.from(text.slice(0, half)), Buffer.from(text.slice(half))]);
		expect(seen).toEqual([{ type: "result", callId: "frag", value: 3 }]);
	});

	it("toText: drops an unrecognized payload shape instead of throwing", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		expect(() => socket.emit("message", 12345)).not.toThrow(); // a bare number — no matching shape
		expect(seen).toEqual([]);
	});

	it("toText: substitutes an empty string for one unrecognized fragment, not the whole message", () => {
		// A fragmented binary message is joined fragment-by-fragment; one fragment `toText` cannot
		// decode contributes "" rather than aborting the whole join (the `?? ""` inside the map).
		const socket = fakeSocket();
		const channel = createChannel(socket);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		const text = JSON.stringify({ type: "result", callId: "c1", value: 1 });
		socket.emit("message", [Buffer.from(text), 42]); // the whole valid text, plus one bad fragment
		expect(seen).toEqual([{ type: "result", callId: "c1", value: 1 }]);
	});

	it("reasonText: falls back to an empty string when the close reason can't be decoded", () => {
		const socket = fakeSocket();
		const channel = createChannel(socket);
		let info;
		channel.onClose((i) => {
			info = i;
		});
		socket.emit("close", 1000, undefined); // no reason payload — toText(undefined) is null
		expect(info).toMatchObject({ reason: "peer-closed", code: 1000, detail: "" });
	});

	it("toText: drops a payload that throws while being inspected, instead of throwing", () => {
		// A value whose prototype-chain walk throws — `instanceof ArrayBuffer` triggers it, exercising
		// toText's own catch, distinctly from the no-match fallback above.
		const poisoned = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("boom");
				}
			}
		);
		const socket = fakeSocket();
		const channel = createChannel(socket);
		const seen = [];
		channel.onMessage((m) => seen.push(m));
		expect(() => socket.emit("message", poisoned)).not.toThrow();
		expect(seen).toEqual([]);
	});
});

describe("e2e over websocket — a handshake failure still lets every already-created resource be torn down", () => {
	it("does not leak the socket pair or the slothlet instances when grow() never sees a surface", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		const pair = await standUpPair();
		const near = createChannel(pair.clientSocket);
		// Deliberately never serve() the far side — grow()'s handshake has nothing to receive and must
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
		await tearDownPair(pair);
		await serveApi.slothlet.shutdown();
		await growApi.slothlet.shutdown();
	});
});

describe("e2e over websocket — the served surface", () => {
	it("mounts the far leaves at their identical dotted paths", async () => {
		const { serving, link, growApi } = await wire();
		expect(serving.leaves).toEqual(["math.add", "tools.boom", "tools.echo", "tools.secret", "tools.secretCallCount", "tools.slow"]);
		expect(link.leaves).toEqual(serving.leaves);
		expect(link.skipped).toEqual([]);
		expect(link.collisions).toEqual([]);
		expect(typeof growApi.math.add).toBe("function");
		expect(typeof growApi.tools.echo).toBe("function");
	});
});

describe("e2e over websocket — point 1: sync + async round-trips", () => {
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

	it("keeps concurrent calls correlated across the wire", async () => {
		const { growApi } = await wire();
		const results = await Promise.all([growApi.math.add(1, 1), growApi.tools.echo("a"), growApi.math.add(10, 5), growApi.tools.echo("b")]);
		expect(results).toEqual([2, "echo:a", 15, "echo:b"]);
	});

	it("refuses a function argument at the edge, before anything is sent (VINE_DATA_ONLY)", async () => {
		const { growApi } = await wire();
		await expect(growApi.tools.echo({ onDone: () => {} })).rejects.toMatchObject({
			code: CODES.DATA_ONLY,
			path: "tools.echo"
		});
	});
});

describe("e2e over websocket — point 2: remote errors re-throw as VineRemoteError", () => {
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

describe("e2e over websocket — point 3: slothlet's permission gate covers mounted stubs", () => {
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

		// The gate fires before the stub body runs — nothing crossed the boundary. The far side's own
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

describe("e2e over websocket — point 4: VINE_BUDGET", () => {
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

describe("e2e over websocket — point 5: far-side death settles in-flight calls with VINE_GONE", () => {
	it("settles pending calls and resolves link.closed when the far socket dies mid-call", async () => {
		const { growApi, link, serverSocket } = await wire({ growOptions: { budgetMs: 10_000 } });
		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Hard-kill the far side: a real network death (RST), detected grow-side via the socket 'close'.
		serverSocket.terminate();

		await expect(inFlight).rejects.toMatchObject({ code: CODES.GONE });
		await expect(link.closed).resolves.toMatchObject({ reason: "gone" });
	});

	it("fails a call made after the far side died, without waiting for a budget", async () => {
		const { growApi, serverSocket } = await wire({ growOptions: { budgetMs: 10_000 } });
		serverSocket.terminate();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const started = Date.now();
		await expect(growApi.math.add(1, 1)).rejects.toMatchObject({ code: CODES.GONE });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("e2e over websocket — point 6: link.close() unmounts and settles VINE_CLOSED", () => {
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

/**
 * Poll until a predicate holds, failing loudly rather than hanging the suite.
 * @param {() => boolean} predicate - The condition to wait for.
 * @returns {Promise<void>} Resolves once true.
 */
async function waitFor(predicate) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the far side");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
