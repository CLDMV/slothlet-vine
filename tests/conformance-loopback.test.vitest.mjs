/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/conformance-loopback.test.vitest.mjs
 *
 * The loopback transport against the shared Channel conformance suite — the same suite every other
 * built-in transport, and any consumer-written one, has to pass.
 */
import { describe, it, expect } from "vitest";
import { createChannel, createPair } from "../src/transport/loopback.mjs";
import { channelConformance } from "../src/testing/conformance.mjs";

channelConformance("loopback", () => createPair(), { describe, it, expect });

describe("loopback specifics", () => {
	it("declares pass-through capabilities", () => {
		const [a, b] = createPair();
		for (const channel of [a, b]) {
			expect(channel.capabilities).toEqual({ structuredClone: true, codec: "none", buffersUntilHandler: true });
		}
	});

	it("passes frames BY REFERENCE — same process, no clone step", async () => {
		const [a, b] = createPair();
		const sent = { type: "result", callId: "c1", value: { deep: {} } };
		const seen = [];
		b.onMessage((m) => seen.push(m));
		a.send(sent);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen[0]).toBe(sent);
	});

	it("createChannel() hands back one end with its peer attached", async () => {
		const channel = createChannel();
		expect(typeof channel.send).toBe("function");
		expect(typeof channel.peer.send).toBe("function");
		const seen = [];
		channel.peer.onMessage((m) => seen.push(m));
		channel.send({ type: "result", callId: "c1", value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen).toHaveLength(1);
	});

	it("replays everything buffered before onMessage, in order", async () => {
		const [a, b] = createPair();
		for (let i = 0; i < 5; i++) a.send({ type: "result", callId: `c${i}`, value: i });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const seen = [];
		b.onMessage((m) => seen.push(m));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen.map((f) => f.value)).toEqual([0, 1, 2, 3, 4]);
	});

	it("ignores a non-function onMessage/onClose registration", async () => {
		const [a, b] = createPair();
		expect(() => b.onMessage(null)).not.toThrow();
		expect(() => b.onClose("nope")).not.toThrow();
		a.send({ type: "result", callId: "c1", value: 1 });
		a.close();
		await new Promise((resolve) => setTimeout(resolve, 5));
	});

	it("drops a frame sent to an already-closed peer", async () => {
		const [a, b] = createPair();
		const seen = [];
		b.onMessage((m) => seen.push(m));
		b.close();
		a.send({ type: "result", callId: "c1", value: 1 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen).toEqual([]);
	});

	it("drops a frame whose peer closes between send and delivery", async () => {
		const [a, b] = createPair();
		const seen = [];
		b.onMessage((m) => seen.push(m));
		a.send({ type: "result", callId: "c1", value: 1 });
		b.close();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen).toEqual([]);
	});
});
