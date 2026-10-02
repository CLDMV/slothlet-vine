/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/principal.mjs
 *	@Date: 2026-09-28T12:47:12-07:00 (1790624832)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:12-07:00 (1790968812)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { isSafePath } from "./frame.mjs";

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
 * @property {Readonly<Principal>|(() => unknown)} declared - What is exposed for diagnostics: the frozen,
 *   normalized principal for the string / object forms, or the host's own resolver function for the
 *   function form (its answer is per frame, so there is no single normalized value to show).
 */

/**
 * Is `value` a plain data object — `{}` / `Object.create(null)` — as opposed to an array, a class
 * instance, or a primitive? Only plain data gets full-depth `protect` from slothlet's context scope,
 * and a principal's context is deep-cloned per scope, so anything else is refused up front.
 * @param {unknown} value - Candidate.
 * @returns {boolean} True for a plain object.
 */
function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Normalize one principal VALUE (a string or a `{ path, context? }` object) into a frozen
 * {@link Principal}. Used at setup for the static forms and per frame for a resolver's answer.
 * @param {unknown} value - `"remote.renderer"` or `{ path: "remote.renderer", context: { actor } }`.
 * @param {string} who - `serve` / `grow`, for the error message.
 * @returns {Readonly<Principal>} The normalized principal.
 * @throws {TypeError} When `path` is not an {@link isSafePath} string or `context` is not a plain object.
 */
export function normalizePrincipal(value, who) {
	const candidate = typeof value === "string" ? { path: value } : value;
	if (!isPlainObject(candidate)) {
		throw new TypeError(`@cldmv/slothlet-vine: ${who}() principal must be a dotted path string or a { path, context? } object`);
	}
	const { path, context } = candidate;
	// A principal is never mounted, so this is hygiene rather than prototype defence — but it keeps
	// `**`, empty segments, and the reserved `slothlet` root out of a caller identity all the same.
	if (!isSafePath(path)) {
		throw new TypeError(`@cldmv/slothlet-vine: ${who}() principal.path must be a safe dotted path (got ${JSON.stringify(path)})`);
	}
	if (context !== undefined && !isPlainObject(context)) {
		throw new TypeError(`@cldmv/slothlet-vine: ${who}() principal.context must be a plain object when given`);
	}
	return Object.freeze(context === undefined ? { path } : { path, context });
}

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
export function bindPrincipal(option, who) {
	if (option === undefined || option === null) return null;
	if (typeof option === "function") {
		return {
			resolve() {
				try {
					return normalizePrincipal(option(), who);
				} catch {
					return null;
				}
			},
			declared: option
		};
	}
	const fixed = normalizePrincipal(option, who);
	return { resolve: () => fixed, declared: fixed };
}

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
 * - `calls` only (serve): `api.slothlet.permissions.global.checkCall` must exist — the slothlet
 *   release carrying CLDMV/slothlet#508. Throwing rather than degrading, because degrading a security
 *   gate silently is the hole #33 describes.
 * - `scope` only (serve): `api.slothlet.context.scope` must WORK. On 3.20.0 an instance created with
 *   `scope: false` still exposes `context.scope` as a function — it rejects with `SCOPE_DISABLED` when
 *   called — so a `typeof` check would pass and the first frame would then be denied. The precondition
 *   therefore probes an empty scope (`scope({ context: {}, fn: () => true })`) and requires it to
 *   resolve `true`. Every call with a principal runs inside such a scope, so a serve that cannot
 *   establish one cannot run anything "under" the principal.
 * - `run` only (grow, and only when the static principal carries a `context`): `api.slothlet.context.run`
 *   must work, probed the same way — the event half re-resolves inside `run(principal.context)`.
 * @param {object} api - The slothlet instance.
 * @param {{ calls?: boolean, scope?: boolean, run?: boolean }} needs - Which preconditions apply to this end.
 * @param {string} who - `serve` / `grow`, for error messages.
 * @returns {Promise<void>} Resolves when every applicable precondition holds.
 * @throws {TypeError} Naming the first precondition that fails.
 */
