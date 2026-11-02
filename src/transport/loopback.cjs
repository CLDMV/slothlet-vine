/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/loopback.cjs
 *	@Date: 2026-11-01T12:07:06-08:00 (1793563626)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T16:35:22-08:00 (1793579722)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

"use strict";

// CommonJS entry for @cldmv/slothlet-vine/transport/loopback. It loads the sibling ESM module through Node's
// synchronous require(esm), so there is one implementation and no second bundle. tsup copies
// this file verbatim into dist/ next to the built .mjs.
if (!process.features?.require_module) {
	const error = new Error(
		`@cldmv/slothlet-vine/transport/loopback: require() needs Node.js >=22.15.0 (this is ${process.version}). On older Node.js, load the package with import() instead.`
	);
	error.code = "ERR_REQUIRE_ESM";
	throw error;
}

module.exports = require("./loopback.mjs");
