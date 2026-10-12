/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/frame.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:12-07:00 (1790968812)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { toWire } from "./errors.mjs";

/** The frame schema version carried on the `surface` frame. @type {number} */
export const FRAME_VERSION = 1;

/**
 * Path segments that are never mountable. `__proto__` / `constructor` / `prototype` walk the
 * prototype chain (see the file header); `slothlet` is the control plane, which is NEVER served or
 * mounted, and `shutdown` / `destroy` are the instance's own teardown handles.
 * @type {Set<string>}
 */
export const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype", "slothlet", "shutdown", "destroy"]);

/**
 * The alphabet a segment must be drawn from: the ECMAScript **IdentifierName** production
 * (`ID_Start`/`ID_Continue` plus `$`, `_` and the two zero-width joiners), which is exactly the set
 * of names a JavaScript `export` can carry.
 *
 * It was `/^[\w$]+$/u` — ASCII-only — and that was wrong. slothlet sanitizes FILE and directory
 * names onto an ASCII alphabet, but a leaf's name comes from its EXPORT name, which it does not
 * touch: `export function café() {}` is a real, callable, `leaves()`-reported leaf whose path an
 * ASCII-only guard silently refuses. A refusal there is not a security win — the segment never
 * reaches a prototype key, which is what {@link UNSAFE_SEGMENTS} exists to stop — it just drops a
 * legitimate leaf on the floor. Property lookup does no unicode normalization, so no member of this
 * alphabet can collide with a reserved name that is not literally spelled that way.
 *
 * The joiners are written as escapes on purpose — as literal characters they are invisible in the
 * source and read as a typo. `U+200C` = ZWNJ, `U+200D` = ZWJ, both legal in an IdentifierPart.
 * @type {RegExp}
 */
const SAFE_SEGMENT = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/**
 * A path segment is mountable when it is a valid JavaScript identifier name (see
 * {@link SAFE_SEGMENT}) and is not one of {@link UNSAFE_SEGMENTS}. Still deliberately narrower than
 * "any string key": a name outside the identifier alphabet is not a path a slothlet instance could
 * have produced, and accepting it would only widen the guard's own attack surface.
 * @param {unknown} segment - Candidate segment.
 * @returns {boolean} True when the segment may be mounted / invoked.
 */
export function isSafeSegment(segment) {
	return typeof segment === "string" && SAFE_SEGMENT.test(segment) && !UNSAFE_SEGMENTS.has(segment);
}

/**
 * A dotted leaf path is safe when it is non-empty and every segment is.
 * @param {unknown} path - Candidate dotted path (e.g. `exts.pdfViewer.open`).
 * @returns {boolean} True when the whole path may be mounted / invoked.
 */
export function isSafePath(path) {
	if (typeof path !== "string" || path.length === 0) return false;
	const segments = path.split(".");
	for (const segment of segments) if (!isSafeSegment(segment)) return false;
	return true;
}

/**
 * A location-string label for a Map key that never risks invoking user code. Unlike a property key
 * from `Reflect.ownKeys` (always a string or symbol, always safe to stringify), a Map key can be ANY
 * value — including a live object whose `toString`/`Symbol.toPrimitive` is user-defined and could
 * throw or run arbitrary code on every walk, not just ones that turn out to hide a function.
 * Primitives stringify normally (no user hook exists to intercept that); anything else gets a
 * generic, content-free placeholder instead of being read at all — same "skip rather than read"
 * reasoning as the accessor-property guard below.
 * @param {unknown} key - The Map key.
 * @returns {string} A safe label.
 */
