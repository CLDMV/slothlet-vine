/**
 * A path segment is mountable when it is a valid JavaScript identifier name (see
 * {@link SAFE_SEGMENT}) and is not one of {@link UNSAFE_SEGMENTS}. Still deliberately narrower than
 * "any string key": a name outside the identifier alphabet is not a path a slothlet instance could
 * have produced, and accepting it would only widen the guard's own attack surface.
 * @param {unknown} segment - Candidate segment.
 * @returns {boolean} True when the segment may be mounted / invoked.
 */
export function isSafeSegment(segment: unknown): boolean;
/**
 * A dotted leaf path is safe when it is non-empty and every segment is.
 * @param {unknown} path - Candidate dotted path (e.g. `exts.pdfViewer.open`).
 * @returns {path is string} True when the whole path may be mounted / invoked.
 */
export function isSafePath(path: unknown): path is string;
/**
 * Locate the first function anywhere in an argument graph. The vine is data-only in v1, so a
 * function argument is refused AT THE EDGE with a named error rather than allowed to reach the
 * transport codec, where it would surface as an unattributed clone crash.
 *
 * Cycle-safe, and it never invokes user code: accessor properties are skipped rather than read
 * (a getter that returns a function is not detectable without running it, and running it is worse).
 * `Reflect.ownKeys` is used so symbol-keyed and non-enumerable members are covered.
 * @param {unknown[]} args - The call's arguments.
 * @returns {string|null} A human-readable location (`arg[0].onDone`) or null when the graph is data-only.
 */
export function findFunctionArg(args: unknown[]): string | null;
/**
 * Build the `surface` frame — the served leaf manifest, sent once when a serve starts.
 *
 * `context: true` is added ONLY when the serve accepts a per-call requested context (#79) — a serve
 * with a `context` check. Without one the frame is byte for byte the v1 frame. An older grow drops
 * the unknown key; a newer grow refuses to send a requested context to a far side that did not
 * advertise it, so a client never believes a call is scoped when the far side would ignore it.
 * @param {string[]} leaves - Dotted callable paths being served.
 * @param {{ context?: boolean }} [features] - What this serve accepts beyond the v1 call frame.
 * @returns {{ type: "surface", v: number, leaves: string[], context?: true }} The frame.
 */
export function surfaceFrame(leaves: string[], features?: {
    context?: boolean;
}): {
    type: "surface";
    v: number;
    leaves: string[];
    context?: true;
};
/**
 * Build a `call` frame. The `context` key — the caller's per-call REQUESTED context (#79) — is present
 * only when one was given, so a call without one is byte for byte the v1 frame.
 * @param {string} callId - Correlation id, unique per grow-side link.
 * @param {string} path - The dotted leaf path exactly as served.
 * @param {unknown[]} args - Data-only arguments.
 * @param {object|null} [context] - A data-only plain object, already validated by {@link findContextFault}.
 * @returns {{ type: "call", callId: string, path: string, args: unknown[], context?: object }} The frame.
 */
export function callFrame(callId: string, path: string, args: unknown[], context?: object | null): {
    type: "call";
    callId: string;
    path: string;
    args: unknown[];
    context?: object;
};
/**
 * Is `value` a plain data object — `{}` / `Object.create(null)` — as opposed to an array, a class
 * instance, or a primitive?
 * @param {unknown} value - Candidate.
 * @returns {value is Record<string, unknown>} True for a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown>;
/**
 * The data-only rules for a requested context (#79) — the same rules a call's arguments are held to,
 * plus a shape: it must be a PLAIN object (it is merged key by key into a context scope, and only
 * plain data gets full-depth `protect` there), it may hold no function anywhere, and it must survive
 * a structured clone (a Symbol or a WeakMap is not data either). Never invokes user code beyond what
 * `structuredClone` itself does, and never throws.
 * @param {unknown} value - The candidate requested context.
 * @returns {string|null} A location naming the first fault (`context`, `context.onDone`), or `null`
 *   when the value is acceptable.
 */
export function findContextFault(value: unknown): string | null;
/**
 * Build a `result` frame. `value` is always present (possibly `undefined`) so the receiver never has
 * to distinguish "no value" from "undefined value".
 * @param {string} callId - Correlation id being settled.
 * @param {unknown} value - The leaf's resolved value.
 * @returns {{ type: "result", callId: string, value: unknown }} The frame.
 */
export function resultFrame(callId: string, value: unknown): {
    type: "result";
    callId: string;
    value: unknown;
};
/**
 * Build an `error` frame from a thrown value.
 * @param {string} callId - Correlation id being settled.
 * @param {unknown} err - Whatever the leaf threw.
 * @returns {{ type: "error", callId: string, error: object }} The frame.
 */
export function errorFrame(callId: string, err: unknown): {
    type: "error";
    callId: string;
    error: object;
};
/**
 * Build a `sub` frame — a grow-side request to subscribe to a far event, carrying the subscriber's
 * own identity so the TRUSTED (serving) side can resolve its delivery level and never has to trust a
 * value the grow side merely asserted for someone else.
 * @param {string} subId - Correlation id, unique per grow-side link.
 * @param {string} event - The event name to subscribe to.
 * @param {string|null} subscriberPath - The subscriber's grow-side api identity (from
 *   `api.slothlet.caller()`), or `null` for a host subscription.
 * @returns {{ type: "sub", subId: string, event: string, subscriberPath: string|null }} The frame.
 */
