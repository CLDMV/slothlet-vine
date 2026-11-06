export { serve } from "./serve.mjs";
/**
 * The transport seam every vine rides on. Implement this (plus a capability declaration) to plug in
 * a custom transport; the core consumes ONLY this interface.
 *
 * `onMessage` and `onClose` are single-handler registrations — last write wins. Handlers must never
 * throw into the transport (the core wraps its own), and frames may arrive after `close()` was
 * called locally; the core tolerates and ignores them.
 */
export type Channel = {
    /**
     * - Deliver one frame to the far side.
     */
    send: (message: object) => void;
    /**
     * - Register the (single) receive handler.
     */
    onMessage: (handler: (message: object) => void) => void;
    /**
     * - Tear the transport down.
     */
    close?: (() => void) | undefined;
    /**
     * - Register a (single) far-side-death/closure handler.
     */
    onClose?: ((handler: (info?: object) => void) => void) | undefined;
    /**
     * What the medium preserves, how it encodes, and whether frames sent before a handler is
     * registered are buffered (true) or may be dropped (absent/false).
     */
    capabilities?: {
        structuredClone?: boolean;
        codec?: "none" | "json";
        buffersUntilHandler?: boolean;
    } | undefined;
};
export { grow, DEFAULT_BUDGET_MS } from "./grow.mjs";
export { CODES, VineError, VineRemoteError, fromWire, toWire } from "./lib/errors.mjs";