function safeKeyLabel(key) {
	if (key === null) return "null";
	const type = typeof key;
	return type === "object" || type === "function" ? `<${type}>` : String(key);
}

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
export function findFunctionArg(args) {
	if (!Array.isArray(args)) return "arguments";
	const seen = new Set();

	/**
	 * @param {unknown} value - Current node.
	 * @param {string} where - Location of `value` in the graph.
	 * @returns {string|null} Location of the first function found, else null.
	 */
	function walk(value, where) {
		if (typeof value === "function") return where;
		if (value === null || typeof value !== "object") return null;
		if (seen.has(value)) return null;
		seen.add(value);
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const hit = walk(value[i], `${where}[${i}]`);
				if (hit) return hit;
			}
			return null;
		}
		// Map/Set carry their payload in iteration order, not as own properties.
		if (value instanceof Map) {
			for (const [key, item] of value) {
				const hit = walk(item, `${where}.get(${safeKeyLabel(key)})`) || walk(key, `${where}.key`);
				if (hit) return hit;
			}
			return null;
		}
		if (value instanceof Set) {
			let i = 0;
			for (const item of value) {
				const hit = walk(item, `${where}.item[${i++}]`);
				if (hit) return hit;
			}
			return null;
		}
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || typeof descriptor.get === "function") continue;
			const hit = walk(descriptor.value, `${where}.${String(key)}`);
			if (hit) return hit;
		}
		return null;
	}

	for (let i = 0; i < args.length; i++) {
		const hit = walk(args[i], `arg[${i}]`);
		if (hit) return hit;
	}
	return null;
}

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
export function surfaceFrame(leaves, features = {}) {
	const frame = { type: "surface", v: FRAME_VERSION, leaves: [...leaves] };
	if (features.context === true) frame.context = true;
	return frame;
}

/**
 * Build a `call` frame. The `context` key — the caller's per-call REQUESTED context (#79) — is present
 * only when one was given, so a call without one is byte for byte the v1 frame.
 * @param {string} callId - Correlation id, unique per grow-side link.
 * @param {string} path - The dotted leaf path exactly as served.
 * @param {unknown[]} args - Data-only arguments.
 * @param {object|null} [context] - A data-only plain object, already validated by {@link findContextFault}.
 * @returns {{ type: "call", callId: string, path: string, args: unknown[], context?: object }} The frame.
 */
export function callFrame(callId, path, args, context = null) {
	const frame = { type: "call", callId, path, args };
	if (context !== null && context !== undefined) frame.context = context;
	return frame;
}

/**
 * Is `value` a plain data object — `{}` / `Object.create(null)` — as opposed to an array, a class
 * instance, or a primitive?
 * @param {unknown} value - Candidate.
 * @returns {boolean} True for a plain object.
 */
export function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

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
export function findContextFault(value) {
	try {
		if (!isPlainObject(value)) return "context";
		const functionAt = findFunctionArg([value]);
		if (functionAt !== null) return `context${functionAt.slice("arg[0]".length)}`;
		structuredClone(value);
		return null;
	} catch {
		return "context";
	}
}

/**
 * Build a `result` frame. `value` is always present (possibly `undefined`) so the receiver never has
 * to distinguish "no value" from "undefined value".
 * @param {string} callId - Correlation id being settled.
 * @param {unknown} value - The leaf's resolved value.
 * @returns {{ type: "result", callId: string, value: unknown }} The frame.
 */
export function resultFrame(callId, value) {
	return { type: "result", callId, value };
}

/**
 * Build an `error` frame from a thrown value.
 * @param {string} callId - Correlation id being settled.
 * @param {unknown} err - Whatever the leaf threw.
 * @returns {{ type: "error", callId: string, error: object }} The frame.
 */
export function errorFrame(callId, err) {
	return { type: "error", callId, error: toWire(err) };
}

/** The delivery levels a subscription can be granted, carried on a `sub-ack`. @type {Set<string>} */
export const SUB_LEVELS = new Set(["deny", "notify", "allow"]);

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
export function subFrame(subId, event, subscriberPath) {
	return { type: "sub", subId, event, subscriberPath: subscriberPath ?? null };
}

/**
 * Build a `sub-ack` frame — the serving side's resolved delivery level for a subscription, so a
 * downgrade or denial is a distinct, catchable result on the grow side rather than a silent absence
 * of payloads.
 * @param {string} subId - Correlation id being answered.
 * @param {"deny"|"notify"|"allow"} level - The level the trusted side resolved for the subscriber.
 * @returns {{ type: "sub-ack", subId: string, level: string }} The frame.
 */
export function subAckFrame(subId, level) {
	return { type: "sub-ack", subId, level };
}

/**
 * Build an `event` frame — one forwarded delivery for a subscription. `payload` is present ONLY when
 * `withPayload` is true (an `allow` delivery); at `notify` it is omitted entirely, so a notify
 * subscriber's domain payload never crosses the boundary.
 * @param {string} subId - The subscription being delivered to.
 * @param {{ event: string, at: number, instanceID: string }} meta - The trigger envelope.
 * @param {boolean} withPayload - Whether to carry the domain payload.
 * @param {unknown} payload - The domain payload (included only when `withPayload`).
 * @returns {object} The frame.
 */
