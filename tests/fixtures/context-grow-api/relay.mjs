/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/context-grow-api/relay.mjs
 *	@Date: 2026-10-06T12:00:00-07:00 (1791313200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-06T12:00:00-07:00 (1791313200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self } from "@cldmv/slothlet/runtime";

/**
 * A grow-side MODULE that calls a vine stub after an `await` — so a `link.with()` extent has to
 * survive both a module boundary and an async hop to reach the stub (#79).
 * @returns {Promise<unknown>} Whatever the far `work.read` answered.
 */
export async function read() {
	await new Promise((resolve) => setTimeout(resolve, 5));
	return self.work.read();
}
