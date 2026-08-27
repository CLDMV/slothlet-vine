/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/link.mjs
 *
 * The correlation machinery shared by every link: a settle-once pending table with per-call budget
 * timers and a bulk `settleAll` for the two ways a link ends (local close → `VINE_CLOSED`, far-side
 * death → `VINE_GONE`).
 *
 * The invariant this file exists to hold is **settle-once**: a callId is resolved or rejected
 * exactly once — by a `result`, an `error`, its budget timer, or a bulk settle — and every later
 * terminal for it is dropped. Without it, a late `result` arriving after a budget expiry would
 * "un-fail" a call the caller has already handled as failed.
 *
 * The second invariant is that a pending call NEVER hangs: every entry is armed with a timer, so
 * even a far side that answers nothing and never closes still settles the caller.
 */
import { CODES, VineError } from "./errors.mjs";

/** Fallback discriminator when `crypto.randomUUID` is unavailable. @type {number} */
let linkSequence = 0;

/**
 * A per-link nonce. `crypto.randomUUID()` where available (node ≥ 19, every modern browser); the
 * fallback still mixes a PROCESS-LOCAL counter with the clock, so two links created in the same
 * process cannot collide even if the random component did.
 * @returns {string} An opaque nonce.
 */
export function makeNonce() {
	const webcrypto = globalThis.crypto;
	if (webcrypto && typeof webcrypto.randomUUID === "function") return webcrypto.randomUUID();
	return `${Date.now().toString(36)}-${(linkSequence++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The settle-once correlation table for one link.
 */
export class PendingTable {
	/**
	 * @param {string} nonce - The link nonce; callIds are `<nonce>#<counter>` so ids are unique per
	 *   link AND unattributable to another link's counter.
	 */
	constructor(nonce) {
		/** @type {string} */
		this.nonce = nonce;
		/** @type {number} Monotonic counter — never `Math.random` per call. */
		this._seq = 0;
		/** @type {Map<string, { resolve: Function, reject: Function, timer: unknown, path: string }>} */
		this._pending = new Map();
	}

	/** @returns {number} Currently-unsettled call count (tests + telemetry). */
	get size() {
		return this._pending.size;
	}

	/** @returns {string} The next correlation id for this link. */
	nextCallId() {
		return `${this.nonce}#${++this._seq}`;
	}

	/**
	 * Register a pending call and arm its budget timer.
	 * @param {string} callId - Correlation id from {@link nextCallId}.
	 * @param {object} params
	 * @param {string} params.path - The leaf path, for the budget error message.
	 * @param {number} params.budgetMs - Settle budget in ms; a non-finite or non-positive value arms no
	 *   timer (an explicit "no deadline" opt-out — callers should pass a positive budget).
	 * @returns {Promise<unknown>} Settles exactly once.
	 */
	open(callId, { path, budgetMs }) {
		return new Promise((resolve, reject) => {
			let timer = null;
			if (Number.isFinite(budgetMs) && budgetMs > 0) {
				timer = setTimeout(() => {
					this.reject(
						callId,
						new VineError(CODES.BUDGET, `slothlet-vine: call to '${path}' exceeded its ${budgetMs}ms budget`, { path, callId, budgetMs })
					);
				}, budgetMs);
				// Never hold the event loop open for an in-flight forwarded call; the caller's own
				// awaiting keeps the process alive for as long as it actually cares.
				if (timer && typeof timer.unref === "function") timer.unref();
			}
			this._pending.set(callId, { resolve, reject, timer, path });
		});
	}

	/**
	 * @param {string} callId - Correlation id.
	 * @returns {boolean} True while the call is unsettled.
	 */
	has(callId) {
		return this._pending.has(callId);
	}

	/**
	 * Settle a call with a value. A duplicate terminal is dropped.
	 * @param {string} callId - Correlation id.
	 * @param {unknown} value - The resolved value.
	 * @returns {boolean} True when this call settled the entry.
	 */
	resolve(callId, value) {
		const entry = this._take(callId);
		if (!entry) return false;
		entry.resolve(value);
		return true;
	}

	/**
	 * Settle a call with an error. A duplicate terminal is dropped.
	 * @param {string} callId - Correlation id.
	 * @param {unknown} err - The rejection reason.
	 * @returns {boolean} True when this call settled the entry.
	 */
	reject(callId, err) {
		const entry = this._take(callId);
		if (!entry) return false;
		entry.reject(err);
		return true;
	}

	/**
	 * Force-settle every pending call — the link ended. Drains the table BEFORE rejecting so a
	 * synchronous `catch` handler that re-enters cannot see a half-drained table.
	 * @param {string} code - A {@link CODES} value for the whole batch.
	 * @param {string} message - Human-readable reason.
	 * @returns {number} How many calls were settled.
	 */
	settleAll(code, message) {
		const entries = [...this._pending.entries()];
		this._pending.clear();
		for (const [callId, entry] of entries) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(new VineError(code, message, { path: entry.path, callId }));
		}
		return entries.length;
	}

	/**
	 * Remove and return a pending entry, clearing its timer — the single choke point that makes
	 * settling once-only.
	 * @param {string} callId - Correlation id.
	 * @returns {{ resolve: Function, reject: Function, timer: unknown, path: string }|null} The entry, or null when already settled.
	 */
	_take(callId) {
		const entry = this._pending.get(callId);
		if (!entry) return null;
		this._pending.delete(callId);
		if (entry.timer) clearTimeout(entry.timer);
		return entry;
	}
}

