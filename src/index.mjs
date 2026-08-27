/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/index.mjs
 *
 * Vines between slothlet api trees — location-transparent forwarding leaves over an injected
 * Channel. One end {@link serve}s its callable leaves; the other {@link grow}s a forwarding stub per
 * leaf at the identical dotted path, so a caller cannot tell which side of the boundary the
 * implementation lives on, and slothlet's own permission system gates the stub exactly as it gates
 * a real leaf.
 *
 * The core NEVER imports a transport: it consumes only the {@link Channel} interface below.
 * Built-in transports live under `@cldmv/slothlet-vine/transport/*`; a consumer may pass any object
 * satisfying the contract. See `docs/DESIGN.md` for the normative protocol and
 * `schemas/frame.schema.json` for the wire frames.
 *
 * @example
 * import { grow, serve } from "@cldmv/slothlet-vine";
 * import { createPair } from "@cldmv/slothlet-vine/transport/loopback";
 *
 * const [near, far] = createPair();
 * await serve(workerApi, far, { paths: ["exts"] });
 * const link = await grow(hostApi, near, { budgetMs: 5000 });
 * await hostApi.exts.pdfViewer.open("a.pdf"); // executes on the serving instance
 * await link.close();
 */

/**
 * The transport seam every vine rides on. Implement this (plus a capability declaration) to plug in
 * a custom transport; the core consumes ONLY this interface.
 *
 * `onMessage` and `onClose` are single-handler registrations — last write wins. Handlers must never
 * throw into the transport (the core wraps its own), and frames may arrive after `close()` was
 * called locally; the core tolerates and ignores them.
 *
 * @typedef {object} Channel
 * @property {(message: object) => void} send - Deliver one frame to the far side.
 * @property {(handler: (message: object) => void) => void} onMessage - Register the (single) receive handler.
 * @property {() => void} [close] - Tear the transport down.
 * @property {(handler: (info?: object) => void) => void} [onClose] - Register a (single) far-side-death/closure handler.
 * @property {{ structuredClone?: boolean, codec?: "none"|"json", buffersUntilHandler?: boolean }} [capabilities]
 *   What the medium preserves, how it encodes, and whether frames sent before a handler is
 *   registered are buffered (true) or may be dropped (absent/false).
 */

export { grow, DEFAULT_BUDGET_MS } from "./grow.mjs";
export { serve } from "./serve.mjs";
export { CODES, VineError, VineRemoteError, fromWire, toWire } from "./lib/errors.mjs";
