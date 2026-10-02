/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/inbox.mjs
 *	@Date: 2026-09-28T03:15:48+00:00 (1790565348)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:12-07:00 (1790968812)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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
