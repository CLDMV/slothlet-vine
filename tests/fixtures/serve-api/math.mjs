/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/serve-api/math.mjs
 *
 * Serve-side fixture: a SYNCHRONOUS leaf plus a DATA export. The data export is load-bearing for the
 * suite — a callable surface must not publish `math.answer`.
 */

/**
 * @param {number} a - Left operand.
 * @param {number} b - Right operand.
 * @returns {number} The sum.
 */
export function add(a, b) {
	return a + b;
}

/** A non-callable export — never part of a served surface. @type {number} */
export const answer = 42;
