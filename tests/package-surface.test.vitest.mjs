/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/package-surface.test.vitest.mjs
 *
 * The package's published surface: every documented entry point resolves, the frame schema matches
 * the protocol the code implements, and the transports that are still scaffolds fail LOUDLY — never
 * a silent no-op a consumer could mistake for working forwarding.
 *
 * `transport/loopback` is implemented and is asserted the other way: it must NOT throw.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { grow, serve, CODES, VineError, VineRemoteError, DEFAULT_BUDGET_MS } from "../src/index.mjs";

/** Transports still awaiting their own implementation pass. @type {string[]} */
const SCAFFOLD_TRANSPORTS = [];
/** Transports whose Channel is implemented (createChannel does real work, never a scaffold throw). @type {string[]} */
const IMPLEMENTED_TRANSPORTS = ["loopback", "post-message", "worker-threads", "process", "websocket"];
/** Every transport subpath the package publishes. @type {string[]} */
const ALL_TRANSPORTS = [...IMPLEMENTED_TRANSPORTS, ...SCAFFOLD_TRANSPORTS];

describe("package surface", () => {
	it("root export exposes grow + serve as functions", () => {
		expect(typeof grow).toBe("function");
		expect(typeof serve).toBe("function");
	});

	it("root export exposes the error taxonomy consumers branch on", () => {
		expect(typeof VineError).toBe("function");
		expect(typeof VineRemoteError).toBe("function");
		expect(CODES.GONE).toBe("VINE_GONE");
		expect(DEFAULT_BUDGET_MS).toBe(30_000);
	});

	it.each(ALL_TRANSPORTS)("transport subpath '%s' resolves and exposes createChannel", async (name) => {
		const mod = await import(`../src/transport/${name}.mjs`);
		expect(typeof mod.createChannel).toBe("function");
	});

	it("the testing subpath exposes the conformance harness", async () => {
		const mod = await import("../src/testing/conformance.mjs");
		expect(typeof mod.channelConformance).toBe("function");
	});

	it("package.json exports map lists every published subpath", () => {
		const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
		for (const name of ALL_TRANSPORTS) expect(pkg.exports[`./transport/${name}`]).toBe(`./src/transport/${name}.mjs`);
		expect(pkg.exports["."]).toBe("./src/index.mjs");
		expect(pkg.exports["./testing"]).toBe("./src/testing/conformance.mjs");
		expect(pkg.peerDependencies["@cldmv/slothlet"]).toBeTruthy();
	});
});

describe("unimplemented transports still fail loudly (pre-release contract)", () => {
	it.each(SCAFFOLD_TRANSPORTS)("transport '%s' createChannel throws a not-implemented error naming its transport", async (name) => {
		const { createChannel } = await import(`../src/transport/${name}.mjs`);
		expect(() => createChannel()).toThrowError(new RegExp(`transport/${name}`));
		expect(() => createChannel()).toThrowError(/not implemented/i);
	});

	it("loopback is implemented and does NOT throw", async () => {
		const { createChannel, createPair } = await import("../src/transport/loopback.mjs");
		expect(() => createChannel()).not.toThrow();
		expect(createPair()).toHaveLength(2);
	});

	it("post-message is implemented — it validates its port instead of throwing a scaffold error", async () => {
		const { createChannel } = await import("../src/transport/post-message.mjs");
		const { MessageChannel } = await import("node:worker_threads");
		// No scaffold "not implemented" throw: the no-arg call fails on the MISSING PORT (a TypeError),
		// and a real port yields a working Channel.
		expect(() => createChannel()).toThrowError(TypeError);
		expect(() => createChannel()).not.toThrowError(/not implemented/i);
		const { port1 } = new MessageChannel();
		const channel = createChannel(port1);
		expect(typeof channel.send).toBe("function");
		expect(channel.capabilities.structuredClone).toBe(true);
		channel.close();
	});

	it("worker-threads is implemented — it validates its worker/port instead of throwing a scaffold error", async () => {
		const { createChannel, createParentChannel } = await import("../src/transport/worker-threads.mjs");
		const { MessageChannel } = await import("node:worker_threads");
		// No scaffold "not implemented" throw: createChannel with no Worker fails on the MISSING ARG (a
		// TypeError), and createParentChannel around a real MessagePort yields a working Channel.
		expect(() => createChannel()).toThrowError(TypeError);
		expect(() => createChannel()).not.toThrowError(/not implemented/i);
		const { port1 } = new MessageChannel();
		const channel = createParentChannel(port1);
		expect(typeof channel.send).toBe("function");
		expect(channel.capabilities).toEqual({ structuredClone: true, codec: "none", buffersUntilHandler: false });
		channel.close();
	});

	it("websocket is implemented — it validates its socket instead of throwing a scaffold error", async () => {
		const { createChannel } = await import("../src/transport/websocket.mjs");
		// No scaffold "not implemented" throw: createChannel with no socket fails on the MISSING ARG (a
		// TypeError), and a socket exposing the ws instance surface yields a working json-codec Channel.
		expect(() => createChannel()).toThrowError(TypeError);
		expect(() => createChannel()).not.toThrowError(/not implemented/i);
		const socket = {
			send() {},
			on() {},
			close() {},
			readyState: 1
		};
		const channel = createChannel(socket);
		expect(typeof channel.send).toBe("function");
		expect(channel.capabilities).toEqual({ structuredClone: false, codec: "json", buffersUntilHandler: false });
		channel.close();
	});
});

describe("frame schema", () => {
	const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/frame.schema.json", import.meta.url)), "utf8"));

	it("is a 2020-12 JSON Schema with the four v1 frame shapes", () => {
		expect(schema.$schema).toContain("2020-12");
		expect(Array.isArray(schema.oneOf)).toBe(true);
		expect(schema.oneOf.map((entry) => entry.properties.type.const)).toEqual(["surface", "call", "result", "error"]);
	});

	it("matches the frames the implementation actually builds", async () => {
		const { surfaceFrame, callFrame, resultFrame, errorFrame, FRAME_VERSION } = await import("../src/lib/frame.mjs");
		const [surface, call, result, error] = schema.oneOf;

		expect(Object.keys(surfaceFrame(["a.b"]))).toEqual(expect.arrayContaining(surface.required));
		expect(surface.properties.v.const).toBe(FRAME_VERSION);
		expect(Object.keys(callFrame("n#1", "a.b", []))).toEqual(expect.arrayContaining(call.required));
		expect(Object.keys(resultFrame("n#1", 1))).toEqual(expect.arrayContaining(result.required));
		expect(Object.keys(errorFrame("n#1", new Error("x")))).toEqual(expect.arrayContaining(error.required));
		expect(Object.keys(errorFrame("n#1", new Error("x")).error)).toEqual(expect.arrayContaining(error.properties.error.required));
	});

	it("requires a non-empty callId, matching parseFrame's own rejection", () => {
		const [, call, result, error] = schema.oneOf;
		expect(call.properties.callId.minLength).toBe(1);
		expect(result.properties.callId.minLength).toBe(1);
		expect(error.properties.callId.minLength).toBe(1);
	});
});
