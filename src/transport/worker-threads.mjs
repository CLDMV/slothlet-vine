/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/worker-threads.mjs
 *
 * The `node:worker_threads` transport — a Channel over the thread boundary, with REAL death
 * detection. It has two endpoints, one per side of the boundary:
 *
 * - **Parent side** — {@link createChannel}`(worker)` wraps a live `worker_threads.Worker`. Frames
 *   ride `worker.postMessage` / `worker.on("message")`, and `onClose` fires when the worker actually
 *   dies: `"exit"` (any code) or `"error"`. This is the transport's advantage over the browser
 *   `postMessage` family — a worker thread ending is a real, observable event, so a pending call is
 *   force-settled `VINE_GONE` the moment the thread is gone rather than hanging on its budget.
 * - **Child side** — {@link createParentChannel}`()` wraps `worker_threads.parentPort` (a
 *   `MessagePort`). It takes an optional port so two ports of a `worker_threads.MessageChannel` can
 *   be paired in-process for the conformance suite (a real structured-clone boundary, no second
 *   thread).
 *
 * Both sides declare `{ structuredClone: true, codec: "none", buffersUntilHandler: false }`:
 *
 * - **`structuredClone: true`, `codec: "none"`** — the medium structured-clones, so frames are
 *   handed to `postMessage` verbatim (never JSON). `Date` / `Map` / `Set` survive; only the
 *   documented data-only rule (no functions) bounds what may cross.
 * - **`buffersUntilHandler: false`** — a `MessagePort` in Node buffers messages posted before a
 *   `"message"` listener exists, so this module attaches its OWN listener eagerly (at construction)
 *   and DROPS any frame that arrives before the core registers its handler. Dropping rather than
 *   Node-buffering is what makes the declaration honest, and it is safe for the vine: `grow()` and
 *   `serve()` both register `onMessage` synchronously — before the event loop can deliver the first
 *   worker message — so the surface frame is never among the dropped.
 *
 * Ownership: {@link createChannel}`.close()` detaches its listeners but NEVER terminates the worker —
 * the caller made the worker and owns its lifecycle. {@link createParentChannel}`.close()` closes the
 * port it wraps, because there the port IS the transport.
 */
import { parentPort as defaultParentPort } from "node:worker_threads";

/** The capabilities every worker-threads endpoint declares. @type {{structuredClone: boolean, codec: string, buffersUntilHandler: boolean}} */
const CAPABILITIES = Object.freeze({ structuredClone: true, codec: "none", buffersUntilHandler: false });

/**
 * PARENT side. Wrap a `worker_threads.Worker` as a Channel whose far side is the code running inside
 * the worker (which wraps its own `parentPort` with {@link createParentChannel}).
 *
 * `onClose` fires on real thread death — the worker's `"exit"` event (whatever the exit code) or its
 * `"error"` event — whichever comes first, exactly once. `close()` detaches the listeners and does
 * NOT call `worker.terminate()`: the worker's lifecycle belongs to whoever created it. Detecting the
 * worker dying is the point, so `onClose` stays live until you close the channel.
 *
 * @param {import("node:worker_threads").Worker} worker - A live Worker instance.
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `worker` is not an object exposing `postMessage` and `on`.
 *
 * @example
 * import { Worker } from "node:worker_threads";
 * import { grow } from "@cldmv/slothlet-vine";
 * import { createChannel } from "@cldmv/slothlet-vine/transport/worker-threads";
 *
 * const worker = new Worker(new URL("./serve-worker.mjs", import.meta.url));
 * const link = await grow(hostApi, createChannel(worker), { budgetMs: 5000 });
 */
export function createChannel(worker) {
	if (
		worker === null ||
		(typeof worker !== "object" && typeof worker !== "function") ||
		typeof worker.postMessage !== "function" ||
		typeof worker.on !== "function"
	) {
		throw new TypeError(
			"@cldmv/slothlet-vine: transport/worker-threads createChannel(worker) needs a worker_threads.Worker (an object with postMessage() and on())"
		);
	}
	return makeChannel(worker, { deathEvents: ["exit", "error"], ownsTarget: false });
}

