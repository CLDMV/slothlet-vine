/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/frame.mjs
 *
 * The wire frames (`schemas/frame.schema.json` is normative) plus the two guards that stand between
 * a hostile or merely buggy far side and this process: {@link parseFrame}, which is TOTAL — it
 * returns a typed frame or `null` and never throws, whatever junk arrives — and {@link isSafePath},
 * which refuses dotted paths that would let a remote surface listing write through
 * `Object.prototype`.
 *
 * ## Why the path guard is not theoretical (probed against @cldmv/slothlet 3.14.0)
 *
 * `api.slothlet.api.add("__proto__.x", fn)` and `add("constructor.prototype.pwn", fn)` are both
 * ACCEPTED by slothlet, and both land the function on `Object.prototype` — `({}).x` becomes that
 * function process-wide. Since the leaf list in a `surface` frame comes from the FAR side, an
 * unguarded `grow` would hand a remote peer prototype pollution for free. Slothlet does guard its
 * own reserved roots (`slothlet` / `shutdown` / `destroy` are refused with
 * `INVALID_CONFIG_API_PATH_INVALID`), so the gap is exactly the prototype chain — which is what
 * {@link UNSAFE_SEGMENTS} closes.
 *
 * Reported upstream as CLDMV/slothlet#302 and being hardened in slothlet by CLDMV/slothlet#305, but
 * this guard STAYS regardless of the slothlet version: it validates UNTRUSTED remote surface paths
 * at vine's own boundary, which is vine's responsibility to enforce independent of what any
 * downstream `add()` does (and vine's peer floor spans slothlet versions that predate the fix).
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
 * @param {string[]} leaves - Dotted callable paths being served.
 * @returns {{ type: "surface", v: number, leaves: string[] }} The frame.
 */
export function surfaceFrame(leaves) {
	return { type: "surface", v: FRAME_VERSION, leaves: [...leaves] };
}

/**
 * Build a `call` frame.
 * @param {string} callId - Correlation id, unique per grow-side link.
 * @param {string} path - The dotted leaf path exactly as served.
 * @param {unknown[]} args - Data-only arguments.
 * @returns {{ type: "call", callId: string, path: string, args: unknown[] }} The frame.
 */
export function callFrame(callId, path, args) {
	return { type: "call", callId, path, args };
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
			return { type: "surface", v: FRAME_VERSION, leaves, unsafe };
		}

		const callId = message.callId;
		if (typeof callId !== "string" || callId.length === 0) return null;

		if (type === "call") {
			if (!isSafePath(message.path)) return null;
			if (!Array.isArray(message.args)) return null;
			return { type: "call", callId, path: message.path, args: [...message.args] };
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
