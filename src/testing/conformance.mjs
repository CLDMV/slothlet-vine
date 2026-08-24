/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/testing/conformance.mjs
 *
 * The reusable Channel conformance suite. ANY transport — built-in or consumer-written — runs this
 * against a factory that produces a connected channel pair, and every built-in transport's test file
 * runs it alongside its own e2e.
 *
 * The harness imports NO test framework. `describe` / `it` / `expect` are INJECTED, so a consumer on
 * vitest, node:test, jest or mocha runs the same suite by handing in their own three functions and
 * this package never grows a runner dependency.
 *
 * @example
 * import { describe, it, expect } from "vitest";
 * import { createPair } from "@cldmv/slothlet-vine/transport/loopback";
 * import { channelConformance } from "@cldmv/slothlet-vine/testing";
 *
 * channelConformance("loopback", () => createPair(), { describe, it, expect });
 */

/** How long a conformance assertion waits for an async delivery before giving up. @type {number} */
const WAIT_MS = 2000;

/**
 * Run the Channel conformance suite against a transport.
 *
 * The pair factory may be sync or async and may return either `[a, b]` or
 * `{ a, b, cleanup? }` — a transport that owns real resources (a worker, a socket, a server) returns
 * the object form so the suite can tear them down between cases.
 *
 * @param {string} name - Transport name, used in the suite title.
 * @param {() => ([object, object] | {a: object, b: object, cleanup?: () => unknown} | Promise<[object, object] | {a: object, b: object, cleanup?: () => unknown}>)} makePair
 *   Produces one connected channel pair per test.
 * @param {{ describe: Function, it: Function, expect: Function }} t - The injected test framework.
 * @returns {void}
 */
