/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-01T12:07:14-08:00 (1793563634)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:10:08-08:00 (1793563808)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config — produces the published dist/ output from src/.
 *
 * One ESM bundle per public entry (the root, each transport, the conformance harness), written
 * to the same relative path under dist/ as its source under src/. Each entry is self-contained
 * (no shared chunks). The CommonJS entries are not built: each `src/<entry>.cjs` is a thin
 * require(esm) wrapper around its sibling `<entry>.mjs`, and `onSuccess` copies it verbatim
 * into dist/ beside the bundle, so it never duplicates the library.
 *
 * `ws` (optional peer, loaded lazily by the websocket transport) stays external.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/** Public entries, keyed by their path under dist/ (without extension). */
const entries = {
	index: "src/index.mjs",
	"transport/loopback": "src/transport/loopback.mjs",
	"transport/post-message": "src/transport/post-message.mjs",
	"transport/worker-threads": "src/transport/worker-threads.mjs",
	"transport/process": "src/transport/process.mjs",
	"transport/websocket": "src/transport/websocket.mjs",
	"testing/conformance": "src/testing/conformance.mjs"
};

export default defineConfig({
	entry: entries,
	format: ["esm"],
	outDir: "dist",
	target: "node20",
	platform: "node",
	splitting: false,
	sourcemap: true,
	dts: false,
	minify: true,
	// Keep function and class names through minification (VineError.name, stack traces).
	keepNames: true,
	// Keep `node:` specifiers on built-in imports (tsup strips them by default).
	removeNodeProtocol: false,
	external: ["ws"],
	clean: true,
	outExtension() {
		return { js: ".mjs" };
	},
	// tsup calls this on the resolved options, so `this.outDir` is the directory the build
	// actually wrote to.
	onSuccess() {
		for (const name of Object.keys(entries)) copyFileSync(`src/${name}.cjs`, join(this.outDir, `${name}.cjs`));
	}
});
