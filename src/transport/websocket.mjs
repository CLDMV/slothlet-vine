/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/websocket.mjs
 *
 * The websocket transport — a {@link Channel} over a single `ws` WebSocket. This is the one BYTE
 * transport in v1: the medium carries strings, so the channel owns its own encode/decode
 * (`capabilities.codec: "json"`) rather than relying on structured clone the way the postMessage
 * family does.
 *
 * ## The v1 JSON codec — and what it degrades (honest limitations)
 *
 * Frames cross as `JSON.stringify(frame)` and are rebuilt with `JSON.parse`. That is faithful for the
 * data-only, plain-object frame shapes the vine actually sends, but JSON is lossy for richer values a
 * leaf's args/return might contain:
 *
 * - `Date` → an ISO **string** (not a `Date`); the grow side receives the string.
 * - `Map` / `Set` → `{}` (their entries are lost entirely).
 * - `Symbol` → dropped: a symbol-valued property vanishes, a symbol array element becomes `null`.
 * - `undefined` object properties and array holes → dropped / `null`.
 * - `TypedArray` / `ArrayBuffer` / `Buffer` → a plain object of indices, not the buffer.
 *
 * Those are lossy-but-VALID degradations — the frame still crosses. A `BigInt` is different: it
 * THROWS in `JSON.stringify`, so the codec cannot encode the frame at all. That is a per-call REFUSAL
 * (not a degradation and not a dead socket): `send()` re-raises it and the core settles just that call
 * `VINE_BAD_FRAME`, consistent with the structured-clone transports rejecting an un-cloneable frame —
 * the link and every other in-flight call stay alive.
 *
 * These are inherent to `codec: "json"`; a richer byte codec is a future capability
 * (see `docs/DESIGN.md` § Non-goals). Consumers who need `Date`/`Map`/`Set` fidelity should use a
 * structured-clone transport (postMessage family) or wait for a richer codec.
 *
 * ## Capabilities & the choices behind them
 *
 * `{ structuredClone: false, codec: "json", buffersUntilHandler: false }`.
 *
 * - **`buffersUntilHandler: false`** — a message that arrives before `onMessage` has a handler is
 *   DROPPED, not replayed. `ws` does not queue emitted events; honouring that honestly is more
 *   truthful than faking a buffer this medium does not have. It is safe in practice because both
 *   `serve()` and `grow()` register their receive handler synchronously, before the socket can
 *   deliver anything (a client socket only starts delivering after its async `open`).
 * - **Send before `OPEN` is BUFFERED, then flushed on `open`.** A client `new WebSocket(url)` connects
 *   asynchronously, so `send()` may be called on a `CONNECTING` socket; queuing until `open` (rather
 *   than erroring) is the faithful choice for a socket that simply is not ready yet. A send on a
 *   `CLOSING`/`CLOSED` socket is a silent no-op — the core is required to tolerate frames crossing a
 *   close, so the transport must not turn that race into a throw.
 * - **`close()` CLOSES the underlying socket** (not merely detaching listeners). A `ws` socket is 1:1
 *   with its channel, so a socket with no channel is dead weight; more decisively, the Channel
 *   conformance suite asserts that closing one end fires the OTHER end's `onClose`, and over a real
 *   socket that is only observable if `close()` actually closes the socket. This is the one place the
 *   websocket transport diverges from the "detach only" option the port-wrapping transports may take.
 * - **A locally-initiated `close()` does not fire this end's own `onClose`.** `onClose` is the
 *   far-side-death notification (mirroring loopback); only the far end's close/error, or a network
 *   drop, reports through it.
 *
 * ## The optional `ws` peer dependency
 *
 * `ws` is an OPTIONAL peer dependency, imported by NOTHING in the core — only here, and only lazily.
 * {@link createChannel} wraps a socket the caller already constructed, so it needs no import (a live
 * `ws` socket is itself proof `ws` is installed). {@link connect} is the one entry point that
 * CONSTRUCTS a client socket, so it is the one that imports `ws` — and it is where a clear
 * "install the optional peer dependency 'ws'" error is thrown when the import fails.
 */

