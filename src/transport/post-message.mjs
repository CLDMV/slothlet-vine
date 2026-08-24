/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/post-message.mjs
 *
 * The post-message transport: a Channel over the `postMessage` port surface shared by a browser
 * `Worker`, a browser `MessagePort`, and a node `worker_threads` `MessagePort` / `Worker`. Every one
 * of those exposes the same three things — `postMessage(frame)`, a `message` event
 * (`addEventListener('message', fn)` or the `onmessage=` setter), and (mostly) `close()` — so ONE
 * module serves them all. The medium structured-clones the frame, so frames cross as plain objects
 * with no codec of our own (`capabilities.structuredClone: true`, `codec: "none"`).
 *
 * Two properties are deliberate and declared:
 *
 * - **`buffersUntilHandler: false`.** The underlying `message` listener is attached EAGERLY at
 *   {@link createChannel} time and dispatches to a nullable inner handler; a frame that arrives
 *   before `onMessage()` has been called finds no inner handler and is dropped. (Attaching the
 *   listener lazily instead would let the port's own pre-listener buffer replay those frames — a
 *   `worker_threads` MessagePort does buffer — which would be a different, undeclared contract. The
 *   eager-with-null-dispatch shape is what makes the `false` honest.) The core's `grow()` registers
 *   its receive handler synchronously before the far side's asynchronously-delivered `surface` frame
 *   can arrive, so nothing is lost in practice.
 * - **Death detection is only what the port surface actually delivers**, and it varies by medium —
 *   see {@link createChannel}. We never fake a signal we cannot observe.
 */

/** The close-signalling events wired by default. Extra ones (e.g. `"exit"`, `"error"`) are opt-in. @type {string[]} */
const DEFAULT_DEATH_EVENTS = ["close", "messageerror"];

/**
 * Wrap a `postMessage` port as a Channel.
 *
 * Works over any object exposing `postMessage(frame)` plus a `message` event — a browser `Worker`,
 * a browser `MessagePort`, or a node `worker_threads` `MessagePort` / `Worker`. The `message` event
 * is taken through `addEventListener('message', fn)` when the port has it (node MessagePort, browser
 * Worker/MessagePort all do) and otherwise through the `onmessage=` setter.
 *
 * ## Death detection is medium-specific — this is the honest matrix
 *
 * `onClose` fires only on a signal the port genuinely emits. What each medium actually delivers:
 *
 * - **node `worker_threads` `MessagePort`** — emits a real `'close'` event on the peer when the
 *   OTHER side closes (verified), plus `'messageerror'` on a failed deserialize. This is the case
 *   with genuine peer-death detection, and it is what this module's own e2e rides.
 * - **node `worker_threads` `Worker`** (the main-thread handle) — has no `'close'`; it emits
 *   `'exit'` when the worker stops. Pass `{ deathEvents: ["exit"] }` to observe it.
 * - **browser `Worker`** — has no `'close'` and no `'exit'`; only `'error'` (an uncaught error
 *   inside the worker) and `'messageerror'`. A `terminate()` from the main thread is a LOCAL action
 *   and fires no event, so main-thread-initiated death is not observable through the port. Pass
 *   `{ deathEvents: ["error"] }` for the best-effort signal that IS available.
 * - **browser `MessagePort`** — `close()` is local-only per the HTML spec: closing one port does
 *   NOT notify the other, so there is NO peer-death detection at all. (This is exactly where the
 *   node MessagePort differs — node propagates a `'close'` to the peer, the browser does not.)
 *   `'messageerror'` is still observed.
 *
 * The core never depends on `onClose` for correctness — a pending call also settles on its budget —
 * so a medium without death detection degrades to slower settling, never a hang.
 *
 * @param {object} port - Anything with `postMessage(frame)` and a `message` event.
 * @param {object} [options] - Transport options.
 * @param {string[]} [options.deathEvents] - Extra event names to treat as a close signal, UNIONed
 *   with the defaults (`"close"`, `"messageerror"`). Use `["exit"]` for a node worker handle,
 *   `["error"]` for a browser `Worker`.
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 *
 * @example
 * // node worker_threads, two instances on the main thread over one MessageChannel:
 * import { MessageChannel } from "node:worker_threads";
 * const { port1, port2 } = new MessageChannel();
 * const serving = await serve(workerApi, createChannel(port2));
 * const link = await grow(hostApi, createChannel(port1));
 *
 * @example
 * // browser Web Worker (main-thread side), death observed best-effort via 'error':
 * const channel = createChannel(new Worker("./serve.js"), { deathEvents: ["error"] });
 */
