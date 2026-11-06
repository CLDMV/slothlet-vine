/**
 * Wrap a `postMessage` port as a Channel.
 *
 * Works over any object exposing `postMessage(frame)` plus an `addEventListener('message', fn)`-style
 * `message` event — a browser `Worker`, a browser `MessagePort`, or a node `worker_threads`
 * `MessagePort`. A port with no `addEventListener` at all falls back to the legacy `onmessage=`
 * setter, for a minimal/legacy port that genuinely only supports that surface — but this does **not**
 * make a node `worker_threads` `Worker` handle usable here; see the module header for why, and use
 * `transport/worker-threads` for that object instead.
 *
 * ## Death detection is medium-specific — this is the honest matrix
 *
 * `onClose` fires only on a signal the port genuinely emits. What each medium actually delivers:
 *
 * - **node `worker_threads` `MessagePort`** — emits a real `'close'` event on the peer when the
 *   OTHER side closes (verified), plus `'messageerror'` on a failed deserialize. This is the case
 *   with genuine peer-death detection, and it is what this module's own e2e rides.
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
 * @param {object} port - Anything with `postMessage(frame)` and a `message` event (NOT a node
 *   `worker_threads` `Worker` handle — see above).
 * @param {object} [options] - Transport options.
 * @param {string[]} [options.deathEvents] - Extra event names to treat as a close signal, UNIONed
 *   with the defaults (`"close"`, `"messageerror"`). Use `["error"]` for a browser `Worker`.
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
export function createChannel(port: object, options?: {
    deathEvents?: string[] | undefined;
}): object;
