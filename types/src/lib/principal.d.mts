/**
 * @typedef {object} Principal
 * @property {string} path - Dotted caller identity (e.g. `remote.renderer`); validated with {@link isSafePath}.
 * @property {object} [context] - Plain data merged into the per-call context scope (write-protected there).
 */
/**
 * @typedef {object} BoundPrincipal
 * @property {() => Readonly<Principal>|null} resolve - The principal for THIS frame, or `null` when the
 *   host's resolver threw or answered something that is not a principal (the frame is then denied).
 *   Never throws.
 * @property {Readonly<Principal>|Function} declared - What is exposed for diagnostics: the frozen,
 *   normalized principal for the string / object forms, or the host's own resolver function for the
 *   function form (its answer is per frame, so there is no single normalized value to show).
 */
/**
 * Normalize one principal VALUE (a string or a `{ path, context? }` object) into a frozen
 * {@link Principal}. Used at setup for the static forms and per frame for a resolver's answer.
 * @param {unknown} value - `"remote.renderer"` or `{ path: "remote.renderer", context: { actor } }`.
 * @param {string} who - `serve` / `grow`, for the error message.
 * @returns {Readonly<Principal>} The normalized principal.
 * @throws {TypeError} When `path` is not an {@link isSafePath} string or `context` is not a plain object.
 */
export function normalizePrincipal(value: unknown, who: string): Readonly<Principal>;
/**
 * Bind the `principal` option — `string | Principal | () => (string | Principal)` — for one end.
 *
 * The function form is called synchronously PER FRAME (so a host can rotate identity on re-auth
 * without re-serving) and must answer a string or object as above; a throw or any other answer
 * denies that one frame. It is deliberately not async: transport auth happens at the handshake, and
 * per-call async work is not identity establishment.
 * @param {unknown} option - The raw `principal` option (`undefined` / `null` → no principal).
 * @param {string} who - `serve` / `grow`, for error messages.
 * @returns {BoundPrincipal|null} The bound principal, or `null` when none was given.
 * @throws {TypeError} For an invalid static (string / object) principal.
 */
export function bindPrincipal(option: unknown, who: string): BoundPrincipal | null;
/**
 * The fail-closed preconditions for binding a principal, checked ONCE at `serve()` / `grow()` — a
 * configuration error is thrown before any frame is answered, never degraded into a silent pass.
 *
 * - The instance's permission system must be enforcing. Verified on @cldmv/slothlet 3.20.0:
 *   `api.slothlet.permissions` exists as an object whether or not a `permissions` block was
 *   configured, and `permissions.control.enabled` is a boolean accessor that reads `false` with no
 *   block, `true` with any block (a rules-only or an events-only one alike), and tracks
 *   `control.disable()` / `control.enable()` live. There is no public `isEnabled()`; `control.enabled`
 *   is the documented accessor (slothlet `docs/PERMISSIONS.md` § `control.*`). A principal on an
 *   unenforced instance would gate nothing (`#resolveAccess` allows everything when disabled, and
 *   `resolveEventLevel` allows without a manager) — a silent lie, so it is refused. A LATER
 *   `control.disable()` by the host reopens the gate for principals exactly as it does for local
 *   modules; that is the host's own act and is documented, not detected per frame.
 * - `api.slothlet.event.resolveLevel` must exist (slothlet ≥ 3.18.0): the event half resolves the
 *   principal's level through it, and without it every far `sub` would be refused anyway.
 * - `calls` only (serve): `api.slothlet.permissions.global.checkCall` must exist — added in
 *   @cldmv/slothlet 3.22.0 (CLDMV/slothlet#508). Throwing rather than degrading, because degrading a security
 *   gate silently is the hole #33 describes.
 * - `scope` only (serve): `api.slothlet.context.scope` must WORK. On 3.20.0 an instance created with
 *   `scope: false` still exposes `context.scope` as a function — it rejects with `SCOPE_DISABLED` when
 *   called — so a `typeof` check would pass and the first frame would then be denied. The precondition
 *   therefore probes an empty scope (`scope({ context: {}, fn: () => true })`) and requires it to
 *   resolve `true`. Every call with a principal runs inside such a scope, so a serve that cannot
 *   establish one cannot run anything "under" the principal.
 * - `run` only (grow, and only when the static principal carries a `context`): `api.slothlet.context.run`
 *   must work, probed the same way — the event half re-resolves inside `run(principal.context)`.
 * @param {import("../index.mjs").SlothletApi} api - The slothlet instance.
 * @param {{ calls?: boolean, scope?: boolean, run?: boolean }} needs - Which preconditions apply to this end.
 * @param {string} who - `serve` / `grow`, for error messages.
 * @returns {Promise<void>} Resolves when every applicable precondition holds.
 * @throws {TypeError} Naming the first precondition that fails.
 */
