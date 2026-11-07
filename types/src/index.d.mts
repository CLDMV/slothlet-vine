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
/**
 * The control plane a slothlet instance exposes at `api.slothlet`. Every surface is probed for the
 * function it needs before use (older slothlet releases lack some), so the members are typed as the
 * plain function maps vine calls through.
 */
export type SlothletControl = {
    /**
     * - Runtime api mutation (`add`, `remove`, `leaves`).
     */
    api: Record<string, Function>;
    /**
     * - Context propagation (`run`, `scope`).
     */
    context: Record<string, Function>;
    /**
     * - Event surface (`on`, `once`, `resolveLevel`).
     */
    event: Record<string, Function>;
    /**
     * - The permission system.
     */
    permissions: {
        control: {
            enabled?: unknown;
        };
        global: Record<string, Function>;
    };
    /**
     * - The identity of the calling module, when slothlet provides one.
     */
    caller: Function;
};
/**
 * A slothlet instance: the `slothlet` control plane plus the module api tree, whose shape is whatever
 * the host composed (hence `unknown` members).
 */
export type SlothletApi = {
    slothlet: SlothletControl;
    [key: string]: unknown;
};
/**
 * The trigger envelope delivered with every forwarded event.
 */
export type EventMeta = {
    event: string;
    at: number;
    instanceID: string;
};
/**
 * A forwarded-event listener: `payload` is `undefined` at the `notify` level.
 */
export type EventListener = (payload: unknown, meta: EventMeta) => void;
/**
 * The granted level of a forwarded subscription plus its unsubscribe.
 */
export type Subscription = {
    level: "deny" | "notify" | "allow";
    off: () => void;
};
/**
 * The event-forwarding surface on a link or serving: slothlet's own `event.on` / `event.once` shape,
 * async because the granted level is resolved across the boundary.
 */
export type EventSurface = {
    /**
     * - Subscribe.
     */
    on: (eventName: string, listener: EventListener, options?: {
        once?: boolean;
    }) => Promise<Subscription>;
    /**
     * - Subscribe for one delivery.
     */
    once: (eventName: string, listener: EventListener) => Promise<Subscription>;
};
export { grow, DEFAULT_BUDGET_MS } from "./grow.mjs";
export { CODES, VineError, VineRemoteError, fromWire, toWire } from "./lib/errors.mjs";
