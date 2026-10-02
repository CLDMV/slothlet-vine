/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/codec-api/codec.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:17-07:00 (1790968817)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @returns {Date} A fixed instant; over JSON it arrives grow-side as its ISO string.
 */
export function when() {
	return new Date("2020-01-02T03:04:05.000Z");
}

/**
 * @returns {Map<string, number>} Entries that JSON cannot represent — arrives as `{}`.
 */
export function pairs() {
	return new Map([["a", 1]]);
}

/**
 * @returns {Set<number>} Members that JSON cannot represent — arrives as `{}`.
 */
export function members() {
	return new Set([1, 2, 3]);
}

/**
 * @param {unknown} value - Anything data-shaped; returned unchanged so the grow side sees how the
 *   codec reshaped the ARGUMENT on the way in.
 * @returns {Promise<unknown>} The value as this side received it.
 */
export async function echo(value) {
	return value;
}
