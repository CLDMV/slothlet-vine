/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/wt-func-api/leaf.mjs
 *
 * A serve-side leaf whose RETURN value contains a function. The vine is data-only in both directions,
 * so serve rejects this answer with `VINE_DATA_ONLY`; the grow side sees it as a `VINE_REMOTE` error
 * carrying `remoteCode: "VINE_DATA_ONLY"`. Isolated in its own fixture dir so the main serve fixtures
 * stay a clean data-only surface.
 */

/**
 * @returns {() => number} A live function — exactly what the vine refuses to send back.
 */
export function fn() {
	return () => 1;
}
