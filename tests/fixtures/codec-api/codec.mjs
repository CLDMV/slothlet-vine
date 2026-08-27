/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/codec-api/codec.mjs
 *
 * Serve-side probes for the websocket JSON codec's DOCUMENTED, lossy-but-VALID degradations. Each
 * leaf returns (or echoes) a rich value so the grow side can assert exactly how `codec: "json"`
 * reshapes it — a `Date` to an ISO string, a `Map`/`Set` to `{}` — proving the frame still crosses
 * predictably rather than corrupting or crashing the socket.
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