/** WHATWG WebSocket `readyState` values (`ws` conforms). @type {number} */
const CONNECTING = 0;
/** @type {number} */
const OPEN = 1;

/** One decoder for every inbound binary frame — `ws` delivers text as a `Buffer` by default. */
const DECODER = new TextDecoder();

/**
 * Wrap an existing `ws` WebSocket in a {@link Channel}. Accepts either a client socket
 * (`new WebSocket(url)`) or a socket handed to a `WebSocketServer` `'connection'` handler — they
 * share the same instance surface (`send`, `on`, `close`, `readyState`).
 *
 * @param {object} socket - A `ws` WebSocket instance (client or server-accepted).
 * @param {object} [options] - Reserved for forward compatibility (none in v1).
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `socket` does not expose the `ws` instance surface.
 *
 * @example
 * import { WebSocketServer } from "ws";
 * import { createChannel } from "@cldmv/slothlet-vine/transport/websocket";
 * import { serve } from "@cldmv/slothlet-vine";
 *
 * const wss = new WebSocketServer({ port: 0 });
 * wss.on("connection", async (socket) => {
 *   await serve(api, createChannel(socket), { paths: ["exts"] });
 * });
 */
export function createChannel(socket, options) {
	void options;
	if (
		!socket ||
		typeof socket.send !== "function" ||
		typeof socket.on !== "function" ||
		typeof socket.close !== "function" ||
		typeof socket.readyState !== "number"
	) {
		throw new TypeError(
			"@cldmv/slothlet-vine: transport/websocket createChannel(socket) requires a `ws` WebSocket instance (send/on/close/readyState)."
		);
	}

	/** The single receive handler; last `onMessage` registration wins. @type {Function|null} */
	let messageHandler = null;
	/** The single far-side-death handler. @type {Function|null} */
	let closeHandler = null;
	/** Frames sent while the socket was still `CONNECTING`, flushed on `open`. @type {string[]} */
	const pendingSends = [];
	/** True once this end initiated `close()` — suppresses this end's own `onClose`. */
	let localClosing = false;
	/** True once `onClose` has fired — it fires at most once (close OR error, whichever first). */
	let closeNotified = false;

	/**
	 * Flush anything queued while the socket was connecting. Bound once as the `'open'` listener.
	 * @returns {void}
	 */
	function flushPending() {
		if (socket.readyState !== OPEN) return;
		// splice(0, length) drains the queue in one O(n) shot; shift()-in-a-loop is O(n²) on a large
		// pre-open backlog, since every shift re-indexes the remaining elements.
		const queued = pendingSends.splice(0, pendingSends.length);
		for (const text of queued) {
			try {
				socket.send(text);
			} catch {
				// The socket died between `open` and this flush; the core tolerates a lost frame.
			}
		}
	}

	/**
	 * Notify the far-side-death handler exactly once, unless this end initiated the close. Guarded so
	 * a throwing consumer handler never surfaces as a transport fault.
	 * @param {object} [info] - Reason info passed to the handler.
	 * @returns {void}
	 */
	function notifyClose(info) {
		if (closeNotified || localClosing) return;
		closeNotified = true;
		// Same cleanup as close(): a pre-open backlog that never got to flush serves no purpose once
		// the socket itself has reported it's gone.
		pendingSends.length = 0;
		if (typeof closeHandler === "function") {
			try {
				closeHandler(info);
			} catch {
				// Contract: handlers never throw into the transport.
			}
		}
	}

	/**
	 * Dispatch one inbound socket message to the registered handler. Suppressed after a local `close()`
	 * — an inbound frame that arrives once this end has torn down is dropped, matching the other four
	 * transports (the core tolerates a dropped post-close frame).
	 * @param {unknown} data - The raw `'message'` payload.
	 * @returns {void}
	 */
	function onSocketMessage(data) {
		if (localClosing || !messageHandler) return; // buffersUntilHandler: false — nothing to deliver to yet.
		const text = toText(data);
		if (text === null) return;
		let frame;
		try {
			frame = JSON.parse(text);
		} catch {
			return; // A malformed payload is dropped, never fed to the handler or thrown into the socket.
		}
		try {
			messageHandler(frame);
		} catch {
			// Contract: handlers never throw into the transport.
		}
	}

	/**
	 * @param {number} [code] - The close code.
	 * @param {unknown} [reason] - The close reason payload.
	 * @returns {void}
	 */
	function onSocketClose(code, reason) {
		notifyClose({ reason: "peer-closed", code, detail: reasonText(reason) });
	}

	/**
	 * A socket error is a real death (network drop, server crash) — report it, then let the following
	 * 'close' be a no-op (closeNotified latches).
	 * @param {unknown} err - The socket error.
	 * @returns {void}
	 */
	function onSocketError(err) {
		notifyClose({ reason: "error", error: err instanceof Error ? err.message : String(err) });
	}

	socket.on("open", flushPending);
	socket.on("message", onSocketMessage);
	socket.on("close", onSocketClose);
	socket.on("error", onSocketError);

	return {
		capabilities: { structuredClone: false, codec: "json", buffersUntilHandler: false },

		/**
		 * Encode one frame and deliver it. Buffered until `open` if the socket is still connecting; a
		 * silent no-op on a closing/closed socket or after a local `close()` — checked BEFORE encoding,
		 * so a close race can never surface as a throw regardless of what the frame contains. Only once
		 * the socket is confirmed CONNECTING/OPEN does a `JSON.stringify` throw mean the JSON codec
		 * REFUSING this frame (a `BigInt` in the graph) — a per-call fault, not a dead socket, so it is
		 * re-raised: the core settles just that call `VINE_BAD_FRAME` and the socket stays alive.
		 * (Lossy-but-valid degradation — `Date`→string, `Map`/`Set`→`{}` — is NOT a refusal and still
		 * crosses; see the module header.)
		 * @param {object} frame - The plain frame object.
		 * @returns {void}
		 * @throws {TypeError} Re-raises a `JSON.stringify` failure (e.g. a `BigInt`) so the core settles
		 *   that call `VINE_BAD_FRAME` — but only when the socket is still CONNECTING/OPEN; a close race
		 *   (local `close()`, or the socket already CLOSING/CLOSED) is a silent no-op instead, same as
		 *   every other transport's send().
		 */
		send(frame) {
			if (localClosing) return; // a local close() always wins — never even attempt to encode
			if (socket.readyState !== CONNECTING && socket.readyState !== OPEN) return; // CLOSING/CLOSED — tolerate, no throw, no encode attempt
			const text = JSON.stringify(frame); // a BigInt throws here — a per-call refusal, let it propagate.
			if (text === undefined) return;
			if (socket.readyState === CONNECTING) {
				pendingSends.push(text);
				return;
			}
			try {
				socket.send(text);
			} catch {
				// The socket transitioned to a bad state under us; the core tolerates a lost frame.
			}
		},

		/**
		 * Register the (single) receive handler; a later registration replaces the earlier one. A
		 * non-function clears it. Frames that arrived before a handler existed were dropped.
		 * @param {(message: object) => void} handler - The receive handler.
		 * @returns {void}
		 */
		onMessage(handler) {
			messageHandler = typeof handler === "function" ? handler : null;
		},

		/**
		 * Register the (single) far-side-death handler; a later registration replaces the earlier one.
		 * @param {(info?: object) => void} handler - The close/death handler.
		 * @returns {void}
		 */
		onClose(handler) {
			closeHandler = typeof handler === "function" ? handler : null;
		},

		/**
		 * Tear this end down: detach every listener this channel attached — releasing the handler
		 * closures and stopping any further inbound dispatch or death report — then close the underlying
		 * socket (1:1 ownership). Idempotent, and it does not fire this end's own `onClose`: a
		 * locally-initiated close is not a far-side death.
		 * @returns {void}
		 */
		close() {
			if (localClosing) return;
			localClosing = true;
			messageHandler = null;
			closeHandler = null;
			pendingSends.length = 0;
			try {
				socket.removeListener("open", flushPending);
				socket.removeListener("message", onSocketMessage);
				socket.removeListener("close", onSocketClose);
				socket.removeListener("error", onSocketError);
			} catch {
				// A socket that refuses listener removal is already tearing down; nothing left to detach.
			}
			try {
				socket.close();
			} catch {
				// Already closing/closed, or the socket rejected a redundant close — nothing to do.
			}
		}
	};
}

