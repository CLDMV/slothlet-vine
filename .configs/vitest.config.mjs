/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:09:50-08:00 (1793563790)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { defineConfig, mergeConfig } from "vitest/config";
import { devCondition } from "@cldmv/configs/vitest.config.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Anchor the project root to the package directory so include/exclude work no
// matter what cwd vitest is invoked from.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// devCondition() reads the package's "-dev" export condition and sets resolve/ssr conditions plus test.execArgv, so
// Vite and the Node workers both load src/.
export default mergeConfig(
	devCondition({ root }),
	defineConfig({
		root,
		test: {
			include: ["tests/**/*.test.vitest.mjs"],
			exclude: ["node_modules"],
			environment: "node",
			testTimeout: 30000,
			// "dot" keeps CI logs to one character per test file instead of a full
			// "RUN vX.Y.Z" + per-file pass/fail block for every file — vitest's
			// non-interactive fallback (no TTY to redraw) otherwise reprints that
			// whole block per file on top of the final aggregate summary, which
			// dominates the log on a suite this size. The final "Test Files X
			// passed" / "Tests Y passed" summary is unaffected — every built-in
			// reporter prints it regardless of per-test verbosity.
			reporters: ["dot"],
			coverage: {
				provider: "v8",
				include: ["src/**/*.mjs"],
				exclude: ["**/*.json", "tests/**"],
				reporter: ["text", "html", "json-summary", "json"],
				// The standard for this repo is full coverage; a drop fails the run instead of drifting. The runner
				// runs each test file in its own coverage process and then merges the blobs, so a threshold can only
				// be judged on the merge step (`--mergeReports`): a single file never covers the whole of src/.
				thresholds: process.argv.includes("--mergeReports") ? { lines: 100, branches: 100, functions: 100, statements: 100 } : undefined
			}
		}
	})
);
