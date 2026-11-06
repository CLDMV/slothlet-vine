/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/index.mjs
 *	@Date: 2026-08-23T21:30:12-07:00 (1787545812)
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

/**
 * The control plane a slothlet instance exposes at `api.slothlet`. Every surface is probed for the
 * function it needs before use (older slothlet releases lack some), so the members are typed as the
 * plain function maps vine calls through.
 *
 * @typedef {object} SlothletControl
 * @property {Record<string, Function>} api - Runtime api mutation (`add`, `remove`, `leaves`).
 * @property {Record<string, Function>} context - Context propagation (`run`, `scope`).
 * @property {Record<string, Function>} event - Event surface (`on`, `once`, `resolveLevel`).
 * @property {{ control: { enabled?: unknown }, global: Record<string, Function> }} permissions - The permission system.
 * @property {Function} caller - The identity of the calling module, when slothlet provides one.
 */

/**
 * A slothlet instance: the `slothlet` control plane plus the module api tree, whose shape is whatever
 * the host composed (hence `unknown` members).
 *
 * @typedef {{ slothlet: SlothletControl, [key: string]: unknown }} SlothletApi
 */

/**
 * The trigger envelope delivered with every forwarded event.
 *
 * @typedef {{ event: string, at: number, instanceID: string }} EventMeta
 */

/**
 * A forwarded-event listener: `payload` is `undefined` at the `notify` level.
 *
 * @typedef {(payload: unknown, meta: EventMeta) => void} EventListener
 */

/**
 * The granted level of a forwarded subscription plus its unsubscribe.
 *
 * @typedef {{ level: "deny"|"notify"|"allow", off: () => void }} Subscription
 */

/**
 * The event-forwarding surface on a link or serving: slothlet's own `event.on` / `event.once` shape,
 * async because the granted level is resolved across the boundary.
 *
 * @typedef {object} EventSurface
 * @property {(eventName: string, listener: EventListener, options?: { once?: boolean }) => Promise<Subscription>} on - Subscribe.
 * @property {(eventName: string, listener: EventListener) => Promise<Subscription>} once - Subscribe for one delivery.
 */

export { grow, DEFAULT_BUDGET_MS } from "./grow.mjs";
export { serve } from "./serve.mjs";
export { CODES, VineError, VineRemoteError, fromWire, toWire } from "./lib/errors.mjs";
