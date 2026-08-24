/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/regression-api/factory.mjs
 *
 * Leaves whose RETURN values probe the data-only rule from the serving side: a bare function, a
 * function buried in an object graph, and the data-only control that must still cross untouched.
 */

/**
 * @returns {() => string} A live closure over this side's scope — never allowed onto the wire.
 */
export function make() {
	return () => "escaped";
}

/**
 * @returns {{ ok: number, deep: { onDone: () => void } }} A function hidden one level down.
 */
export function nested() {
	return { ok: 1, deep: { onDone: () => {} } };
}

/**
 * @returns {{ ok: number, list: number[] }} Ordinary data, which must still round-trip.
 */
export function plain() {
	return { ok: 1, list: [1, 2, 3] };
}
