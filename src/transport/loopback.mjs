/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/loopback.mjs
 *	@Date: 2026-08-23T21:30:12-07:00 (1787545812)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:14-07:00 (1790968814)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Create a connected pair of loopback Channels. This is the primary surface: a loopback endpoint is
 * meaningless without its peer, so the pair — not a single channel — is the unit.
 * @returns {[object, object]} Two Channels; anything `a.send()`s arrives at `b`'s handler and vice versa.
 *
 * @example
 * const [a, b] = createPair();
 * b.onMessage((m) => console.log("b got", m));
 * a.send({ type: "ping" });
 */
export function createPair() {
	const a = makeEndpoint();
	const b = makeEndpoint();
	a._peer = b;
	b._peer = a;
	return [a, b];
}

/**
 * Create ONE loopback channel, with its peer reachable as `.peer`. Provided so every built-in
 * transport module exports `createChannel(...)` as the design requires; {@link createPair} is the
 * natural surface for loopback and the one to prefer.
 * @returns {object} A Channel whose `.peer` is the other end.
 *
 * @example
 * const channel = createChannel();
 * const serving = await serve(api, channel.peer);
 * const link = await grow(otherApi, channel);
 */
export function createChannel() {
	const [a, b] = createPair();
	a.peer = b;
	b.peer = a;
	return a;
}

/**
 * Build one unconnected endpoint. `_peer` is filled in by {@link createPair}.
 * @returns {object} A Channel implementation.
 */
function makeEndpoint() {
	/** @type {{ _peer: object|null, closed: boolean, handler: Function|null, onCloseHandler: Function|null, buffer: unknown[] }} */
	const endpoint = {
		_peer: null,
		closed: false,
		handler: null,
		onCloseHandler: null,
		buffer: [],

		capabilities: {
			structuredClone: true,
			codec: "none",
			/** Frames that arrive before `onMessage` are queued and replayed, never dropped. */
			buffersUntilHandler: true
		},

		/**
		 * Deliver one frame to the peer. A send on (or to) a closed endpoint is a silent no-op — the
		 * core is required to tolerate frames crossing a close, so the transport must not turn that
		 * race into an exception.
		 * @param {object} message - The frame.
		 * @returns {void}
		 */
		send(message) {
			if (endpoint.closed) return;
			const peer = endpoint._peer;
			if (!peer || peer.closed) return;
			queueMicrotask(() => {
				if (peer.closed) return;
				peer._deliver(message);
			});
		},

		/**
		 * Register the (single) receive handler; a second registration replaces the first. Anything
		 * buffered while no handler was registered is replayed, in order, on the next microtask.
		 * @param {(message: object) => void} handler - The receive handler.
		 * @returns {void}
		 */
		onMessage(handler) {
			endpoint.handler = typeof handler === "function" ? handler : null;
			if (!endpoint.handler || endpoint.buffer.length === 0) return;
			const queued = endpoint.buffer;
			endpoint.buffer = [];
			queueMicrotask(() => {
				for (const message of queued) endpoint._invoke(message);
			});
		},

		/**
		 * Register the (single) far-side-closure handler; a second registration replaces the first.
		 * @param {(info?: object) => void} handler - The close handler.
		 * @returns {void}
		 */
		onClose(handler) {
			endpoint.onCloseHandler = typeof handler === "function" ? handler : null;
		},

		/**
		 * Tear this end down. Idempotent. Fires the PEER's `onClose` — `onClose` is the far-side-death
		 * notification, so a locally-initiated close is not reported back to its own initiator. (A
		 * transport whose medium also reports the local close may fire both; the core tolerates it.)
		 * @returns {void}
		 */
		close() {
			if (endpoint.closed) return;
			endpoint.closed = true;
			endpoint.buffer = [];
			const peer = endpoint._peer;
			if (!peer || peer.closed) return;
			queueMicrotask(() => {
				if (typeof peer.onCloseHandler === "function") {
					try {
						peer.onCloseHandler({ reason: "peer-closed" });
					} catch {
						// A consumer handler must never surface as a transport fault.
					}
				}
			});
		},

		/**
		 * Accept an inbound frame: dispatch it, or buffer it until a handler exists.
		 * @param {unknown} message - The frame.
		 * @returns {void}
		 */
		_deliver(message) {
			if (endpoint.handler) endpoint._invoke(message);
			else endpoint.buffer.push(message);
		},

		/**
		 * Run the handler with the transport insulated from anything it throws.
		 * @param {unknown} message - The frame.
		 * @returns {void}
		 */
		_invoke(message) {
			try {
				endpoint.handler?.(message);
			} catch {
				// Contract: handlers never throw into the transport.
			}
		}
	};
	return endpoint;
}