/**
 * Construct a client channel to a `ws://` / `wss://` URL. This is the one place the transport imports
 * the optional `ws` peer dependency — and the one that throws a clear, install-me error when `ws` is
 * absent. Sends before the socket finishes connecting are buffered by the channel, so the returned
 * channel is usable immediately without awaiting `open`.
 *
 * @param {string} url - The websocket URL to connect to.
 * @param {object} [options] - Options forwarded to the `ws` WebSocket constructor.
 * @returns {Promise<object>} A Channel over the freshly-created client socket.
 * @throws {Error} When the optional peer dependency `ws` is not installed.
 * @throws {Error} When the resolved `ws` module exposes neither a `WebSocket` nor a `default` export
 *   that is a constructor — an unexpected module shape, rather than a confusing native
 *   `TypeError: WebSocket is not a constructor` at the `new` site.
 *
 * @example
 * import { connect } from "@cldmv/slothlet-vine/transport/websocket";
 * import { grow } from "@cldmv/slothlet-vine";
 *
 * const channel = await connect("ws://127.0.0.1:8710");
 * const link = await grow(hostApi, channel, { budgetMs: 5000 });
 */
export async function connect(url, options) {
	let ws;
	try {
		ws = await import("ws");
	} catch (cause) {
		throw new Error(
			"@cldmv/slothlet-vine: transport/websocket requires the optional peer dependency 'ws'. Install it with `npm install ws`.",
			{ cause }
		);
	}
	const WebSocket = ws.WebSocket ?? ws.default;
	if (typeof WebSocket !== "function") {
		throw new Error(
			"@cldmv/slothlet-vine: transport/websocket could not find a WebSocket constructor on the resolved 'ws' module (checked ws.WebSocket and ws.default) — this may indicate an incompatible 'ws' version or a broken install."
		);
	}
	return createChannel(new WebSocket(url, options));
}

/**
 * Normalize a `ws` `'message'` payload into a UTF-8 string. `ws` delivers text as a `Buffer` by
 * default, and binary as `Buffer` / `ArrayBuffer` / an array of `Buffer` fragments.
 * @param {unknown} data - The raw `'message'` payload.
 * @returns {string|null} The decoded text, or `null` when it cannot be decoded.
 */
function toText(data) {
	try {
		if (typeof data === "string") return data;
		if (data instanceof ArrayBuffer) return DECODER.decode(data);
		if (ArrayBuffer.isView(data)) return DECODER.decode(data); // Buffer / TypedArray / DataView
		if (Array.isArray(data)) return data.map((part) => toText(part) ?? "").join(""); // fragmented binary
		return null;
	} catch {
		return null;
	}
}

/**
 * Decode a `ws` `'close'` reason (a `Buffer`) into a string for the close info, tolerating anything.
 * @param {unknown} reason - The close reason payload.
 * @returns {string} The reason text (possibly empty).
 */
function reasonText(reason) {
	return toText(reason) ?? "";
}