export function assertPrincipalSupport(api: import("../index.mjs").SlothletApi, needs: {
    calls?: boolean;
    scope?: boolean;
    run?: boolean;
}, who: string): Promise<void>;
/**
 * Require a WORKING `api.slothlet.context.scope()` — probed with an empty scope, because a
 * `scope: false` instance still exposes `scope` as a function that rejects `SCOPE_DISABLED`. Used for
 * a principal (every call runs inside its scope) and for a `context` check on `serve()` (#79: every
 * call carrying an accepted requested context runs inside a scope holding it).
 * @param {import("../index.mjs").SlothletApi} api - The slothlet instance.
 * @param {string} who - `serve` / `grow`, for the error message.
 * @param {string} feature - What needs the scope (`a principal`, `a context check`), for the message.
 * @returns {Promise<void>} Resolves when the probe answered `true`.
 * @throws {TypeError} When the probe failed.
 */
export function assertScopeSupport(api: import("../index.mjs").SlothletApi, who: string, feature: string): Promise<void>;
/**
 * Ask slothlet whether `principal` may call `path` with `args`, through the ONE seam the vine uses
 * for its call gate. Fail-closed on every path: a missing API, a throw, a rejection, or a verdict that
 * is not literally `true` all answer `false`. Called INSIDE the principal's context scope so
 * conditional rules and `requires`-principals see the bound context.
 * @param {import("../index.mjs").SlothletApi} api - The slothlet instance.
 * @param {Readonly<Principal>} principal - The resolved principal for this frame.
 * @param {string} path - The served leaf path (already validated against the surface).
 * @param {unknown[]} args - The call's arguments, forwarded as `callMeta.args` for rule conditions.
 * @returns {Promise<boolean>} `true` ONLY when slothlet answered `true`.
 */
export function gate(api: import("../index.mjs").SlothletApi, principal: Readonly<Principal>, path: string, args: unknown[]): Promise<boolean>;
/**
 * The narrower of two delivery levels (`deny` < `notify` < `allow`). Anything that is not a known
 * level ranks as `deny`, so a resolver that answers junk can only ever narrow.
 * @param {unknown} a - One level.
 * @param {unknown} b - The other.
 * @returns {"deny"|"notify"|"allow"} The narrower of the two.
 */
export function narrowest(a: unknown, b: unknown): "deny" | "notify" | "allow";
/**
 * Does a far-supplied `subscriberPath` sit at or under the principal's own path? Only such a hint is
 * honoured — and then only to NARROW the channel's level. A claim anywhere else (a sibling, an
 * unrelated tree, a forged `remote.admin` on a `remote.renderer` channel) is ignored and the channel's
 * own level is used, so a forged claim can cost the far side deliveries but never gain it any.
 * @param {string|null} subscriberPath - The `sub` frame's asserted identity.
 * @param {string} principalPath - The channel principal's path.
 * @returns {boolean} True when the hint is at/under the principal.
 */
export function isNarrowingHint(subscriberPath: string | null, principalPath: string): boolean;
export type Principal = {
    /**
     * - Dotted caller identity (e.g. `remote.renderer`); validated with {@link isSafePath}.
     */
    path: string;
    /**
     * - Plain data merged into the per-call context scope (write-protected there).
     */
    context?: object | undefined;
};
export type BoundPrincipal = {
    /**
     * - The principal for THIS frame, or `null` when the
     * host's resolver threw or answered something that is not a principal (the frame is then denied).
     * Never throws.
     */
    resolve: () => Readonly<Principal> | null;
    /**
     * - What is exposed for diagnostics: the frozen,
     * normalized principal for the string / object forms, or the host's own resolver function for the
     * function form (its answer is per frame, so there is no single normalized value to show).
     */
    declared: Readonly<Principal> | Function;
};
