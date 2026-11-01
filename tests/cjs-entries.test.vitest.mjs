/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/cjs-entries.test.vitest.mjs
 *	@Date: 2026-11-01T12:08:22-08:00 (1793563702)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:10:00-08:00 (1793563800)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Every public entry: its src path (without extension), a loader for its ESM module, and the names it
 * exports. The loaders are spelled out because Vite can't resolve a variable dynamic import that spans
 * folders.
 */
const ENTRIES = [
	{
		entry: "index",
		load: () => import("../src/index.mjs"),
		names: ["CODES", "DEFAULT_BUDGET_MS", "VineError", "VineRemoteError", "fromWire", "grow", "serve", "toWire"]
	},
	{ entry: "transport/loopback", load: () => import("../src/transport/loopback.mjs"), names: ["createChannel", "createPair"] },
	{ entry: "transport/post-message", load: () => import("../src/transport/post-message.mjs"), names: ["createChannel"] },
	{
		entry: "transport/worker-threads",
		load: () => import("../src/transport/worker-threads.mjs"),
		names: ["createChannel", "createParentChannel"]
	},
	{ entry: "transport/process", load: () => import("../src/transport/process.mjs"), names: ["createChannel", "createParentChannel"] },
	{ entry: "transport/websocket", load: () => import("../src/transport/websocket.mjs"), names: ["connect", "createChannel"] },
	{ entry: "testing/conformance", load: () => import("../src/testing/conformance.mjs"), names: ["channelConformance"] }
];

/** require(esm) adds an `__esModule` marker to the namespace it returns. */
const ownNames = (mod) =>
	Object.keys(mod)
		.filter((key) => key !== "__esModule")
		.sort();

describe("CommonJS entries (src)", () => {
	it.each(ENTRIES)("src/$entry.cjs exports the same names as src/$entry.mjs", async ({ entry, load, names }) => {
		const esm = await load();
		const cjs = require(`../src/${entry}.cjs`);
		expect(ownNames(esm)).toEqual(names);
		expect(ownNames(cjs)).toEqual(names);
		for (const name of names) expect(typeof cjs[name]).toBe(typeof esm[name]);
	});

	it("the CJS root carries the same error taxonomy", async () => {
		const esm = await import("../src/index.mjs");
		const { CODES, DEFAULT_BUDGET_MS } = require("../src/index.cjs");
		expect(CODES).toEqual(esm.CODES);
		expect(DEFAULT_BUDGET_MS).toBe(esm.DEFAULT_BUDGET_MS);
	});

	it("a loopback pair created through the CJS entry carries frames", async () => {
		const { createPair } = require("../src/transport/loopback.cjs");
		const [near, far] = createPair();
		const received = new Promise((resolve) => far.onMessage(resolve));
		near.send({ type: "ping" });
		await expect(received).resolves.toEqual({ type: "ping" });
		near.close?.();
		far.close?.();
	});

	describe("on a Node.js without require(esm)", () => {
		const original = Object.getOwnPropertyDescriptor(process.features, "require_module");
		const shim = require.resolve("../src/transport/loopback.cjs");

		afterEach(() => {
			Object.defineProperty(process.features, "require_module", original);
			delete require.cache[shim];
		});

		it("throws ERR_REQUIRE_ESM naming the entry and the supported Node.js range", () => {
			Object.defineProperty(process.features, "require_module", { value: false, configurable: true });
			delete require.cache[shim];
			let thrown;
			try {
				require(shim);
			} catch (error) {
				thrown = error;
			}
			expect(thrown?.code).toBe("ERR_REQUIRE_ESM");
			expect(thrown?.message).toMatch(/^@cldmv\/slothlet-vine\/transport\/loopback: require\(\) needs Node\.js >=22\.22\.0/);
		});
	});
});