export async function assertPrincipalSupport(api, needs, who) {
	const control = api.slothlet?.permissions?.control;
	if (control?.enabled !== true) {
		throw new TypeError(
			`@cldmv/slothlet-vine: ${who}() with a principal needs the instance's permission system enabled — ` +
				`api.slothlet.permissions.control.enabled is not true (configure a 'permissions' block; a principal on an unenforced instance would gate nothing)`
		);
	}
	if (typeof api.slothlet?.event?.resolveLevel !== "function") {
		throw new TypeError(
			`@cldmv/slothlet-vine: ${who}() with a principal needs api.slothlet.event.resolveLevel() — slothlet ≥ 3.18.0 is required`
		);
	}
	if (needs.calls && typeof api.slothlet?.permissions?.global?.checkCall !== "function") {
		throw new TypeError(
			`@cldmv/slothlet-vine: ${who}() with a principal needs api.slothlet.permissions.global.checkCall() — ` +
				`the slothlet release carrying CLDMV/slothlet#508 is required to gate calls for a channel principal`
		);
	}
	if (needs.scope) await probe(api, who, "scope", () => api.slothlet.context.scope({ context: {}, fn: () => true }));
	if (needs.run) await probe(api, who, "run", () => api.slothlet.context.run({}, () => true));
}

/**
 * Run one context probe and turn any failure — a missing function, a `SCOPE_DISABLED` rejection, a
 * wrong answer — into the setup `TypeError`.
 * @param {object} api - The slothlet instance.
 * @param {string} who - `serve` / `grow`.
 * @param {"scope"|"run"} name - Which `api.slothlet.context.*` function is being probed.
 * @param {() => unknown} attempt - The probe call.
 * @returns {Promise<void>} Resolves when the probe answered `true`.
 * @throws {TypeError} When the probe threw, rejected, or answered anything but `true`.
 */
async function probe(api, who, name, attempt) {
	let reason;
	try {
		if (typeof api.slothlet?.context?.[name] === "function" && (await attempt()) === true) return;
		reason = "it is unavailable";
	} catch (err) {
		reason = err?.message ?? String(err);
	}
	throw new TypeError(
		`@cldmv/slothlet-vine: ${who}() with a principal needs a working api.slothlet.context.${name}() to run under the principal's context — ${reason}`
	);
}

/**
 * Ask slothlet whether `principal` may call `path` with `args`, through the ONE seam the vine uses
 * for its call gate. Fail-closed on every path: a missing API, a throw, a rejection, or a verdict that
 * is not literally `true` all answer `false`. Called INSIDE the principal's context scope so
 * conditional rules and `requires`-principals see the bound context.
 * @param {object} api - The slothlet instance.
 * @param {Readonly<Principal>} principal - The resolved principal for this frame.
 * @param {string} path - The served leaf path (already validated against the surface).
 * @param {unknown[]} args - The call's arguments, forwarded as `callMeta.args` for rule conditions.
 * @returns {Promise<boolean>} `true` ONLY when slothlet answered `true`.
 */
export async function gate(api, principal, path, args) {
	try {
		const global = api.slothlet?.permissions?.global;
		if (typeof global?.checkCall !== "function") return false;
		const verdict = await global.checkCall(principal.path, path, args);
		return verdict === true;
	} catch {
		return false;
	}
}

/**
 * The delivery levels in narrowing order, for {@link narrowest}. @type {Record<string, number>}
 */
const LEVEL_RANK = { deny: 0, notify: 1, allow: 2 };

/**
 * The narrower of two delivery levels (`deny` < `notify` < `allow`). Anything that is not a known
 * level ranks as `deny`, so a resolver that answers junk can only ever narrow.
 * @param {unknown} a - One level.
 * @param {unknown} b - The other.
 * @returns {"deny"|"notify"|"allow"} The narrower of the two.
 */
export function narrowest(a, b) {
	const ra = LEVEL_RANK[a] ?? 0;
	const rb = LEVEL_RANK[b] ?? 0;
	const rank = Math.min(ra, rb);
	return rank === 2 ? "allow" : rank === 1 ? "notify" : "deny";
}

/**
 * Does a far-supplied `subscriberPath` sit at or under the principal's own path? Only such a hint is
 * honoured — and then only to NARROW the channel's level. A claim anywhere else (a sibling, an
 * unrelated tree, a forged `remote.admin` on a `remote.renderer` channel) is ignored and the channel's
 * own level is used, so a forged claim can cost the far side deliveries but never gain it any.
 * @param {string|null} subscriberPath - The `sub` frame's asserted identity.
 * @param {string} principalPath - The channel principal's path.
 * @returns {boolean} True when the hint is at/under the principal.
 */
export function isNarrowingHint(subscriberPath, principalPath) {
	return typeof subscriberPath === "string" && (subscriberPath === principalPath || subscriberPath.startsWith(`${principalPath}.`));
}
