/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/events-api/events.mjs
 *	@Date: 2026-09-20T23:09:59-07:00 (1789970999)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:17-07:00 (1790968817)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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
