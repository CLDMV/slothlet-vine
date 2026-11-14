/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/resolve.test.vitest.mjs
 *	@Date: 2026-11-07T22:21:53-08:00 (1794118913)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-07T22:22:26-08:00 (1794118946)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The tests import "@cldmv/slothlet-vine" by name, so the slothlet-vine-dev condition decides what they run against: src/ for `npm test`, the
 * build in dist/ for `npm run test:dist` (`--mode=dist`). This checks the name resolved to that tree.
 */
import { describe, it, expect } from "vitest";
import * as pkg from "@cldmv/slothlet-vine";

describe("the @cldmv/slothlet-vine import", () => {
	it(`resolves to ${import.meta.env.MODE === "dist" ? "dist/" : "src/"}`, async () => {
		const expected = import.meta.env.MODE === "dist" ? await import("../dist/index.mjs") : await import("../src/index.mjs");
		expect(pkg.grow).toBe(expected.grow);
		expect(pkg.serve).toBe(expected.serve);
		expect(pkg.CODES).toBe(expected.CODES);
	});
});