export function subFrame(subId: string, event: string, subscriberPath: string | null): {
    type: "sub";
    subId: string;
    event: string;
    subscriberPath: string | null;
};
/**
 * Build a `sub-ack` frame — the serving side's resolved delivery level for a subscription, so a
 * downgrade or denial is a distinct, catchable result on the grow side rather than a silent absence
 * of payloads.
 * @param {string} subId - Correlation id being answered.
 * @param {"deny"|"notify"|"allow"} level - The level the trusted side resolved for the subscriber.
 * @returns {SubAckFrame} The frame.
 */
export function subAckFrame(subId: string, level: "deny" | "notify" | "allow"): SubAckFrame;
/**
 * Build an `event` frame — one forwarded delivery for a subscription. `payload` is present ONLY when
 * `withPayload` is true (an `allow` delivery); at `notify` it is omitted entirely, so a notify
 * subscriber's domain payload never crosses the boundary.
 * @param {string} subId - The subscription being delivered to.
 * @param {{ event: string, at: number, instanceID: string }} meta - The trigger envelope.
 * @param {boolean} withPayload - Whether to carry the domain payload.
 * @param {unknown} payload - The domain payload (included only when `withPayload`).
 * @returns {Frame} The frame.
 */
export function eventFrame(subId: string, meta: {
    event: string;
    at: number;
    instanceID: string;
}, withPayload: boolean, payload: unknown): Frame;
/**
 * Build an `unsub` frame — a grow-side request to tear down a subscription on the serving side.
 * @param {string} subId - The subscription to remove.
 * @returns {{ type: "unsub", subId: string }} The frame.
 */
export function unsubFrame(subId: string): {
    type: "unsub";
    subId: string;
};
/**
 * TOTAL, tolerant frame validator. Returns a normalized frame or `null`; it NEVER throws, and an
 * unknown `type` is `null` rather than an error — forward compatibility is a receiver obligation
 * (`docs/DESIGN.md` § Frames).
 *
 * Normalization worth knowing about:
 * - a `surface` frame keeps only leaves that pass {@link isSafePath}; the rejects are reported on
 *   `.unsafe` so a caller can log the divergence instead of silently serving less than it thinks;
 * - a `call` frame with an unsafe `path` is rejected outright (`null`) — there is no safe partial
 *   reading of "invoke this";
 * - `args` is copied into a fresh array, so a later mutation of the received object cannot change
 *   what is about to be invoked.
 * @param {unknown} message - Whatever arrived on the channel.
 * @returns {Frame|null} A normalized frame, or null when the message is not a frame this version handles.
 */
export function parseFrame(message: unknown): Frame | null;
/** The frame schema version carried on the `surface` frame. @type {number} */
export const FRAME_VERSION: number;
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 *
 * @typedef {{ type: "surface", v: number, leaves: string[], unsafe?: string[], context?: true }} SurfaceFrame
 * @typedef {{ type: "call", callId: string, path: string, args: unknown[], context?: unknown }} CallFrame
 * @typedef {{ type: "result", callId: string, value: unknown }} ResultFrame
 * @typedef {{ type: "error", callId: string, error: object }} ErrorFrame
 * @typedef {{ type: "sub", subId: string, event: string, subscriberPath: string|null }} SubFrame
 * @typedef {{ type: "sub-ack", subId: string, level: "deny"|"notify"|"allow" }} SubAckFrame
 * @typedef {{ type: "event", subId: string, event: string, at: number, instanceID: string, hasPayload?: boolean, payload?: unknown }} EventFrame
 * @typedef {{ type: "unsub", subId: string }} UnsubFrame
 * @typedef {SurfaceFrame|CallFrame|ResultFrame|ErrorFrame|SubFrame|SubAckFrame|EventFrame|UnsubFrame} Frame
 */
/**
 * Path segments that are never mountable. `__proto__` / `constructor` / `prototype` walk the
 * prototype chain (see the file header); `slothlet` is the control plane, which is NEVER served or
 * mounted, and `shutdown` / `destroy` are the instance's own teardown handles.
 * @type {Set<string>}
 */
export const UNSAFE_SEGMENTS: Set<string>;
/** The delivery levels a subscription can be granted, carried on a `sub-ack`. @type {Set<string>} */
export const SUB_LEVELS: Set<string>;
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type SurfaceFrame = {
    type: "surface";
    v: number;
    leaves: string[];
    unsafe?: string[];
    context?: true;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type CallFrame = {
    type: "call";
    callId: string;
    path: string;
    args: unknown[];
    context?: unknown;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type ResultFrame = {
    type: "result";
    callId: string;
    value: unknown;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type ErrorFrame = {
    type: "error";
    callId: string;
    error: object;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type SubFrame = {
    type: "sub";
    subId: string;
    event: string;
    subscriberPath: string | null;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type SubAckFrame = {
    type: "sub-ack";
    subId: string;
    level: "deny" | "notify" | "allow";
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type EventFrame = {
    type: "event";
    subId: string;
    event: string;
    at: number;
    instanceID: string;
    hasPayload?: boolean;
    payload?: unknown;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type UnsubFrame = {
    type: "unsub";
    subId: string;
};
/**
 * A frame on the wire: one of the shapes below, discriminated on `type`.
 */
export type Frame = SurfaceFrame | CallFrame | ResultFrame | ErrorFrame | SubFrame | SubAckFrame | EventFrame | UnsubFrame;