export function createChannel(port, options = {}) {
	if (port === null || typeof port !== "object" || typeof port.postMessage !== "function") {
		throw new TypeError(
			"@cldmv/slothlet-vine: transport/post-message needs a port with postMessage(frame) (a Worker, MessagePort, or worker_threads port)"
		);
	}

	const deathEvents = mergeDeathEvents(options.deathEvents);
	const useAddEventListener = typeof port.addEventListener === "function";

	/** @type {boolean} Once true, every dispatcher is inert and `send` is a no-op. */
	let closed = false;
	/** @type {((message: object) => void)|null} The single receive handler (last write wins). */
	let messageHandler = null;
	/** @type {((info?: object) => void)|null} The single close handler (last write wins). */
	let closeHandler = null;
	/** @type {boolean} `onClose` fires at most once, even if several death events arrive. */
	let closeFired = false;
	/** @type {Array<[string, Function]>} Attached AddEventListener pairs, for removal on close(). */
	const attached = [];

	/**
	 * Receive one message event: unwrap `event.data` and hand it to the current inner handler, with
	 * the port insulated from anything that handler throws.
	 * @param {{ data?: object }} event - The message event (or, defensively, a raw frame).
	 * @returns {void}
	 */
	function onMessageEvent(event) {
		if (closed) return;
		const handler = messageHandler;
		if (typeof handler !== "function") return;
		const data = event !== null && typeof event === "object" && "data" in event ? event.data : event;
		try {
			handler(data);
		} catch {
			// Contract: a consumer handler must never surface as a transport fault.
		}
	}

	/**
	 * Build the listener for one death event. Fires the close handler at most once.
	 * @param {string} reason - The event name, reported as `{ reason }`.
	 * @returns {() => void} The event listener.
	 */
	function makeDeathListener(reason) {
		return function onDeathEvent() {
			if (closed || closeFired) return;
			closeFired = true;
			const handler = closeHandler;
			if (typeof handler !== "function") return;
			try {
				handler({ reason });
			} catch {
				// A consumer handler must never surface as a transport fault.
			}
		};
	}

	if (useAddEventListener) {
		port.addEventListener("message", onMessageEvent);
		attached.push(["message", onMessageEvent]);
		for (const event of deathEvents) {
			const listener = makeDeathListener(event);
			port.addEventListener(event, listener);
			attached.push([event, listener]);
		}
	} else {
		// Legacy `onX=` surface (a port with no addEventListener). Message delivery is universal via
		// `onmessage`; death detection is limited to whichever `on<event>` setters the port exposes.
		port.onmessage = onMessageEvent;
		for (const event of deathEvents) {
			const prop = `on${event}`;
			if (prop in port) port[prop] = makeDeathListener(event);
		}
	}

	return {
		/** Structured-clone medium, no codec of our own, and no pre-handler buffering. */
		capabilities: { structuredClone: true, codec: "none", buffersUntilHandler: false },

		/**
		 * Post one frame to the far side. The object crosses by structured clone — passed straight to
		 * `postMessage`, never serialized here. A send on a closed channel is a silent no-op. A
		 * `postMessage` throw is classified: a `DataCloneError` (the medium REFUSING an un-cloneable
		 * frame) is re-raised so the core settles just that call `VINE_BAD_FRAME`; any other throw is a
		 * close race and is swallowed, the core being required to tolerate frames that cross a close.
		 * @param {object} message - The frame.
		 * @returns {void}
		 * @throws {DOMException} Re-raises a `DataCloneError` so the core settles that call `VINE_BAD_FRAME`.
		 */
		send(message) {
			if (closed) return;
			try {
				port.postMessage(message);
			} catch (err) {
				// A DataCloneError is the structured-clone algorithm REFUSING this frame (an un-cloneable
				// argument the data-only scan cannot see) — a per-call fault, not link death, so re-raise
				// it: the core settles just that call VINE_BAD_FRAME and the link stays alive. Anything
				// else is a close race (a port torn down under us); swallow it — the core is required to
				// tolerate a frame crossing a close, and the pending call settles on death or budget.
				if (isCloneRefusal(err)) throw err;
			}
		},

		/**
		 * Register the (single) receive handler; a second registration replaces the first. A
		 * non-function clears it. Frames that arrived before the first registration were dropped
		 * (`buffersUntilHandler: false`), not queued.
		 * @param {(message: object) => void} handler - The receive handler.
		 * @returns {void}
		 */
		onMessage(handler) {
			messageHandler = typeof handler === "function" ? handler : null;
		},

		/**
		 * Register the (single) far-side-death handler; a second registration replaces the first. It
		 * fires only on a signal the port medium actually delivers — see {@link createChannel} for
		 * the per-medium matrix.
		 * @param {(info?: object) => void} handler - The close handler.
		 * @returns {void}
		 */
		onClose(handler) {
			closeHandler = typeof handler === "function" ? handler : null;
		},

		/**
		 * Tear this end down: detach every listener, then close the port. Idempotent. Listeners are
		 * detached BEFORE `port.close()` so a medium that reports the local close (a node MessagePort
		 * fires its own `'close'`) cannot re-enter our death path on the way out.
		 * @returns {void}
		 */
		close() {
			if (closed) return;
			closed = true;
			messageHandler = null;
			if (useAddEventListener) {
				for (const [event, listener] of attached) {
					try {
						port.removeEventListener(event, listener);
					} catch {
						// Detaching is best-effort; a port that refuses removal must not fault close().
					}
				}
			} else {
				try {
					port.onmessage = null;
				} catch {
					// Best-effort; a read-only accessor must not fault close().
				}
				for (const event of deathEvents) {
					const prop = `on${event}`;
					try {
						if (prop in port) port[prop] = null;
					} catch {
						// Best-effort.
					}
				}
			}
			try {
				port.close?.();
			} catch {
				// A port with no close(), or one that throws on it, must not fault close().
			}
		}
	};
}

/**
 * Is this `postMessage` throw a structured-clone REFUSAL (an un-cloneable frame), as opposed to a
 * close race? The structured-clone algorithm rejects an un-cloneable value with a `DataCloneError`
 * (a `DOMException` named `"DataCloneError"`) in every host that implements it. A refusal is a
 * per-call fault the core turns into `VINE_BAD_FRAME`; everything else is swallowed as a close race.
 * @param {unknown} err - The thrown error.
 * @returns {boolean} True when the error is a structured-clone refusal.
 */
function isCloneRefusal(err) {
	return err !== null && typeof err === "object" && err.name === "DataCloneError";
}

/**
 * Union the caller's extra death events with the defaults, de-duplicated. A non-array is ignored.
 * @param {unknown} extra - Caller-supplied extra event names.
 * @returns {string[]} The event names to wire.
 */
function mergeDeathEvents(extra) {
	if (!Array.isArray(extra)) return [...DEFAULT_DEATH_EVENTS];
	const seen = new Set(DEFAULT_DEATH_EVENTS);
	for (const event of extra) {
		if (typeof event === "string" && event !== "") seen.add(event);
	}
	return [...seen];
}
