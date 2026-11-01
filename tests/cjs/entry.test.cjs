/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/cjs/entry.test.cjs
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

"use strict";

// Checks the build itself (run by `npm run test:dist` after `npm run build`): every published
// CommonJS entry in dist/ is a thin wrapper that re-exports its sibling ESM bundle.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const dist = path.join(root, "dist");
const pkg = require(path.join(root, "package.json"));

const ENTRIES = [
	["index", ["CODES", "DEFAULT_BUDGET_MS", "VineError", "VineRemoteError", "fromWire", "grow", "serve", "toWire"]],
	["transport/loopback", ["createChannel", "createPair"]],
	["transport/post-message", ["createChannel"]],
	["transport/worker-threads", ["createChannel", "createParentChannel"]],
	["transport/process", ["createChannel", "createParentChannel"]],
	["transport/websocket", ["connect", "createChannel"]],
	["testing/conformance", ["channelConformance"]]
];

for (const [entry, names] of ENTRIES) {
	test(`dist/${entry}.cjs re-exports dist/${entry}.mjs`, async () => {
		const esm = await import(pathToFileURL(path.join(dist, `${entry}.mjs`)).href);
		const cjs = require(path.join(dist, `${entry}.cjs`));
		// require(esm) adds an `__esModule` marker to the namespace it returns.
		const cjsNames = Object.keys(cjs)
			.filter((key) => key !== "__esModule")
			.sort();
		assert.deepEqual(cjsNames, names);
		assert.deepEqual(Object.keys(esm).sort(), names);
		for (const name of names) assert.equal(cjs[name], esm[name], `${entry}: ${name} is a different value`);
	});

	test(`dist/${entry}.cjs is the verbatim copy of src/${entry}.cjs`, () => {
		assert.equal(fs.readFileSync(path.join(dist, `${entry}.cjs`), "utf8"), fs.readFileSync(path.join(root, "src", `${entry}.cjs`), "utf8"));
	});
}

test("every exports subpath points at files the build produced", () => {
	for (const [subpath, target] of Object.entries(pkg.exports)) {
		if (typeof target === "string") continue;
		for (const condition of ["import", "require"]) {
			assert.ok(fs.existsSync(path.join(root, target[condition])), `${subpath} → ${target[condition]} is missing`);
			assert.ok(fs.existsSync(path.join(root, target["slothlet-vine-dev"][condition])), `${subpath} (dev) is missing`);
		}
	}
});

test("a vine grown over the built CJS entries forwards a call", async () => {
	const { grow, serve } = require(path.join(dist, "index.cjs"));
	const { createPair } = require(path.join(dist, "transport/loopback.cjs"));
	const { default: slothlet } = await import("@cldmv/slothlet");
	const serveApi = await slothlet({ base: path.join(root, "tests/fixtures/serve-api"), silent: true });
	const growApi = await slothlet({ base: path.join(root, "tests/fixtures/grow-api"), silent: true });
	try {
		const [near, far] = createPair();
		const serving = await serve(serveApi, far, { paths: ["math"] });
		const link = await grow(growApi, near, { budgetMs: 5000 });
		try {
			assert.deepEqual(link.leaves, ["math.add"]);
			assert.equal(await growApi.math.add(2, 3), 5);
		} finally {
			await link.close();
			serving.close();
		}
	} finally {
		await growApi.slothlet.shutdown();
		await serveApi.slothlet.shutdown();
	}
});
