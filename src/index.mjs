/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/index.mjs
 *
 * Vines between slothlet api trees — location-transparent forwarding leaves over an injected
 * Channel. PRE-IMPLEMENTATION SCAFFOLD: the API surface below is the design contract; bodies land
 * with the browser spike. See README.md.
 */

/**
 * The transport seam every vine rides on. Implement this (plus a capability declaration) to plug in
 * a custom transport; the bridge consumes ONLY this interface.
 * @typedef {object} Channel
 * @property {(message: unknown) => void} send
 * @property {(handler: (message: unknown) => void) => void} onMessage
 * @property {() => void} [close]
 */

const NOT_IMPLEMENTED = (name) => {
	throw new Error(`@cldmv/slothlet-vine: ${name} is not implemented yet (pre-release scaffold — see the repo README)`);
};

/**
 * Grow a vine FROM this instance TO a far tree: mount forwarding-stub leaves (from the far side's
 * leaf manifest) into `api` over `channel`, permission-gated by slothlet itself.
 * @param {object} api — the local slothlet instance
 * @param {Channel} channel
 * @param {object} [options]
 */
export function growVine(api, channel, options) {
	NOT_IMPLEMENTED("growVine");
}

/**
 * Serve this instance's leaves TO a far tree: answer call frames arriving on `channel` by invoking
 * the real leaves (re-checking permissions on this side), and publish the leaf manifest.
 * @param {object} api — the local slothlet instance
 * @param {Channel} channel
 * @param {object} [options]
 */
export function serveVine(api, channel, options) {
	NOT_IMPLEMENTED("serveVine");
}
