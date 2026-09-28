/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/inbox.mjs
 *
 * The pre-handler inbox behind `capabilities.buffersUntilHandler: true` on the built-in port/socket
 * transports (worker-threads, post-message, process, websocket).
 *
 * Each of those transports attaches its own listener to the medium eagerly, at `createChannel()`
 * time, so a frame can reach the transport before the core has called `onMessage()` — most visibly
 * when a consumer creates the channel, `await`s something (a slothlet boot, a config load), and only
 * then calls `grow()`. The far side's one-shot `surface` frame arrives in that gap. Dropping it (the
 * old `buffersUntilHandler: false` behaviour) turned an ordinary `await` into a `VINE_BUDGET`
 * handshake failure (CLDMV/slothlet-vine#41), so the transports hand every inbound frame to an inbox
 * instead:
 *
 * - With a handler registered and nothing queued, a frame is delivered immediately.
 * - With no handler, the frame is queued. Registering a handler schedules a replay of the queue, in
 *   arrival order, on the next microtask — never synchronously inside `onMessage()`, so the core's
 *   registration code (e.g. `serve()` publishing its surface right after registering) finishes before
 *   any replayed frame runs.
 * - A frame that arrives while a replay is pending joins the END of the queue, so a replay can never
 *   be overtaken by a newer frame.
 * - Clearing the handler (a non-function registration) makes frames queue again; a handler that
 *   clears itself mid-replay stops the replay and leaves the remainder queued.
 * - `close()` discards the queue and makes the inbox inert.
 *
 * The queue is unbounded, mirroring the loopback transport. In the vine protocol the only frame a far
 * side sends unprompted is the single `surface` frame — calls, results and events all follow a
 * handler's registration — so in practice the queue holds at most a frame or two.
 */

/**
 * Create a pre-handler inbox.
 * @returns {{ deliver: (frame: unknown) => void, setHandler: (fn: unknown) => void, close: () => void }}
 *   `deliver` — hand one inbound frame to the inbox; `setHandler` — register (or, with a non-function,
 *   clear) the single receive handler; `close` — discard the queue and stop delivering.
 */
export function createInbox() {
	/** @type {((frame: unknown) => void) | null} */
	let handler = null;
	/** @type {unknown[]} Frames received while no handler was registered (or while a replay is pending). */
	let queue = [];
	let replayScheduled = false;
	let closed = false;

	/**
	 * Call the handler with one frame, insulated: a consumer handler must never throw into the
	 * transport (the Channel contract).
	 * @param {(frame: unknown) => void} fn - The handler.
	 * @param {unknown} frame - The frame.
	 * @returns {void}
	 */
	function invoke(fn, frame) {
		try {
			fn(frame);
		} catch {
			// Channel contract: a consumer handler must never surface as a transport fault.
		}
	}

	/**
	 * Replay the queue, in order, to whatever handler is registered as each frame comes up. Stops early
	 * when the handler is cleared (the rest stays queued) or the inbox closes.
	 * @returns {void}
	 */
	function replay() {
		replayScheduled = false;
		while (!closed && handler !== null && queue.length > 0) invoke(handler, queue.shift());
	}

	return {
		deliver(frame) {
			if (closed) return;
			if (handler === null || queue.length > 0) {
				queue.push(frame);
				return;
			}
			invoke(handler, frame);
		},

		setHandler(fn) {
			if (closed) return;
			handler = typeof fn === "function" ? fn : null;
			if (handler !== null && queue.length > 0 && !replayScheduled) {
				replayScheduled = true;
				queueMicrotask(replay);
			}
		},

		close() {
			closed = true;
			handler = null;
			queue = [];
		}
	};
}
