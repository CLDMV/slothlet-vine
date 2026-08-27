/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/grow-api/caller.mjs
 *
 * Grow-side fixture: a real MODULE that reaches the forwarded leaves through `self`.
 *
 * It has to be a module, not the test itself: slothlet's permission gate exempts the host's bound
 * `api` handle by design (host standing), so a deny rule only bites when a module makes the call.
 * That is exactly the shape the e2e permission assertion needs.
 */
import { self } from "@cldmv/slothlet/runtime";

/**
 * @param {unknown} value - Payload to forward.
 * @returns {Promise<string>} Whatever the far side echoed.
 */
export async function echo(value) {
	return self.tools.echo(value);
}

/**
 * The call a deny rule blocks — it must never reach the far side.
 * @returns {Promise<string>} Never resolves in a denied configuration.
 */
export async function secret() {
	return self.tools.secret();
}
