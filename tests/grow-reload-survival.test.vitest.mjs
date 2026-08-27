/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/grow-reload-survival.test.vitest.mjs
 *
 * A grow-side host may call slothlet's own `api.slothlet.api.reload()` on itself for reasons that have
 * nothing to do with the vine — its own base modules changed on disk, or it just wants a fresh eager
 * rebuild. `grow()` mounts stubs with the SYNTHETIC (bare-function) add form
 * (`api.slothlet.api.add(path, stub, { moduleID })`, see `grow.mjs`), and on slothlet <3.15.0 a base
 * `reload()` silently dropped synthetic adds from its operation-history replay: a grow-side host
 * reloading itself would lose every vine-mounted stub with no error and no `link.close()` ever being
 * called. Fixed upstream in CLDMV/slothlet#306 (v3.15.0 changelog: "a synthetic mount is no longer lost
 * on a base reload"). This pins the fixed behaviour — required no vine code change — so an upstream
 * regression is caught here rather than shipping quietly. Requires `@cldmv/slothlet >=3.15.0`.
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
