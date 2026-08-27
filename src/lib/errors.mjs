/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/errors.mjs
 *
 * The vine error taxonomy and its wire form. Every failure a vine produces on its own account is a
 * {@link VineError} carrying a stable `.code` from {@link CODES}; a failure produced by the FAR
 * side's application code crosses as data and is re-thrown locally as a {@link VineRemoteError}
 * that keeps the original `name` / `message` / `code` and carries the far stack as `.remoteStack`.
 *
 * The one thing a far side may NOT dictate is a vine code: a remote `code` in the reserved `VINE_*`
 * namespace is remapped to `VINE_REMOTE` (original on `.remoteCode`), so no peer can make a
 * consumer's `err.code === CODES.CLOSED` link-state branch fire. See {@link VineRemoteError}.
 *
 * See `docs/DESIGN.md` § "API surface" for the normative code list.
 */

/**
 * Stable machine codes carried on `.code`. `REMOTE` is the fallback for a remote application error
 * whose own error carried no `code` — every other entry is a vine-produced condition.
 * @type {Readonly<Record<string, string>>}
 */
export const CODES = Object.freeze({
	/** The far side died / its channel closed with the call still in flight. */
	GONE: "VINE_GONE",
	/** The per-call settle budget elapsed before a terminal frame arrived. */
	BUDGET: "VINE_BUDGET",
	/** `link.close()` was called with the call still in flight, or a call was made after close. */
	CLOSED: "VINE_CLOSED",
	/** A function-valued argument was found in the argument graph — the vine is data-only in v1. */
	DATA_ONLY: "VINE_DATA_ONLY",
	/** A frame could not be parsed, or an outbound frame could not be handed to the transport. */
	BAD_FRAME: "VINE_BAD_FRAME",
	/** A call named a path that is not in the served surface (re-validated serve-side every call). */
	NO_LEAF: "VINE_NO_LEAF",
	/**
	 * `.code` for a remote application error that carried none of its own — and for one whose code
	 * was in the reserved `VINE_*` namespace, which is never adopted from the wire (the far side's
	 * spelling is kept on `.remoteCode`). See {@link VineRemoteError}.
	 */
	REMOTE: "VINE_REMOTE"
});

/**
 * Fields on a details object that may never be copied onto the error — they are owned by `Error`
 * (or set by the constructor) and letting a caller/wire value overwrite them would make the error
 * lie about itself.
 * @type {Set<string>}
 */
const RESERVED_DETAIL_KEYS = new Set(["name", "message", "stack", "code"]);

/**
 * A failure the vine itself produced. Always carries a `.code` from {@link CODES}; any extra
 * `details` (typically `path`, `callId`, `budgetMs`) are copied on as own properties.
 * @augments Error
 */
export class VineError extends Error {
	/**
	 * @param {string} code - A {@link CODES} value.
	 * @param {string} message - Human-readable description.
	 * @param {Record<string, unknown>} [details] - Extra own properties (reserved keys are ignored).
	 */
	constructor(code, message, details) {
		super(message);
		/** @type {string} */
		this.name = "VineError";
		/** @type {string} Stable machine code — branch on this, never on `message`. */
		this.code = code;
		if (details && typeof details === "object") {
			for (const key of Object.keys(details)) {
				if (RESERVED_DETAIL_KEYS.has(key)) continue;
				this[key] = details[key];
			}
		}
	}
}

/**
 * Codes reserved to the vine itself. A code matching this may never be adopted as `.code` from the
 * wire — see {@link VineRemoteError}.
 * @type {RegExp}
 */
const RESERVED_CODE = /^VINE_/;

/**
 * A far-side application error, re-thrown locally. It deliberately impersonates the original error:
 * `.name` and `.message` are the remote's own, and so is `.code` — so existing
 * `err.code === "E_THING"` checks keep working across the boundary. Because `.name` is the REMOTE
 * name, use `instanceof VineRemoteError` (or `.remoteStack`) — not `.name` — to tell a forwarded
 * error from a local one.
 *
 * ## The one code that is NOT adopted: `VINE_*`
 *
 * `.code` is adopted from the wire with a single exception — **any remote code in the reserved
 * `VINE_*` namespace is remapped to `VINE_REMOTE`**, and the far side's own spelling is kept on
 * `.remoteCode`. Without that, a far side (hostile, or merely running its own vine and forwarding a
 * failure verbatim) could send `{ name: "VineError", code: "VINE_CLOSED" }` and the resulting error
 * would satisfy `err instanceof VineError && err.code === CODES.CLOSED` — the documented way to
 * branch on link state — and drive a consumer's teardown path from across the boundary. A vine
 * link-state code means *this* link's state; it can only ever be produced locally.
 *
 * The remap is deliberately blind to which `VINE_*` code arrived, including ones the far side's own
 * serve legitimately produced (`VINE_NO_LEAF`, `VINE_DATA_ONLY`): read `.remoteCode` to see what the
 * far side said, and `.code` to know it came from over there.
 * @augments VineError
 */