/**
 * CHILD side. Wrap `worker_threads.parentPort` (or any `MessagePort`) as a Channel whose far side is
 * the parent that spawned this worker (which wraps the `Worker` with {@link createChannel}).
 *
 * `onClose` fires on the port's `"close"` event — the parent tearing the channel down. `close()`
 * closes the wrapped port: inside a worker that is the child's half of the transport, and pairing two
 * `MessageChannel` ports (the conformance use) makes closing one the way to notify the other.
 *
 * The `port` parameter defaults to the ambient `parentPort`, so a worker calls it with no arguments;
 * the parameter exists so two ends of a `worker_threads.MessageChannel` can be wrapped and paired in
 * one process for the Channel conformance suite.
 *
 * @param {import("node:worker_threads").MessagePort} [port=parentPort] - The port to wrap.
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When no usable port is available (called outside a worker with no `port`).
 *
 * @example
 * // inside serve-worker.mjs
 * import slothlet from "@cldmv/slothlet";
 * import { serve } from "@cldmv/slothlet-vine";
 * import { createParentChannel } from "@cldmv/slothlet-vine/transport/worker-threads";
 *
 * const api = await slothlet({ base: SERVE_DIR });
 * await serve(api, createParentChannel());
 */
export function createParentChannel(port = defaultParentPort) {
	if (port === null || typeof port !== "object" || typeof port.postMessage !== "function" || typeof port.on !== "function") {
		throw new TypeError(
			"@cldmv/slothlet-vine: transport/worker-threads createParentChannel() must run inside a worker (no parentPort) or be given a MessagePort"
		);
	}
	return makeChannel(port, { deathEvents: ["close"], ownsTarget: true });
}

/**
 * Build a Channel over a message target (a `Worker` or a `MessagePort`). The two exported endpoints
 * differ only in which events mean "the far side is gone" and whether closing owns the target.
 *
 * A single, always-attached `"message"` listener keeps the target flowing from construction, so the
 * pre-handler drop (not Node's buffer) is what backs `buffersUntilHandler: false`. Every consumer
 * callback is insulated: a throwing `onMessage`/`onClose` handler can never surface as a transport
 * fault, per the Channel contract.
 *
 * @param {object} target - The `Worker` or `MessagePort` to wrap.
 * @param {{ deathEvents: string[], ownsTarget: boolean }} config
 *   `deathEvents` — target events that fire `onClose` (once); `ownsTarget` — whether `close()` also
 *   tears the target down (`target.close()`), which the child-side port owns and the parent-side
 *   worker does not.
 * @returns {object} The Channel.
 */
