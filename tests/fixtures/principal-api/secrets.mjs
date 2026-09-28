/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/principal-api/secrets.mjs
 *
 * Serve-side fixture for the channel-principal e2e (#33): a leaf OUTSIDE the served `paths`, so a call
 * to it is `VINE_NO_LEAF` for every principal — the surface filter is the outer boundary and runs first.
 */

/**
 * @returns {string} Something no channel should ever be offered.
 */
export function dump() {
	return "s3cret";
}
