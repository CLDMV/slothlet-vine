/**
 * A per-link nonce. `crypto.randomUUID()` where available (node ≥ 19, every modern browser); the
 * fallback still mixes a PROCESS-LOCAL counter with the clock, so two links created in the same
 * process cannot collide even if the random component did.
 * @returns {string} An opaque nonce.
 */
export function makeNonce(): string;
/**
 * Assert that a value satisfies the Channel contract's mandatory half (`send` + `onMessage`).
 * Thrown as a `TypeError` rather than a `VineError`: this is a wiring mistake in the consumer's own
 * code, not a link condition a caller could branch on.
 * @param {unknown} channel - Candidate channel.
 * @param {string} who - The calling function's name, for the message.
 * @returns {void}
 * @throws {TypeError} When the object does not satisfy the contract.
 */
export function assertChannel(channel: unknown, who: string): void;
/**
 * Assert that a value looks like a live slothlet instance with runtime mutations available.
 * @param {unknown} api - Candidate slothlet api.
 * @param {string} who - The calling function's name, for the message.
 * @param {string[]} needs - Required `api.slothlet.api.*` method names.
 * @returns {void}
 * @throws {TypeError} When the object is not a usable slothlet instance.
 */
export function assertApi(api: unknown, who: string, needs: string[]): void;
/**
 * Register a handler on `channel.onClose` if the transport offers one, wrapping it so a throwing
 * handler can never propagate into transport code (Channel contract: "Handlers must never throw
 * into the transport; the core wraps its handlers").
 * @param {import("../index.mjs").Channel} channel - The channel.
 * @param {(info?: object) => void} handler - The close handler.
 * @returns {boolean} True when the transport supports close notification.
 */
export function onCloseSafe(channel: import("../index.mjs").Channel, handler: (info?: object) => void): boolean;
/**
 * The settle-once correlation table for one link.
 */
export class PendingTable {
    /**
     * @param {string} nonce - The link nonce; callIds are `<nonce>#<counter>` so ids are unique per
     *   link AND unattributable to another link's counter.
     */
    constructor(nonce: string);
    /** @type {string} */
    nonce: string;
    /** @type {number} Monotonic counter — never `Math.random` per call. */
    _seq: number;
    /** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>|null, path: string }>} */
    _pending: Map<string, {
        resolve: Function;
        reject: Function;
        timer: ReturnType<typeof setTimeout> | null;
        path: string;
    }>;
    /** @returns {number} Currently-unsettled call count (tests + telemetry). */
    get size(): number;
    /** @returns {string} The next correlation id for this link. */
    nextCallId(): string;
    /**
     * Register a pending call and arm its budget timer.
     * @param {string} callId - Correlation id from {@link nextCallId}.
     * @param {object} params
     * @param {string} params.path - The leaf path, for the budget error message.
     * @param {number} params.budgetMs - Settle budget in ms; a non-finite or non-positive value arms no
     *   timer (an explicit "no deadline" opt-out — callers should pass a positive budget).
     * @returns {Promise<unknown>} Settles exactly once.
     */
    open(callId: string, { path, budgetMs }: {
        path: string;
        budgetMs: number;
    }): Promise<unknown>;
    /**
     * @param {string} callId - Correlation id.
     * @returns {boolean} True while the call is unsettled.
     */
    has(callId: string): boolean;
    /**
     * Settle a call with a value. A duplicate terminal is dropped.
     * @param {string} callId - Correlation id.
     * @param {unknown} value - The resolved value.
     * @returns {boolean} True when this call settled the entry.
     */
    resolve(callId: string, value: unknown): boolean;
    /**
     * Settle a call with an error. A duplicate terminal is dropped.
     * @param {string} callId - Correlation id.
     * @param {unknown} err - The rejection reason.
     * @returns {boolean} True when this call settled the entry.
     */
    reject(callId: string, err: unknown): boolean;
    /**
     * Force-settle every pending call — the link ended. Drains the table BEFORE rejecting so a
     * synchronous `catch` handler that re-enters cannot see a half-drained table.
     * @param {string} code - A {@link CODES} value for the whole batch.
     * @param {string} message - Human-readable reason.
     * @returns {number} How many calls were settled.
     */
    settleAll(code: string, message: string): number;
    /**
     * Remove and return a pending entry, clearing its timer — the single choke point that makes
     * settling once-only.
     * @param {string} callId - Correlation id.
     * @returns {{ resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>|null, path: string }|null} The entry, or null when already settled.
     */
    _take(callId: string): {
        resolve: Function;
        reject: Function;
        timer: ReturnType<typeof setTimeout> | null;
        path: string;
    } | null;
}
