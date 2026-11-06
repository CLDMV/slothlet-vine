/**
 * Grow a vine from this instance to the far tree on `channel`: await the far side's `surface` frame,
 * mount a forwarding stub per leaf, and return the live link.
 *
 * @param {object} api - The local slothlet instance (the object `slothlet()` returned).
 * @param {import("./index.mjs").Channel} channel - The transport seam.
 * @param {object} [options]
 * @param {number} [options.budgetMs=30000] - Per-call settle budget; expiry settles that call with
 *   `VINE_BUDGET` and a later result frame for it is dropped (settle-once).
 * @param {number} [options.handshakeMs] - Budget for the `surface` frame itself; defaults to
 *   `budgetMs`. **Addition to `docs/DESIGN.md`**, which specifies no handshake deadline: without one
 *   a far side that never publishes leaves would hang `await grow(...)` forever, which contradicts
 *   the design's own "pending calls NEVER hang" rule. `Infinity` is the explicit opt-out and waits
 *   indefinitely; anything else that is not a positive finite number (`null`, `0`, `-1`, `NaN`, a
 *   string) falls back to the default rather than quietly meaning "no deadline" — the same reading
 *   `budgetMs` gets, and the safe one, since the failure mode of a missing deadline is a `grow()`
 *   that never settles.
 * @param {string[]} [options.paths] - Optional dotted prefixes; only far leaves at or under one of
 *   them are mounted. A local defence in depth — the serving side filters too, but a grow should not
 *   have to trust that it did. Same fail-closed reading as
 *   {@link import("./serve.mjs").serve}: an array with no usable prefix mounts nothing; a non-array
 *   value is ignored.
 * @param {string|{ path: string, context?: object }|(() => string|{ path: string, context?: object })} [options.principal] -
 *   The **channel principal** (#33) for the EVENT SERVER-HALF of this end only. A grow end answers no
 *   `call` frames (a stray one is ignored), but it does answer the far side's `sub` frames for THIS
 *   instance's events — and the trusted end of a channel is not always the serving end (a host that
 *   grows leaves out of an untrusted worker plugin still serves that plugin's subscriptions). With a
 *   principal, every far `sub` is resolved as `principal.path` (inside `context.run(principal.context)`
 *   when a context is given), the far `subscriberPath` can only NARROW that level, and `null` no
 *   longer means "host". Same shapes and fail-closed rules as `serve()`'s. Only the event-side
 *   preconditions apply here — the permission system must be enabled and `api.slothlet.event.resolveLevel`
 *   must exist (plus a working `context.run` when a static principal carries a `context`);
 *   `permissions.global.checkCall` is NOT required, because a grow answers no calls. Omit it for a
 *   trusted transport: nothing changes.
 * @param {object|(() => object|null|undefined)} [options.context] - The link's DEFAULT per-call
 *   **requested context** (#79): attached to every call made over this link outside a
 *   {@link link.with} extent. A plain, data-only object (validated here, copied once), or a function
 *   called synchronously per call that answers one (or `null` / `undefined` for none) — the way a
 *   client sends whatever it currently has pinned without the far side holding any state. A request,
 *   never identity: the far side's `serve({ context })` check accepts, narrows or refuses it. A call
 *   carrying one is refused locally (`VINE_CONTEXT`, nothing sent) when the far side did not advertise
 *   that it accepts requested contexts; a resolver that throws rejects that call with its error, and
 *   an answer that is not data rejects it `VINE_DATA_ONLY`.
 * @returns {Promise<{ id: string, leaves: string[], skipped: string[], collisions: string[], context: boolean, with: Function, close: () => Promise<void>, closed: Promise<{reason: string, info?: object}>, event: { on: Function, once: Function } }>}
 *   The live link. The three path lists are DISJOINT and together account for every leaf the far
 *   side published: `leaves` are the paths actually mounted and forwarding; `skipped` are far leaves
 *   refused locally (unsafe path, outside `paths`, rejected by `add()`, or published after the link
 *   had already ended); `collisions` are paths the local instance already occupied, which are NOT
 *   mounted — the incumbent keeps answering there and the far leaf is unreachable through this link.
 *   `context` is whether the far side accepts a requested context (its `surface` advertised it), and
 *   `with(context, fn, ...args)` runs `fn` with a requested context on every call it makes over THIS link.
 * @throws {TypeError} When `api` is not a slothlet instance or `channel` is not a Channel, when
 *   `context` is not a function or a plain object — or, with a
 *   `principal`, when it is malformed or the instance cannot enforce it (see `options.principal`).
 * @throws {VineError} `VINE_DATA_ONLY` when a static `context` is not data.
 * @throws {VineError} `VINE_GONE` when the channel closes before the surface arrives, `VINE_BUDGET`
 *   when the handshake budget elapses first.
 *
 * @example
 * const link = await grow(api, channel, { budgetMs: 5000 });
 * await api.exts.pdfViewer.open("a.pdf"); // runs on the far side
 * await link.close();                      // stubs unmounted, pending calls settle VINE_CLOSED
 */
export function grow(api: object, channel: import("./index.mjs").Channel, options?: {
    budgetMs?: number | undefined;
    handshakeMs?: number | undefined;
    paths?: string[] | undefined;
    principal?: string | {
        path: string;
        context?: object;
    } | (() => string | {
        path: string;
        context?: object;
    }) | undefined;
    context?: object | (() => object | null | undefined);
}): Promise<{
    id: string;
    leaves: string[];
    skipped: string[];
    collisions: string[];
    context: boolean;
    with: Function;
    close: () => Promise<void>;
    closed: Promise<{
        reason: string;
        info?: object;
    }>;
    event: {
        on: Function;
        once: Function;
    };
}>;
/** Default per-call settle budget, in ms. @type {number} */
export const DEFAULT_BUDGET_MS: number;
