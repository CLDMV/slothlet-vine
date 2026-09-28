/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/principal-api/host/deps.mjs
 *
 * Serve-side fixture for the channel-principal e2e (#33): the public `host.**` surface every remote
 * principal is allowed to reach.
 */

/**
 * @returns {string[]} A fixed dependency list.
 */
export function list() {
	return ["slothlet", "slothlet-vine"];
}
