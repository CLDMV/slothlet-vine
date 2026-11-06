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
export function createChannel(worker: import("node:worker_threads").Worker): object;
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
 * @param {import("node:worker_threads").MessagePort|null} [port=parentPort] - The port to wrap.
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
export function createParentChannel(port?: import("node:worker_threads").MessagePort | null): object;