export class VineRemoteError extends VineError {
	/**
	 * @param {{ name?: string, message?: string, code?: string, stack?: string }} wire - Wire error shape.
	 */
	constructor(wire) {
		// Every read is guarded: `wire` is attacker-controlled data off the channel, and a throwing
		// getter here would escape into the receive handler, where the call it was settling would be
		// left pending until its budget expires — the exact hang the taxonomy exists to prevent.
		const safe = wire && typeof wire === "object" ? wire : {};
		const remoteCode = readString(safe, "code");
		super(remoteCode === undefined || RESERVED_CODE.test(remoteCode) ? CODES.REMOTE : remoteCode, readString(safe, "message") ?? "");
		const name = readString(safe, "name");
		/** @type {string} The remote error's own `name` (NOT "VineRemoteError"). */
		this.name = name !== undefined && name !== "" ? name : "Error";
		/** @type {string|undefined} The far side's own `code`, verbatim — including a reserved `VINE_*` one. */
		this.remoteCode = remoteCode;
		/** @type {string|undefined} The far side's stack, kept off `.stack` so the local trace stays local. */
		this.remoteStack = readString(safe, "stack");
	}
}

/**
 * Project any thrown value onto the wire error shape (`schemas/frame.schema.json` → error.error).
 * Total: a thrown string, `null`, or an exotic object all produce a valid shape rather than throwing
 * inside the error path. The stack crosses on purpose — a forwarded failure is otherwise unreadable
 * on the growing side, which is where it surfaces.
 * @param {unknown} err - The thrown value.
 * @returns {{ name: string, message: string, code?: string, stack?: string }} Wire error.
 */
export function toWire(err) {
	if (err === null || (typeof err !== "object" && typeof err !== "function")) {
		// A thrown primitive IS the message — including the literal "null" / "undefined", which are
		// more useful to a reader than an empty string would be.
		return { name: "Error", message: err === null ? "null" : err === undefined ? "undefined" : safeString(err, "Error") };
	}
	// Every read is guarded: `err` is whatever the leaf threw, and a throwing accessor here would
	// replace a reportable failure with an unreportable one on the error path itself.
	try {
		/** @type {{ name: string, message: string, code?: string, stack?: string }} */
		const wire = { name: safeString(err.name, "Error"), message: safeString(err.message, "") };
		if (typeof err.code === "string") wire.code = err.code;
		else if (typeof err.code === "number") wire.code = String(err.code);
		if (typeof err.stack === "string") wire.stack = err.stack;
		return wire;
	} catch {
		return { name: "Error", message: "" };
	}
}

/**
 * Rebuild a throwable from the wire error shape — the inverse of {@link toWire}. TOTAL: a hostile
 * wire value (throwing getters, an unstringifiable primitive) still produces an error, because the
 * caller this settles must never be left pending on a malformed rejection.
 * @param {unknown} wire - Wire error (tolerated: anything).
 * @returns {VineRemoteError} The re-thrown-shaped error.
 */
export function fromWire(wire) {
	if (wire && typeof wire === "object") return new VineRemoteError(wire);
	// Mirrors toWire's reading of a non-object throw: the value IS the message, and the literal
	// "null" / "undefined" is more useful to a reader than an empty string.
	return new VineRemoteError({ message: wire === null ? "null" : wire === undefined ? "undefined" : safeString(wire, "") });
}

/**
 * Read one property as a string, tolerating a hostile source: a throwing getter, an exotic Proxy, or
 * a non-string value all answer `undefined` instead of propagating.
 * @param {object} source - The (untrusted) object to read from.
 * @param {string} key - Property name.
 * @returns {string|undefined} The string value, or undefined when absent / not a string / unreadable.
 */
function readString(source, key) {
	try {
		const value = source[key];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Coerce a value to a string without ever invoking a hostile `toString` twice or throwing.
 * @param {unknown} value - Candidate.
 * @param {string} fallback - Used when `value` is absent or not coercible.
 * @returns {string} A string.
 */
function safeString(value, fallback) {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return fallback;
	try {
		return String(value);
	} catch {
		return fallback;
	}
}
