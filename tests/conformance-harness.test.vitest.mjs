/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/conformance-harness.test.vitest.mjs
 *
 * The conformance harness's OWN internal safety net: `waitFor()` fails loudly with a named timeout
 * rather than hanging the suite forever when a transport under test never actually delivers anything.
 * That is the harness protecting itself against a broken (or not-yet-working) consumer-written
 * transport, so it belongs to the harness's own test surface, not to any one built-in transport.
 *
 * `channelConformance` takes its test framework (`describe`/`it`/`expect`) INJECTED, which is exactly
 * the hook this needs: intercept `it()` to CAPTURE each case instead of registering it with vitest, run
 * only the one case that reaches `waitFor` (the simplest delivery case), and assert on ITS rejection
 * directly — without ever letting a suite that is deliberately broken register as thirteen real,
 * failing vitest tests.
 */
import { describe, it, expect } from "vitest";
import { channelConformance } from "../src/testing/conformance.mjs";

describe("conformance harness — waitFor() timeout", () => {
	it("rejects with a named timeout instead of hanging when the transport never delivers", async () => {
		/** @type {Array<{name: string, fn: () => unknown}>} Cases captured instead of run by vitest. */
		const captured = [];
		const fakeT = {
			describe(name, fn) {
				fn();
			},
			it(name, fn) {
				captured.push({ name, fn });
			},
			expect
		};
		// send() never delivers anything — collect(b).take(1) inside the case below can only resolve
		// via a real delivery, so it is forced onto the WAIT_MS timeout path.
		const deadPair = () => [
			{ send() {}, onMessage() {} },
			{ send() {}, onMessage() {} }
		];
		channelConformance("deliberately broken (never delivers)", deadPair, fakeT);

		const deliveryCase = captured.find((c) => c.name === "delivers a frame from a to b");
		expect(deliveryCase).toBeDefined();
		await expect(deliveryCase.fn()).rejects.toThrow(/slothlet-vine conformance: timed out after 2000ms/);
	}, 10_000);
});
