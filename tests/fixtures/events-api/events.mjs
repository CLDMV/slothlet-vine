/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/events-api/events.mjs
 *
 * A real MODULE that subscribes to a FAR event through the vine — used on BOTH sides of a link in the
 * bidirectional tests, since the two instances are copies of one api. `event.on` attributes the
 * subscription to `api.slothlet.caller()` (this module's identity), the same on the grow link's
 * `event` surface and the serve handle's `event` surface, so one fixture drives either direction.
 */
import { self } from "@cldmv/slothlet/runtime";

const received = [];
let currentOff = null;

/**
 * Subscribe to a far event through the vine, AS this module — the subscription is attributed to this
 * module's identity, which the EMITTING instance resolves a delivery level for. Deliveries are buffered
 * for {@link drain}.
 * @param {{ event: { on: Function } }} surface - The vine event surface (`link.event` or the serve handle's `event`).
 * @param {string} eventName - Event to subscribe to.
 * @param {object} [opts] - Passed through to `event.on` (e.g. `{ once: true }`).
 * @returns {Promise<{ level: string, identity: string|null }>} The granted level and this module's captured identity.
 */
export async function subscribe(surface, eventName, opts) {
	const identity = self.slothlet.caller();
	const { level, off } = await surface.event.on(
		eventName,
		(payload, meta) => {
			received.push({ payload, meta });
		},
		opts
	);
	currentOff = off;
	return { level, identity };
}

/**
 * Unsubscribe the subscription made by {@link subscribe}, if any.
 * @returns {void}
 */
export function unsubscribe() {
	if (currentOff) {
		currentOff();
		currentOff = null;
	}
}

/**
 * Return and clear the buffered deliveries.
 * @returns {Array<{ payload: unknown, meta: object }>} Deliveries since the last drain.
 */
export function drain() {
	const out = received.slice();
	received.length = 0;
	return out;
}
