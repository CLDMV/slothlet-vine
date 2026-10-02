/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/conformance-harness.test.vitest.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:15-07:00 (1790968815)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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
