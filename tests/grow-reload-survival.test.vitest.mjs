/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/grow-reload-survival.test.vitest.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:21-07:00 (1790968821)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { createPair } from "../src/transport/loopback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GROW_DIR = path.join(here, "fixtures", "grow-api");
const SERVE_DIR = path.join(here, "fixtures", "serve-api");

/** @type {Array<() => Promise<void>>} */
let teardown = [];
afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try {
			await fn();
		} catch {
			// teardown must not mask the assertion
		}
	}
	teardown = [];
});

describe("a grow-side host's own reload() no longer drops vine's mounted stubs", () => {
	it("survives api.slothlet.api.reload() with the link still mounted and callable", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(async () => {
			await serveApi.slothlet?.shutdown?.();
		});
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => {
			await growApi.slothlet?.shutdown?.();
		});

		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		teardown.push(() => serving.close());
		const link = await grow(growApi, near, { budgetMs: 5000 });
		teardown.push(async () => {
			await link.close();
		});

		expect(typeof growApi.math.add).toBe("function");
		expect(await growApi.math.add(2, 3)).toBe(5);

		// The host reloads ITSELF for reasons that have nothing to do with the vine.
		await growApi.slothlet.api.reload();

		// The stub survives the reload and still forwards correctly — no vine code was involved in
		// preserving it; this is entirely slothlet's own replay now doing the right thing.
		expect(typeof growApi.math.add).toBe("function");
		expect(await growApi.math.add(2, 3)).toBe(5);
		expect(link.leaves).toContain("math.add");
	});
});
