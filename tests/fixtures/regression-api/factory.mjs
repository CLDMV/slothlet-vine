/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/regression-api/factory.mjs
 *
 * Leaves that probe the data-only rule from the serving side, in both directions: RETURN values (a
 * bare function, a function buried in an object graph, and the data-only control that must still
 * cross untouched) and a call ARGUMENT received raw off the wire.
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

/**
 * A leaf that accepts one argument and echoes it back. The body must never run when the argument
 * hides a function — `serve()` refuses that before invocation — so reaching this line at all is
 * itself a test failure.
 * @param {unknown} value - Whatever a caller sends.
 * @returns {{ ran: true, value: unknown }} Proof the leaf executed, echoing what it received.
 */
export function receive(value) {
	return { ran: true, value };
}
