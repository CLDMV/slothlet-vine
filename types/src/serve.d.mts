/**
 * Serve this instance's leaves to the far side of `channel`.
 *
 * **Deviation from `docs/DESIGN.md`, stated plainly:** the design sketch calls this without `await`.
 * It cannot be synchronous — the surface is read from the loader's records and
 * `api.slothlet.api.leaves()` is async — so `serve` returns a Promise for the documented
 * `{ leaves, close }` object. Everything else matches the sketch; `await` the call.
 *
 * @param {object} api - The local slothlet instance (the object `slothlet()` returned).
 * @param {import("./index.mjs").Channel} channel - The transport seam.
 * @param {object} [options]
 * @param {string[]} [options.paths] - Dotted prefixes to serve. A leaf is served when it equals a
 *   prefix or sits under it. Omit for every callable leaf of the base load. An ARRAY that yields no
 *   usable prefix (`[]`, `["", 7]`) serves NOTHING — a filter that cannot be satisfied is not the
 *   same as no filter, and the fail-closed reading is the safe one for a surface. A non-array value
 *   is ignored.
 * @param {string[]} [options.modules] - Additional moduleIDs (or mount endpoints) whose leaves are
 *   unioned into the surface — the way to serve runtime `api.slothlet.api.add()` mounts, which
 *   `leaves(".")` does not cover. Unknown ids are skipped rather than fatal.
 * @param {number} [options.budgetMs=30000] - Settle budget for THIS end's own event subscriptions to
 *   the far instance (a `sub-ack` that never arrives settles `VINE_BUDGET`). Not used for calls — a
 *   serve answers calls, it does not make them.
 * @param {string|{ path: string, context?: object }|(() => string|{ path: string, context?: object })} [options.principal] -
 *   The **channel principal** (#33): the caller identity this serve binds to the channel, obtained by
 *   the host from the transport's own authentication (a ws upgrade, a token) — never from a frame.
 *   With one set, EVERY `call` frame is judged by slothlet's rules engine as `principal.path` calling
 *   the leaf with the frame's `args`, inside a context scope carrying `principal.context`
 *   (write-protected), and a denial is answered `VINE_DENIED` without the leaf ever running; EVERY
 *   `sub` frame is resolved as the principal, and the far side's own `subscriberPath` can only narrow
 *   that level (`null` no longer means "host"). A string is `{ path }`; a function is called
 *   synchronously per frame and may answer either form (a throw or junk denies that frame). Requires
 *   the instance's permission system to be enabled, `api.slothlet.context.scope` to work, and
 *   `api.slothlet.permissions.global.checkCall` (@cldmv/slothlet ≥ 3.22.0) —
 *   each checked here, fail-closed, as a `TypeError`. Omit it for a trusted transport (a worker you
 *   spawned, a process you forked): nothing changes, byte for byte. See `docs/PERMISSIONS.md`.
 * @param {(requested: object, call: { principal: Readonly<{ path: string, context?: object }>|null, path: string, args: unknown[] }) => object|false|null|undefined|Promise<object|false|null|undefined>} [options.context] -
 *   The host check for a per-call **requested context** (#79): a data-only plain object the far side
 *   attaches to one `call` frame (grow-side `link.with(context, fn)` or `grow({ context })`) — a request,
 *   never identity. Called only for frames that carry one, after the principal is resolved and before
 *   the permission gate, with a private copy of the request, the resolved principal (`null` without
 *   one), the path and the frame's arguments. It ACCEPTS by answering a plain object — the request
 *   itself, or a narrowed or changed one — and REFUSES by answering anything else (`false`, `null`, a
 *   non-plain or function-bearing object) or by throwing/rejecting; a refusal is `VINE_CONTEXT` and
 *   the leaf never runs. May be async. The accepted keys are merged into the call's context scope
 *   UNDER the principal's (a principal key always wins) and every key is write-protected, so
 *   `checkCall`, rule conditions, `requires`-principals, `around` and the leaf all see it and none
 *   can rewrite it. **Without this option a frame that carries a requested context is refused**
 *   (`VINE_CONTEXT`), so a client is never silently unscoped; with it, the `surface` frame advertises
 *   `context: true`, which a grow needs before it will send one. Requires a working
 *   `api.slothlet.context.scope` (checked at setup as a `TypeError`); a principal is NOT required.
 * @param {(call: { callId: string, path: string, args: unknown[], principal: Readonly<{ path: string, context?: object }>|null, context: object|null, invoke: () => Promise<unknown> }) => unknown} [options.around] -
 *   A per-call wrapper (#51) for the host's own scope around each ACCEPTED call: a transaction, a
 *   deadline, an audit record. It runs after every check the vine makes — the served-surface check,
 *   the principal gate (inside the principal's context scope), and the args data-only check — so it
 *   never sees a frame the vine would have refused. `invoke()` runs the gated leaf with the frame's
 *   arguments; it takes no arguments of its own (the call that was authorized is the call that runs)
 *   and may be called more than once (a transaction retried on a write conflict), each time with a
 *   fresh copy of the original arguments. `args` is a private copy for inspection — changing it
 *   changes nothing `invoke()` passes. `principal` is the principal resolved for THIS frame, or `null`
 *   on a serve without one; `context` is the requested context the `context` check accepted for this
 *   call (a private copy), or `null` when the frame carried none. Whatever `around` returns is the call's result (the data-only return
 *   check applies to it, exactly as to a leaf's own value); whatever it throws is the call's error.
 *   Identity is not established here — that is `principal`'s job; `around` decorates a call already
 *   authorized. With `around` set, the call's arguments must be structured-cloneable (they already
 *   must be to cross any real transport).
 * @returns {Promise<{ leaves: string[], excluded: string[], principal: object|Function|null, event: { on: Function, once: Function }, close: () => void }>}
 *   The live serving handle. `leaves` is what the far side is offered; `excluded` is every CALLABLE leaf that was
 *   dropped on the way there — refused by {@link isSafePath} or filtered out by `paths` — so a leaf
 *   that quietly failed to appear is visible rather than a mystery. (Namespace and data records are
 *   not "dropped": they were never candidates for a callable surface.) `principal` is the frozen,
 *   normalized `{ path, context? }` this serve bound (the resolver itself for the function form), or
 *   `null` when none was given.
 * @throws {TypeError} When `api` is not a slothlet instance or `channel` is not a Channel, when
 *   `around` or `context` is given and is not a function, when `context` is given and the instance's
 *   `context.scope` does not work — or, with a `principal`, when it is malformed or the
 *   instance cannot enforce it (see `options.principal`).
 *
 * @example
 * const serving = await serve(api, channel, { paths: ["exts"] });
 * serving.leaves; // ["exts.pdfViewer.open", …]
 * serving.excluded; // ["math.add", …] — real leaves this serve chose not to publish
 * serving.close(); // stop answering (the channel itself is NOT torn down — see close())
 *
 * @example
 * // An authenticated socket: the transport authenticated the peer; serve() binds that identity.
 * const serving = await serve(api, createChannel(socket), {
 *   paths: ["host", "project"],
 *   principal: { path: "remote.renderer", context: { actor: { id: user.id, roles: user.roles } } }
 * });
 */
export function serve(api: object, channel: import("./index.mjs").Channel, options?: {
    paths?: string[] | undefined;
    modules?: string[] | undefined;
    budgetMs?: number | undefined;
    principal?: string | {
        path: string;
        context?: object;
    } | (() => string | {
        path: string;
        context?: object;
    }) | undefined;
    context?: ((requested: object, call: {
        principal: Readonly<{
            path: string;
            context?: object;
        }> | null;
        path: string;
        args: unknown[];
    }) => object | false | null | undefined | Promise<object | false | null | undefined>) | undefined;
    around?: ((call: {
        callId: string;
        path: string;
        args: unknown[];
        principal: Readonly<{
            path: string;
            context?: object;
        }> | null;
        context: object | null;
        invoke: () => Promise<unknown>;
    }) => unknown) | undefined;
}): Promise<{
    leaves: string[];
    excluded: string[];
    principal: object | Function | null;
    event: {
        on: Function;
        once: Function;
    };
    close: () => void;
}>;
