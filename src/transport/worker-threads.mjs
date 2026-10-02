/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/worker-threads.mjs
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

import { parentPort as defaultParentPort } from "node:worker_threads";
import { createInbox } from "../lib/inbox.mjs";

/** The capabilities every worker-threads endpoint declares. @type {{structuredClone: boolean, codec: string, buffersUntilHandler: boolean}} */
const CAPABILITIES = Object.freeze({ structuredClone: true, codec: "none", buffersUntilHandler: true });

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
 * // Wrap the worker in the SAME tick it is created — before any await. A message the worker posts
 * // before a listener exists is dropped by Node itself; once wrapped, early frames are queued.
 * const worker = new Worker(new URL("./serve-worker.mjs", import.meta.url));
 * const channel = createChannel(worker);
 * const hostApi = await slothlet({ base: API_DIR }); // safe: the surface frame is queued meanwhile
 * const link = await grow(hostApi, channel, { budgetMs: 5000 });
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
 * A single, always-attached `"message"` listener keeps the target flowing from construction and feeds
 * an inbox that queues frames until the core registers its handler (`buffersUntilHandler: true`),
 * then replays them in order. Every consumer
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
	/** Queues frames that arrive before the core registers its handler, then replays them in order. */
	const inbox = createInbox();
	/** @type {((info?: object) => void) | null} The single far-side-death handler. */
	let onCloseHandler = null;
	let closed = false;
	let deathFired = false;

	/**
	 * The one persistent inbound listener. Hands the frame to the inbox, which delivers it to the
	 * core's handler — or queues it until one is registered (`buffersUntilHandler: true`).
	 * @param {object} message - The inbound frame.
	 * @returns {void}
	 */
	const onMessageRaw = (message) => inbox.deliver(message);

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
		 * non-function clears it. Frames that arrived while no handler was registered are replayed to
		 * it, in order, on the next microtask.
		 * @param {(message: object) => void} fn - The receive handler.
		 * @returns {void}
		 */
		onMessage(fn) {
			inbox.setHandler(fn);
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
			inbox.close();
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
