/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/grow-api/caller.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:18-07:00 (1790968818)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { self } from "@cldmv/slothlet/runtime";

/**
 * @param {unknown} value - Payload to forward.
 * @returns {Promise<string>} Whatever the far side echoed.
 */
export async function echo(value) {
	return self.tools.echo(value);
}

/**
 * The call a deny rule blocks — it must never reach the far side.
 * @returns {Promise<string>} Never resolves in a denied configuration.
 */
export async function secret() {
	return self.tools.secret();
}
