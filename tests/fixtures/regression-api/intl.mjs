/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/regression-api/intl.mjs
 *
 * A module whose EXPORT name is outside the ASCII identifier alphabet. slothlet sanitizes file and
 * directory names, not export names, so `café` is a real, callable, `leaves()`-reported leaf — the
 * case an ASCII-only path guard used to drop from a served surface without a word.
 */

/**
 * @returns {string} A drink.
 */
export function café() {
	return "coffee";
}

/**
 * The ASCII control: whatever happens to `café`, this one is never in doubt.
 * @returns {string} A marker.
 */
export function ok() {
	return "ok";
}