export function eventFrame(subId, meta, withPayload, payload) {
	const frame = { type: "event", subId, event: meta.event, at: meta.at, instanceID: meta.instanceID };
	if (withPayload) frame.payload = payload;
	return frame;
}

/**
 * Build an `unsub` frame — a grow-side request to tear down a subscription on the serving side.
 * @param {string} subId - The subscription to remove.
 * @returns {{ type: "unsub", subId: string }} The frame.
 */
export function unsubFrame(subId) {
	return { type: "unsub", subId };
}

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
 * @returns {object|null} A normalized frame, or null when the message is not a frame this version handles.
 */
export function parseFrame(message) {
	try {
		if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
		const type = message.type;
		if (typeof type !== "string") return null;

		if (type === "surface") {
			if (message.v !== FRAME_VERSION) return null;
			if (!Array.isArray(message.leaves)) return null;
			/** @type {string[]} */
			const leaves = [];
			/** @type {string[]} */
			const unsafe = [];
			for (const leaf of message.leaves) {
				if (isSafePath(leaf)) leaves.push(leaf);
				else unsafe.push(typeof leaf === "string" ? leaf : String(leaf));
			}
			const frame = { type: "surface", v: FRAME_VERSION, leaves, unsafe };
			// #79: the serve accepts a requested context. Only a literal `true` counts.
			if (message.context === true) frame.context = true;
			return frame;
		}

		// Event-forwarding frames key on `subId`, not `callId`. `subscriberPath` is UNTRUSTED here, but
		// it is only ever glob-matched against event rules (never a mount/property key), so an arbitrary
		// string cannot pollute a prototype the way an unguarded `call` path could — a type check suffices.
		if (type === "sub") {
			if (typeof message.subId !== "string" || message.subId.length === 0) return null;
			if (typeof message.event !== "string" || message.event.length === 0) return null;
			const subscriberPath = message.subscriberPath;
			if (subscriberPath !== null && typeof subscriberPath !== "string") return null;
			return { type: "sub", subId: message.subId, event: message.event, subscriberPath };
		}
		if (type === "sub-ack") {
			if (typeof message.subId !== "string" || message.subId.length === 0) return null;
			if (!SUB_LEVELS.has(message.level)) return null;
			return { type: "sub-ack", subId: message.subId, level: message.level };
		}
		if (type === "event") {
			if (typeof message.subId !== "string" || message.subId.length === 0) return null;
			if (typeof message.event !== "string") return null;
			// Whether the domain payload crossed is carried by the PRESENCE of the `payload` key, not its
			// value: an `allow` delivery of an explicit `undefined` still arrives as a delivered payload,
			// while a `notify` delivery has no key at all. `hasPayload` preserves that distinction.
			const hasPayload = Object.prototype.hasOwnProperty.call(message, "payload");
			const frame = {
				type: "event",
				subId: message.subId,
				event: message.event,
				at: message.at,
				instanceID: message.instanceID,
				hasPayload
			};
			if (hasPayload) frame.payload = message.payload;
			return frame;
		}
		if (type === "unsub") {
			if (typeof message.subId !== "string" || message.subId.length === 0) return null;
			return { type: "unsub", subId: message.subId };
		}

		const callId = message.callId;
		if (typeof callId !== "string" || callId.length === 0) return null;

		if (type === "call") {
			if (!isSafePath(message.path)) return null;
			if (!Array.isArray(message.args)) return null;
			const frame = { type: "call", callId, path: message.path, args: [...message.args] };
			// #79: a requested context is carried through RAW — `null` / `undefined` mean "none", anything
			// else is validated by the serve, which answers `VINE_DATA_ONLY` for a bad one rather than
			// dropping the frame (a dropped call would only settle on the caller's budget).
			const context = message.context;
			if (context !== undefined && context !== null) frame.context = context;
			return frame;
		}
		if (type === "result") {
			return { type: "result", callId, value: message.value };
		}
		if (type === "error") {
			const error = message.error;
			if (error === null || typeof error !== "object") return null;
			return { type: "error", callId, error };
		}
		return null;
	} catch {
		// A hostile object (throwing getter on `type`, `Array.isArray`-defeating proxy, …) is junk,
		// not an exception the link should propagate.
		return null;
	}
}
