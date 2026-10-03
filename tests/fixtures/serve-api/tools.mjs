/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/serve-api/tools.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:20-07:00 (1790968820)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/** How many times {@link secret} actually executed — proves a denied call never crossed. @type {number} */
let secretCalls = 0;

/**
 * @param {unknown} value - Anything data-shaped.
 * @returns {Promise<string>} The echoed value, tagged.
 */
export async function echo(value) {
	return `echo:${value}`;
}

/**
 * @param {number} ms - How long to take.
 * @returns {Promise<string>} A late answer, for budget tests.
 */
export async function slow(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return `slow:${ms}`;
}

/**
 * Throws an error carrying a name and a code, so the grow side can prove both survive the wire.
 * @returns {never} Always throws.
 */
export function boom() {
	const err = new Error("kaboom from the far side");
	err.name = "BoomError";
	err.code = "E_BOOM";
	throw err;
}

/**
 * The leaf a grow-side deny rule blocks. It counts its own executions.
 * @returns {Promise<string>} A value the denied caller must never see.
 */
export async function secret() {
	secretCalls++;
	return "top-secret";
}

/**
 * @returns {Promise<number>} How many times {@link secret} ran.
 */
export async function secretCallCount() {
	return secretCalls;
}
