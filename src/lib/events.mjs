/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/events.mjs
 *
 * Symmetric event forwarding for ONE end of a vine. Both ends of a link carry an identical copy of
 * this: cross-vine event delivery is bidirectional, because the two linked instances are copies of the
 * same api (per-leaf stubs mounted at identical paths) and therefore hold the SAME event permissions.
 * An event fired in either instance reaches subscribers in the other as if it were one api.
 *
 * ## The one rule (slothlet's, not the vine's)
 *
 * slothlet gates SUBSCRIBERS, never emitters — an emit is open; each subscriber is resolved to one of
 * three delivery levels: `deny` (nothing), `notify` (a trigger, no payload), `allow` (trigger +
 * payload). The vine never invents a level or gates who may emit. It adds exactly one boundary rule:
 * **a subscriber only ever receives what its level allows, and nothing more than that is ever put on a
 * wire heading toward it.** Because the permissions are identical in every instance, the EMITTING side
 * can resolve any subscriber — local or across the vine — and send each remote one only what its level
 * permits, so a `notify` subscriber's payload never crosses. Whichever side resolves it gets the same
 * answer, so no trust flag, no authority handoff, no emit policy is needed.
 *
 * ## Two halves, both on every end
 *
 * - **server half** — a far `sub` for one of THIS instance's events: resolve the far subscriber's level
 *   HERE against this instance's rules, ack it (so a downgrade/denial is a catchable result, not a
 *   silent absence), host-subscribe, and forward each emit cut to that level — re-resolved per emit so a
 *   live rule change is honoured. Keyed by the FAR side's `subId` in {@link incoming}.
 * - **subscriber half** — {@link subscribe} sends a `sub` for a FAR event (carrying this subscriber's
 *   own `api.slothlet.caller()` identity, never one asserted for someone else) and delivers the far
 *   `event` frames to a local listener. Keyed by OUR `subId` in {@link outgoing}.
 *
 * The two ends never collide: each draws its outgoing `subId`s from its own nonce, and frames are routed
 * by TYPE (`sub`/`unsub` → server half, `sub-ack`/`event` → subscriber half), so the same four frames
 * flow both ways over one channel.
 */
import { CODES, VineError } from "./errors.mjs";
import { SUB_LEVELS, eventFrame, findFunctionArg, subAckFrame, subFrame, unsubFrame } from "./frame.mjs";
import { PendingTable, makeNonce } from "./link.mjs";

/**
 * Build the event-forwarding half of one vine end.
 * @param {object} params
 * @param {object} params.api - The local slothlet instance.
 * @param {import("../index.mjs").Channel} params.channel - The transport seam (used for `send`).
 * @param {number} params.budgetMs - Per-subscribe-handshake settle budget (a `sub-ack` that never
 *   arrives settles `VINE_BUDGET`).
 * @param {() => ("gone"|"closed"|null)} params.ended - The end's terminal state, so a subscribe made
 *   after teardown fails loudly and a forward after teardown is dropped. `serve` has no `gone`.
 * @returns {{ subscribe: Function, handleFrame: (frame: object) => void, teardown: (opts: {sendUnsubs: boolean}) => void }}
 */