export function channelConformance(name, makePair, t) {
	const { describe, it, expect } = t;

	/**
	 * Normalize whatever the factory returned into `{ a, b, cleanup }`.
	 * @returns {Promise<{a: object, b: object, cleanup: () => Promise<void>}>} The pair plus teardown.
	 */
	async function pair() {
		const made = await makePair();
		const a = Array.isArray(made) ? made[0] : made.a;
		const b = Array.isArray(made) ? made[1] : made.b;
		const extra = Array.isArray(made) ? undefined : made.cleanup;
		return {
			a,
			b,
			async cleanup() {
				try {
					a.close?.();
					b.close?.();
				} catch {
					// close() is being exercised elsewhere; teardown must not mask the real assertion.
				}
				if (typeof extra === "function") await extra();
			}
		};
	}

	describe(`Channel conformance: ${name}`, () => {
		it("delivers a frame from a to b", async () => {
			const { a, b, cleanup } = await pair();
			try {
				const received = collect(b);
				a.send({ type: "call", callId: "c1", path: "x.y", args: [1] });
				const [frame] = await received.take(1);
				expect(frame.callId).toBe("c1");
				expect(frame.path).toBe("x.y");
			} finally {
				await cleanup();
			}
		});

		it("delivers in the other direction too", async () => {
			const { a, b, cleanup } = await pair();
			try {
				const received = collect(a);
				b.send({ type: "result", callId: "c1", value: "pong" });
				const [frame] = await received.take(1);
				expect(frame.value).toBe("pong");
			} finally {
				await cleanup();
			}
		});

		it("delivers asynchronously — never synchronously inside send()", async () => {
			const { a, b, cleanup } = await pair();
			try {
				let seen = false;
				b.onMessage(() => {
					seen = true;
				});
				a.send({ type: "result", callId: "c1", value: 1 });
				expect(seen).toBe(false);
				await settle();
				expect(seen).toBe(true);
			} finally {
				await cleanup();
			}
		});

		it("preserves order across a burst", async () => {
			const { a, b, cleanup } = await pair();
			try {
				const received = collect(b);
				for (let i = 0; i < 50; i++) a.send({ type: "result", callId: `c${i}`, value: i });
				const frames = await received.take(50);
				expect(frames.map((f) => f.value)).toEqual(Array.from({ length: 50 }, (_, i) => i));
			} finally {
				await cleanup();
			}
		});

		it("interleaves bursts from both ends without loss", async () => {
			const { a, b, cleanup } = await pair();
			try {
				const atB = collect(b);
				const atA = collect(a);
				for (let i = 0; i < 20; i++) {
					a.send({ type: "call", callId: `a${i}`, path: "p", args: [i] });
					b.send({ type: "result", callId: `b${i}`, value: i });
				}
				const [toB, toA] = await Promise.all([atB.take(20), atA.take(20)]);
				expect(toB.map((f) => f.callId)).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`));
				expect(toA.map((f) => f.callId)).toEqual(Array.from({ length: 20 }, (_, i) => `b${i}`));
			} finally {
				await cleanup();
			}
		});

		it("carries a large-ish payload intact", async () => {
			const { a, b, cleanup } = await pair();
			try {
				const received = collect(b);
				const big = { text: "x".repeat(200_000), list: Array.from({ length: 5000 }, (_, i) => i), nested: { deep: { ok: true } } };
				a.send({ type: "call", callId: "big", path: "p", args: [big] });
				const [frame] = await received.take(1);
				expect(frame.args[0].text.length).toBe(200_000);
				expect(frame.args[0].list.length).toBe(5000);
				expect(frame.args[0].nested.deep.ok).toBe(true);
			} finally {
				await cleanup();
			}
		});

		it("honours its declared pre-handler behaviour (buffersUntilHandler)", async () => {
			const { a, b, cleanup } = await pair();
			try {
				// Sent while `b` has no handler at all. A transport that DECLARES buffering must replay
				// it; one that does not is asserted only on the frames sent after registration, because
				// dropping is an equally valid contract — what is not valid is being undeclared.
				a.send({ type: "result", callId: "early", value: "early" });
				await settle();
				const received = collect(b);
				a.send({ type: "result", callId: "late", value: "late" });
				const buffers = b.capabilities?.buffersUntilHandler === true;
				const frames = await received.take(buffers ? 2 : 1);
				const ids = frames.map((f) => f.callId);
				if (buffers) expect(ids).toEqual(["early", "late"]);
				else expect(ids).toEqual(["late"]);
			} finally {
				await cleanup();
			}
		});

		it("lets the last onMessage registration win", async () => {
			const { a, b, cleanup } = await pair();
			try {
				const first = [];
				b.onMessage((m) => first.push(m));
				const received = collect(b);
				a.send({ type: "result", callId: "c1", value: 1 });
				await received.take(1);
				expect(first).toEqual([]);
			} finally {
				await cleanup();
			}
		});

		it("insulates the transport from a throwing handler", async () => {
			const { a, b, cleanup } = await pair();
			try {
				b.onMessage(() => {
					throw new Error("handler blew up");
				});
				expect(() => a.send({ type: "result", callId: "c1", value: 1 })).not.toThrow();
				await settle();
				// The channel is still usable after a handler threw.
				const received = collect(b);
				a.send({ type: "result", callId: "c2", value: 2 });
				const [frame] = await received.take(1);
				expect(frame.callId).toBe("c2");
			} finally {
				await cleanup();
			}
		});

		it("fires the far side's onClose when an end closes", async () => {
			const { a, b, cleanup } = await pair();
			try {
				if (typeof a.onClose !== "function" || typeof b.close !== "function") return;
				let fired = 0;
				a.onClose(() => {
					fired++;
				});
				b.close();
				await waitFor(() => fired > 0);
				expect(fired).toBe(1);
			} finally {
				await cleanup();
			}
		});

		it("close() is idempotent and send() after close does not throw", async () => {
			const { a, b, cleanup } = await pair();
			try {
				if (typeof b.close !== "function") return;
				b.close();
				expect(() => b.close()).not.toThrow();
				expect(() => b.send({ type: "result", callId: "c1", value: 1 })).not.toThrow();
				expect(() => a.send({ type: "result", callId: "c2", value: 2 })).not.toThrow();
				await settle();
			} finally {
				await cleanup();
			}
		});

		it("declares its capabilities", async () => {
			const { a, cleanup } = await pair();
			try {
				expect(typeof a.send).toBe("function");
				expect(typeof a.onMessage).toBe("function");
				const caps = a.capabilities ?? {};
				expect(["none", "json", undefined]).toContain(caps.codec);
			} finally {
				await cleanup();
			}
		});
	});

	/**
	 * Attach a collecting handler to a channel.
	 * @param {object} channel - The channel to listen on.
	 * @returns {{ frames: object[], take: (n: number) => Promise<object[]> }} Collector.
	 */
	function collect(channel) {
		const frames = [];
		channel.onMessage((message) => frames.push(message));
		return {
			frames,
			/**
			 * @param {number} n - How many frames to wait for.
			 * @returns {Promise<object[]>} The first `n` frames.
			 */
			async take(n) {
				await waitFor(() => frames.length >= n);
				return frames.slice(0, n);
			}
		};
	}

	/**
	 * Poll until a predicate holds, or fail loudly rather than hanging the suite.
	 * @param {() => boolean} predicate - The condition.
	 * @returns {Promise<void>} Resolves once true.
	 */
	async function waitFor(predicate) {
		const deadline = Date.now() + WAIT_MS;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`slothlet-vine conformance: timed out after ${WAIT_MS}ms waiting for the transport`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	/**
	 * Let any pending microtask/macrotask delivery run.
	 * @returns {Promise<void>} Resolves on the next macrotask.
	 */
	function settle() {
		return new Promise((resolve) => setTimeout(resolve, 5));
	}
}