function makeChannel(target, { deathEvents, ownsTarget }) {
	/** @type {((message: object) => void) | null} The single receive handler; null until the core registers one. */
	let handler = null;
	/** @type {((info?: object) => void) | null} The single far-side-death handler. */
	let onCloseHandler = null;
	let closed = false;
	let deathFired = false;

	/**
	 * The one persistent inbound listener. Delivers to the core's handler, or drops the frame when
	 * none is registered yet — the deliberate `buffersUntilHandler: false` behaviour.
	 * @param {object} message - The inbound frame.
	 * @returns {void}
	 */
	const onMessageRaw = (message) => {
		if (closed || handler === null) return;
		try {
			handler(message);
		} catch {
			// Channel contract: a consumer handler must never throw into the transport.
		}
	};

	/**
	 * Fire the far-side-death handler exactly once. Bound per death event so it can be detached.
	 * @param {object} [info] - Why the far side is considered gone.
	 * @returns {void}
	 */
	const fireClose = (info) => {
		if (deathFired || closed) return;
		deathFired = true;
		if (typeof onCloseHandler === "function") {
			try {
				onCloseHandler(info);
			} catch {
				// A consumer close handler must never surface as a transport fault.
			}
		}
	};

	/** @type {Array<[string, (arg?: unknown) => void]>} The death listeners actually attached, for clean detach. */
	const deathListeners = [];
	for (const event of deathEvents) {
		/**
		 * @param {unknown} [arg] - The event payload (an exit code, an Error, or nothing for "close").
		 * @returns {void}
		 */
		const listener = (arg) => {
			if (event === "exit") fireClose({ reason: "exit", code: arg });
			else if (event === "error") fireClose({ reason: "error", error: arg });
			else fireClose({ reason: "peer-closed" });
		};
		deathListeners.push([event, listener]);
		target.on(event, listener);
	}

	target.on("message", onMessageRaw);

	return {
		capabilities: CAPABILITIES,

		/**
		 * Deliver one frame to the far side. A send on a closed channel is a silent no-op. A
		 * `postMessage` throw is classified: a `DataCloneError` (the medium REFUSING an un-cloneable
		 * frame — an argument the data-only scan cannot see) is re-raised so the core settles just that
		 * call `VINE_BAD_FRAME` and the link stays alive; any other throw is a close race (a terminated
		 * worker, a closed port) and is swallowed, the core being required to tolerate frames crossing a
		 * close (the pending call settles on death or budget).
		 * @param {object} message - The frame (passed to `postMessage` verbatim; structured-cloned).
		 * @returns {void}
		 * @throws {DOMException} Re-raises a `DataCloneError` so the core settles that call `VINE_BAD_FRAME`.
		 */
		send(message) {
			if (closed) return;
			try {
				target.postMessage(message);
			} catch (err) {
				// Structured-clone refusal → per-call BAD_FRAME (rethrow); everything else is a close race.
				if (isCloneRefusal(err)) throw err;
			}
		},

		/**
		 * Register the (single) receive handler; a later registration replaces the earlier one. A
		 * non-function clears it. Frames that arrived before this point were dropped, not buffered.
		 * @param {(message: object) => void} fn - The receive handler.
		 * @returns {void}
		 */
		onMessage(fn) {
			handler = typeof fn === "function" ? fn : null;
		},

		/**
		 * Register the (single) far-side-death handler; a later registration replaces the earlier one.
		 * @param {(info?: object) => void} fn - The close handler.
		 * @returns {void}
		 */
		onClose(fn) {
			onCloseHandler = typeof fn === "function" ? fn : null;
		},

		/**
		 * Tear this end down. Idempotent. Detaches every listener — so a subsequent worker death is not
		 * reported to a link that already closed locally — and, for the child-side port that owns its
		 * target, closes the port too. NEVER terminates a parent-side worker: that lifecycle belongs to
		 * whoever created it.
		 * @returns {void}
		 */
		close() {
			if (closed) return;
			closed = true;
			handler = null;
			onCloseHandler = null;
			try {
				target.removeListener("message", onMessageRaw);
				for (const [event, listener] of deathListeners) target.removeListener(event, listener);
			} catch {
				// A target that refuses listener removal is already tearing down; nothing left to detach.
			}
			if (ownsTarget && typeof target.close === "function") {
				try {
					target.close();
				} catch {
					// Already closed by the far side, or mid-teardown; the transport is gone either way.
				}
			}
		}
	};
}

/**
 * Is this `postMessage` throw a structured-clone REFUSAL (an un-cloneable frame), as opposed to a
 * close race? The structured-clone algorithm rejects an un-cloneable value with a `DataCloneError`
 * (a `DOMException` named `"DataCloneError"`). A refusal is a per-call fault the core turns into
 * `VINE_BAD_FRAME`; everything else is swallowed as a close race.
 * @param {unknown} err - The thrown error.
 * @returns {boolean} True when the error is a structured-clone refusal.
 */
function isCloneRefusal(err) {
	return err !== null && typeof err === "object" && err.name === "DataCloneError";
}