export function createEventForwarder({ api, channel, budgetMs, ended }) {
	const eventApi = api.slothlet?.event;
	// Serving a subscription (resolve + host-subscribe) needs the trusted-side resolver + subscribe
	// surface (slothlet ≥ 3.18.0). Without them a far `sub` is refused with a catchable `deny` rather
	// than forwarded ungated — the vine never carries a payload it cannot gate.
	const canServe = typeof eventApi?.resolveLevel === "function" && typeof eventApi?.on === "function";
	const hasCaller = typeof api.slothlet?.caller === "function";

	/**
	 * Far subscriptions to OUR events, keyed by the FAR side's `subId`. `off` is slothlet's own
	 * unsubscribe for the host-level listener that fans this event across the boundary.
	 * @type {Map<string, { off: () => void, event: string }>}
	 */
	const incoming = new Map();

	/** Settles each OUTGOING subscribe handshake exactly once (resolving with the granted level). */
	const acks = new PendingTable(makeNonce());
	/**
	 * OUR subscriptions to far events, keyed by OUR `subId`; a delivered `event` frame fans out here.
	 * @type {Map<string, { listener: Function, event: string, level: string, once: boolean }>}
	 */
	const outgoing = new Map();

	/**
	 * Hand a frame to the transport, swallowing a send failure (a dead socket, a frame crossing a
	 * close). Event frames carry no `callId`, so there is nothing to settle in reply — teardown settles
	 * anything still pending.
	 * @param {object} frame - The frame to send.
	 * @returns {void}
	 */
	function trySend(frame) {
		try {
			channel.send(frame);
		} catch {
			// The channel is unusable; teardown (gone/closed) settles the rest.
		}
	}

	// ---- server half: a far side subscribes to OUR events ----

	/**
	 * Answer a `sub` frame: resolve the far subscriber's level on THIS instance, ack it, and — unless
	 * denied — host-subscribe and forward each emit cut to that subscriber's level. The level is
	 * re-resolved on EVERY emit so a rule change that downgrades it (allow → notify → deny) is honoured
	 * live, and a `notify` subscriber's payload never leaves this instance.
	 * @param {{ subId: string, event: string, subscriberPath: string|null }} frame - The parsed sub.
	 * @returns {void}
	 */
	function accept(frame) {
		const { subId, event, subscriberPath } = frame;
		// A repeated subId (a buggy or hostile far side) must never leak a second live listener.
		if (incoming.has(subId)) return;
		if (!canServe) {
			sendAck(subId, "deny");
			return;
		}
		let level;
		try {
			level = eventApi.resolveLevel(subscriberPath, event);
		} catch {
			level = "deny";
		}
		if (!SUB_LEVELS.has(level)) level = "deny";
		sendAck(subId, level);
		if (level === "deny") return;

		let off;
		try {
			({ off } = eventApi.on(event, (payload, meta) => {
				if (ended() || !incoming.has(subId)) return;
				let current;
				try {
					current = eventApi.resolveLevel(subscriberPath, event);
				} catch {
					current = "deny";
				}
				if (current === "deny") return; // revoked since subscribe — forward nothing
				// Data-only, the half only this side can enforce: a function anywhere in the payload cannot
				// cross (over a by-reference transport it would hand the far side a live closure over this
				// scope), so an `allow` delivery whose payload hides a function degrades to trigger-only.
				const withPayload = current === "allow" && findFunctionArg([payload]) === null;
				trySend(eventFrame(subId, meta, withPayload, payload));
			}));
		} catch {
			// The instance refused the host subscription (a lockdown that denies even the host). Nothing
			// is registered; the far side has its non-deny ack and receives nothing until it unsubs.
			return;
		}
		incoming.set(subId, { off, event });
	}

	/**
	 * Tear down one incoming subscription — a far `unsub`, or {@link teardown}.
	 * @param {string} subId - The subscription id (drawn from the FAR side's space).
	 * @returns {void}
	 */
	function drop(subId) {
		const sub = incoming.get(subId);
		if (!sub) return;
		incoming.delete(subId);
		try {
			sub.off();
		} catch {
			// Best effort: the entry is already gone from our registry, so no further emit forwards.
		}
	}

	/**
	 * Ack a subscription with its resolved level. Separated so the fail-closed `deny` path and the
	 * resolved path share one send.
	 * @param {string} subId - The subscription being answered.
	 * @param {"deny"|"notify"|"allow"} level - The resolved level.
	 * @returns {void}
	 */
	function sendAck(subId, level) {
		trySend(subAckFrame(subId, level));
	}

	// ---- subscriber half: WE subscribe to a far event ----

	/**
	 * Subscribe a local listener to a FAR event over this link. This subscriber's own identity is
	 * captured (via `api.slothlet.caller()`) and sent to the far side, which resolves its delivery level
	 * against the far instance's (identical) rules and sends only what that level permits — so this side
	 * never trusts a level it computed locally, and never receives a payload the far side withheld.
	 *
	 * Settles with `{ level, off }`: the GRANTED level, so a downgrade or denial is a distinct, catchable
	 * result rather than a silent absence of deliveries. At `deny` the listener is never registered and
	 * `off` is a no-op.
	 * @param {string} eventName - The far event to subscribe to.
	 * @param {Function} listener - Called `(payload, meta)` per delivery; `payload` is `undefined` at
	 *   `notify`, `meta` is `{ event, at, instanceID }`.
	 * @param {boolean} once - Remove the subscription after its first delivery.
	 * @returns {Promise<{ level: "deny"|"notify"|"allow", off: () => void }>} Granted level + unsubscribe.
	 * @throws {TypeError} For a bad event name / listener, or when the local slothlet predates the
	 *   `api.slothlet.caller()` accessor (slothlet ≥ 3.18.0 is required for event forwarding).
	 * @throws {VineError} `VINE_GONE` / `VINE_CLOSED` when the link has already ended.
	 */
	async function subscribe(eventName, listener, once) {
		if (typeof eventName !== "string" || eventName.length === 0) {
			throw new TypeError("@cldmv/slothlet-vine: event.on() needs a non-empty event name");
		}
		if (typeof listener !== "function") {
			throw new TypeError("@cldmv/slothlet-vine: event.on() needs a listener function");
		}
		if (!hasCaller) {
			throw new TypeError("@cldmv/slothlet-vine: event forwarding needs api.slothlet.caller() — slothlet ≥ 3.18.0 is required");
		}
		const end = ended();
		if (end === "gone") throw new VineError(CODES.GONE, "slothlet-vine: cannot subscribe — the far side of the link is gone");
		if (end === "closed") throw new VineError(CODES.CLOSED, "slothlet-vine: cannot subscribe — the link is closed");

		// Capture the subscriber's real identity NOW, synchronously, while its extent is still the active
		// caller — before the first await, after which the ambient context is no longer guaranteed.
		const subscriberPath = api.slothlet.caller();
		const subId = acks.nextCallId();
		const acked = acks.open(subId, { path: eventName, budgetMs });
		try {
			channel.send(subFrame(subId, eventName, subscriberPath));
		} catch (err) {
			acks.reject(
				subId,
				new VineError(CODES.BAD_FRAME, `slothlet-vine: subscribe to '${eventName}' could not be sent: ${err?.message ?? String(err)}`, {
					event: eventName
				})
			);
		}
		// Settles with the granted level, or rejects VINE_GONE / VINE_CLOSED / VINE_BUDGET / VINE_BAD_FRAME.
		const level = await acked;
		if (level === "deny") return { level, off: () => {} };

		/**
		 * Unsubscribe: stop local delivery and tell the far side to drop its host-level listener.
		 * @returns {void}
		 */
		const off = () => {
			if (!outgoing.has(subId)) return;
			outgoing.delete(subId);
			trySend(unsubFrame(subId));
		};
		outgoing.set(subId, { listener, event: eventName, level, once });
		return { level, off };
	}

	/**
	 * Deliver one forwarded `event` frame to its subscription's listener. `hasPayload` — the presence of
	 * the `payload` key on the wire — distinguishes an `allow` delivery (payload, possibly `undefined`)
	 * from a `notify` one (no payload); the listener is called `(payload, meta)` exactly as slothlet's
	 * own listener is. A `once` subscription is torn down before delivery.
	 * @param {{ subId: string, event: string, at: number, instanceID: string, hasPayload: boolean, payload?: unknown }} frame - The parsed event.
	 * @returns {void}
	 */
	function deliver(frame) {
		const sub = outgoing.get(frame.subId);
		if (!sub) return; // unknown, or already unsubscribed locally
		const meta = { event: frame.event, at: frame.at, instanceID: frame.instanceID };
		const payload = frame.hasPayload ? frame.payload : undefined;
		if (sub.once) {
			outgoing.delete(frame.subId);
			trySend(unsubFrame(frame.subId));
		}
		try {
			sub.listener(payload, meta);
		} catch {
			// A subscriber's listener error must never break the link or the transport — the same
			// per-listener isolation slothlet's own event system provides locally.
		}
	}

	/**
	 * Route one parsed frame to the right half. Both ends call this for every event-forwarding frame;
	 * the TYPE decides the half, so a colliding subId across ends could never cross wires anyway.
	 * @param {object} frame - A parsed `sub` / `unsub` / `sub-ack` / `event` frame.
	 * @returns {void}
	 */
	function handleFrame(frame) {
		switch (frame.type) {
			case "sub":
				accept(frame);
				break;
			case "unsub":
				drop(frame.subId);
				break;
			case "sub-ack":
				acks.resolve(frame.subId, frame.level);
				break;
			case "event":
				deliver(frame);
				break;
		}
	}

	/**
	 * Tear down BOTH halves. Drops every incoming host-level listener; clears outgoing subscriptions and
	 * settles their pending handshakes. `sendUnsubs` tells the far side to drop our outgoing
	 * subscriptions — done on a local close (the link still works), skipped on far-side death (nothing
	 * left to tell).
	 * @param {{ sendUnsubs: boolean }} opts - Whether to notify the far side of our outgoing subs.
	 * @returns {void}
	 */
	function teardown({ sendUnsubs }) {
		for (const sub of incoming.values()) {
			try {
				sub.off();
			} catch {
				// Best effort; the registry is cleared next regardless.
			}
		}
		incoming.clear();
		if (sendUnsubs) for (const subId of outgoing.keys()) trySend(unsubFrame(subId));
		outgoing.clear();
		acks.settleAll(
			sendUnsubs ? CODES.CLOSED : CODES.GONE,
			sendUnsubs ? "slothlet-vine: the link was closed" : "slothlet-vine: the far side of the link is gone"
		);
	}

	return { subscribe, handleFrame, teardown };
}