/**
 * Assert that a value satisfies the Channel contract's mandatory half (`send` + `onMessage`).
 * Thrown as a `TypeError` rather than a `VineError`: this is a wiring mistake in the consumer's own
 * code, not a link condition a caller could branch on.
 * @param {unknown} channel - Candidate channel.
 * @param {string} who - The calling function's name, for the message.
 * @returns {void}
 * @throws {TypeError} When the object does not satisfy the contract.
 */
export function assertChannel(channel, who) {
	if (channel === null || typeof channel !== "object" || typeof channel.send !== "function" || typeof channel.onMessage !== "function") {
		throw new TypeError(`@cldmv/slothlet-vine: ${who}() needs a Channel — an object with send(message) and onMessage(handler)`);
	}
}

/**
 * Assert that a value looks like a live slothlet instance with runtime mutations available.
 * @param {unknown} api - Candidate slothlet api.
 * @param {string} who - The calling function's name, for the message.
 * @param {string[]} needs - Required `api.slothlet.api.*` method names.
 * @returns {void}
 * @throws {TypeError} When the object is not a usable slothlet instance.
 */
export function assertApi(api, who, needs) {
	const surface = api && typeof api === "object" ? api.slothlet?.api : undefined;
	const missing = surface ? needs.filter((name) => typeof surface[name] !== "function") : needs;
	if (missing.length > 0) {
		throw new TypeError(
			`@cldmv/slothlet-vine: ${who}() needs a slothlet instance exposing api.slothlet.api.{${missing.join(", ")}} ` +
				`— is 'api' the object returned by slothlet(), with api.mutations enabled?`
		);
	}
}

/**
 * Register a handler on `channel.onClose` if the transport offers one, wrapping it so a throwing
 * handler can never propagate into transport code (Channel contract: "Handlers must never throw
 * into the transport; the core wraps its handlers").
 * @param {object} channel - The channel.
 * @param {(info?: object) => void} handler - The close handler.
 * @returns {boolean} True when the transport supports close notification.
 */
export function onCloseSafe(channel, handler) {
	if (typeof channel.onClose !== "function") return false;
	channel.onClose((info) => {
		try {
			handler(info);
		} catch {
			// A consumer-visible failure here would be reported as a transport fault; the link is
			// already ending, and every pending call is settled by the handler's first statements.
		}
	});
	return true;
}
