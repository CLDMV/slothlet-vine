# Configuration Reference

Complete reference for `vine.grow()` and `vine.serve()`'s options. Both take `(api, channel, options)` — the local slothlet instance, the transport seam, and an options object.

---

## Quick Reference

```javascript
import { grow, serve } from "@cldmv/slothlet-vine";

// The side that PUBLISHES its own leaves to the far side of the channel.
const serving = await serve(api, channel, {
	paths: ["exts"], // dotted prefixes to serve; omit for every callable leaf of the base load
	modules: ["ext-1"], // extra moduleIDs to union in (runtime add() mounts leaves() alone can't see)
	budgetMs: 30_000, // accepted, IGNORED in v1 — documented for symmetry with grow()
	principal: { path: "remote.renderer", context: { actor } }, // OPTIONAL — the channel principal for an untrusted peer
	context: (requested, { principal, path, args }) => requested, // OPTIONAL — accept / narrow / refuse a per-call requested context
	around: ({ callId, path, args, principal, context, invoke }) => invoke() // OPTIONAL — the host's own scope around each accepted call
});
// serving: { leaves: string[], excluded: string[], principal: object|Function|null, close(): void }

// The side that MOUNTS the far side's leaves into its own tree, at identical dotted paths.
const link = await grow(api, channel, {
	budgetMs: 30_000, // per-call settle budget; exceeded → VINE_BUDGET
	handshakeMs: 30_000, // deadline for the surface frame itself; defaults to budgetMs
	paths: ["exts"], // dotted prefixes to mount (grow-side mirror of serve's own paths filter)
	principal: "remote.plugin", // OPTIONAL — the channel principal for this end's EVENT server-half only
	context: () => ({ project: pinned }) // OPTIONAL — the default per-call requested context (object, or a per-call function)
});
// link: { id, leaves: string[], skipped: string[], collisions: string[], context: boolean, with(context, fn, ...args), close(): Promise<void>, closed: Promise<{reason}> }
await link.with({ project: "p1" }, () => api.project.files.list()); // every call in the extent carries { project: "p1" }
```

---

## `serve()` Options

### `paths`

**Type**: `string[]`
**Default**: every callable leaf of the base load

Dotted prefixes to serve. A leaf is served when it equals a prefix or sits under it (`"exts"` serves `exts.pdfViewer.open`, not `extras.foo`). An array that yields no usable prefix (`[]`, `["", 7]`) serves **nothing** — a filter that can't be satisfied is not the same as "no filter," and fail-closed is the safe reading for a surface. A non-array value is ignored (falls back to the default).

```javascript
await serve(api, channel, { paths: ["exts", "shared.utils"] });
```

Leaves this filter (or the safety guard) declines to publish are still visible — see `serving.excluded` in the [return values](#return-values) below.

### `modules`

**Type**: `string[]`

Additional moduleIDs (or mount endpoints) whose leaves are unioned into the surface. `api.slothlet.api.leaves(".")` — what `serve()` reads by default — covers the base load only; a runtime `api.slothlet.api.add()` mount is module-scoped and there is no registry of every mounted id to iterate automatically. Name the ones you want served here. Unknown ids are skipped rather than fatal, so a stale entry doesn't take down the whole surface.

```javascript
await api.slothlet.api.add(["drivers", "opensearch"], "./dist/api", { moduleID: "driver-opensearch" });
await serve(api, channel, { modules: ["driver-opensearch"] });
```

### `budgetMs`

**Type**: `number`

Accepted and **ignored** in v1 — the budget is a grow-side concern (see `grow()`'s own `budgetMs` below). Documented on `serve()` purely for symmetry with the design sketch; passing it does nothing.

### `principal`

**Type**: `string | { path: string, context?: object } | () => (string | { path, context? })`
**Default**: none — the trusted-transport behaviour

The **channel principal**: the caller identity this serve binds to the channel, taken from the transport's own authentication (a ws upgrade, a token) and never from a frame. With one set, every `call` frame is judged by slothlet's rules engine as `principal.path` calling the leaf with the frame's `args`, inside a context scope carrying `principal.context` with every top-level key write-protected, and a denial is answered [`VINE_DENIED`](ERRORS.md#vine_-codes) without the leaf ever running; every `sub` frame is resolved as the principal, and the far side's own `subscriberPath` can only narrow that level (`null` no longer means "host"). Without it, nothing changes.

- A **string** is `{ path }` — the common worker/Electron case: `principal: "remote.renderer"`.
- An **object** is `{ path, context? }`. `path` must pass the same path guard as a leaf (no `**`, no empty segment, not under `slothlet`); `context`, when given, must be a plain object (it is deep-cloned per scope, and only plain data gets full-depth write protection).
- A **function** is called synchronously per frame and must answer either form — so a host can rotate identity on re-auth without re-serving. A throw or any other answer denies that one frame (`VINE_DENIED` for a call, a `deny` ack for a subscription). It is deliberately not async: transport auth happens at the handshake.

`serve()` throws a `TypeError` — before publishing anything — when `around` is given and is not a function, when the principal is malformed, when the instance's permission system is not enforcing (`api.slothlet.permissions.control.enabled !== true`), when `api.slothlet.event.resolveLevel` is missing, when `api.slothlet.permissions.global.checkCall` is missing (**the call half requires `@cldmv/slothlet` ≥ 3.22.0, the peer floor**), or when `api.slothlet.context.scope` does not work (a `scope: false` instance). A principal on an instance that cannot enforce it would gate nothing, so it is refused rather than degraded. A principal-bearing serve must run on the async (Node) runtime, not `runtime: "live"`.

```javascript
wss.on("connection", async (socket, request) => {
	const user = await authenticate(request); // nothing the page can forge
	await serve(api, createChannel(socket), {
		paths: ["host", "project"],
		principal: { path: user.admin ? "remote.admin" : "remote.renderer", context: { actor: { id: user.id, roles: user.roles } } }
	});
});
```

The full model — what a principal is and is not, the rule shapes, and the worked call and subscription tables — is in [PERMISSIONS.md → Serving to an untrusted peer](PERMISSIONS.md#serving-to-an-untrusted-peer-the-channel-principal).

### `context`

**Type:** `(requested: object, call: { principal, path, args }) => object | false | null | undefined` (or a Promise of one) **Default:** none — a requested context is **refused**

The host check for a per-call **requested context**: a data-only plain object the far side attaches to one `call` frame (grow-side [`link.with()`](#linkwithcontext-fn-args) or [`grow({ context })`](#context-1)), such as the project a browser window is working in. It is a request, never identity — identity is the [`principal`](#principal)'s, bound to the channel — and it lives on the call, so the server holds no per-connection state and nothing races when a client switches projects.

The check runs only for frames that carry one, **after** the principal is resolved and **before** the permission gate. It receives a private copy of the request and `{ principal, path, args }` (`principal` is `null` on a serve without one; `args` are the frame's arguments as a rule condition would see them), and may be async.

| The check answers                                                                           | Outcome                                                                                              |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| a plain, data-only object — the request itself                                              | **accept**: those keys go into the call's context scope                                              |
| a different plain object (a subset, a canonicalized value)                                  | **narrow**: only what it answered goes into the scope                                                |
| `false`, `null`, `undefined`, `true`, an array, a class instance, a function-bearing object | **refuse**: [`VINE_CONTEXT`](ERRORS.md#vine_-codes); the gate is never asked and the leaf never runs |
| a throw or a rejection                                                                      | **refuse**: `VINE_CONTEXT` — the host's own error stays serve-side; the message names the path only  |

The accepted keys are merged into the call's `context.scope` **under** the principal's — a principal key always wins, so a request can never override `actor` — and every key is write-protected (`CONTEXT_KEY_PROTECTED` on any write, nested fields included). `checkCall`, rule conditions, `requires`-principals, [`around`](#around) and the leaf all see it as plain `context.project`. On a serve without a principal, an accepted context still runs in such a scope; there is just no gate.

**No check configured, the default, refuses**: a frame that carries a requested context is answered `VINE_CONTEXT`, never run unscoped, so a client can never believe a call is scoped when it isn't. A serve with a check adds `context: true` to its `surface` frame; a grow refuses locally to send a requested context to a far side that did not advertise it (which also covers an older serve that would drop the key). A request that is not data — not a plain object, a function anywhere, a value structured clone refuses — is `VINE_DATA_ONLY`, checked before the host's check is called.

`serve()` throws a `TypeError` when `context` is not a function, or when the instance's `context.scope` does not work (a `scope: false` instance). The permission system is **not** required unless a `principal` is also set. Like a principal, a context-accepting serve must run on the async (Node) runtime: under `runtime: "live"` concurrent scopes on one instance interleave.

```javascript
await serve(api, createChannel(socket), {
	paths: ["project"],
	principal: { path: "remote.renderer", context: { actor: { id: user.id } } },
	// Accept the pinned project only when this user can access it; drop anything else the client sent.
	context: async (requested, { principal }) =>
		(await projects.canAccess(principal.context.actor.id, requested.project)) ? { project: requested.project } : false
});
```

Subscriptions carry no requested context in v1: a `sub` frame is resolved from the principal alone (see [PERMISSIONS.md](PERMISSIONS.md#per-call-requested-context)).

### `around`

**Type:** `({ callId, path, args, principal, context, invoke }) => unknown` **Default:** none

A per-call wrapper for the host's own scope around each call the vine has accepted: a transaction, a deadline, an audit record. It runs after every check the vine makes — the served-surface check (`VINE_NO_LEAF`), the principal gate (`VINE_DENIED`, inside the principal's context scope), and the args data-only check (`VINE_DATA_ONLY`) — so it never sees a frame the vine would have refused. Identity is not established here: that is [`principal`](#principal)'s job, and `around` decorates a call that is already authorized.

| Field       | Meaning                                                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callId`    | The call's correlation id, as the grow side sent it — for tracing and deadlines.                                                                                                                                                                                                                                       |
| `path`      | The served leaf path.                                                                                                                                                                                                                                                                                                  |
| `args`      | A private copy of the call's arguments, for inspection. Changing it changes nothing `invoke()` passes.                                                                                                                                                                                                                 |
| `principal` | The frozen `{ path, context? }` resolved for **this** frame (a function-form principal is resolved per frame), or `null` on a serve without a principal.                                                                                                                                                               |
| `context`   | A private copy of the requested context the [`context`](#context) check accepted for this call, or `null` when the frame carried none. `around` runs inside the scope that holds it.                                                                                                                                   |
| `invoke`    | `() => Promise<unknown>` — runs the gated leaf with the call's original arguments. It takes no arguments (the call that was authorized is the call that runs) and may be called more than once; each call gets a fresh copy of the arguments as they arrived, so a retry never sees what a failed attempt did to them. |

Whatever `around` returns is the call's result — the data-only return check applies to it exactly as to a leaf's own value, so a wrapper that returns a function is refused `VINE_DATA_ONLY`. Whatever it throws is the call's error, and reaches the grow side as a `VineRemoteError` carrying that error's own name, message and code. `around` may also answer without calling `invoke()` at all (a cached answer). With `around` set, a call's arguments must be structured-cloneable — they already must be to cross any real transport — and ones that are not answer `VINE_DATA_ONLY`.

```javascript
await serve(api, channel, {
	principal: { path: "remote.renderer", context: { actor } },
	around: async ({ callId, path, principal, invoke }) => {
		// Retry the leaf on a write conflict, as one atomic action under the bound actor.
		for (;;) {
			try {
				return await db.transaction(() => invoke());
			} catch (err) {
				if (!isWriteConflict(err)) throw err;
			}
		}
	}
});
```

`around` wraps calls only. Accepting a far subscription and forwarding an emit are not actions a host can make atomic or roll back, and per-subscriber policy is what conditional event rules and the principal's context are for.

---

## `grow()` Options

### `budgetMs`

**Type**: `number`
**Default**: `30_000`

Per-call settle budget, in milliseconds. Each forwarded call arms a timer; if no terminal frame (`result` or `error`) arrives before it fires, the call rejects with [`VINE_BUDGET`](ERRORS.md#vine_budget) and a later result for it is dropped (settle-once). A non-finite or non-positive value (`0`, `-1`, `NaN`, a string) falls back to the default rather than silently meaning "no deadline."

```javascript
const link = await grow(api, channel, { budgetMs: 5000 });
```

### `handshakeMs`

**Type**: `number`
**Default**: `budgetMs`

Deadline for the `surface` frame itself — how long `grow()` will `await` before giving up on ever hearing from the far side. This is an addition to the sketch in [`DESIGN.md`](DESIGN.md), which specifies no handshake deadline: without one, a far side that never publishes leaves would hang `await grow(...)` forever, contradicting the design's own "pending calls never hang" rule.

`Infinity` is the explicit opt-out and waits indefinitely — useful when you know the far side boots slowly (a real `Worker`, a forked child, a fresh `slothlet()` instance) and would rather wait than risk a false timeout. Anything else that is not a positive finite number reads the same as `budgetMs` does: it falls back to the default.

```javascript
// A real worker boot can take longer than a typical per-call budget.
const link = await grow(api, channel, { budgetMs: 5000, handshakeMs: 30_000 });
```

A handshake `VINE_BUDGET` against a far side that is known to be up usually means its `surface` frame arrived before the channel had a listener: a node `Worker` and a `ws` socket drop a message that arrives with no listener attached. Create the channel in the same tick as the worker/socket, before any `await` — see [Transports → Create the channel before you `await` anything](TRANSPORTS.md#create-the-channel-before-you-await-anything).

### `paths`

**Type**: `string[]`
**Default**: every leaf the far side published

Dotted prefixes to mount — the grow-side mirror of `serve()`'s own `paths`. This is defence in depth: the serving side already filters, but "the far side already checked" is not a security property a grow should rely on. Same fail-closed reading as `serve()`'s: an array with no usable prefix mounts nothing, and a non-array value is ignored.

```javascript
const link = await grow(api, channel, { paths: ["exts"] });
```

### `principal`

**Type**: `string | { path: string, context?: object } | () => (string | { path, context? })`
**Default**: none

The channel principal for **this end's event server-half only**. A grow answers no `call` frames (a stray one is ignored), but it does answer the far side's `sub` frames for this instance's events — and the trusted end of a channel is not always the serving end: a host that grows leaves out of an untrusted worker plugin still serves that plugin's subscriptions to host events. With a principal, every far `sub` is resolved as `principal.path` (inside `context.run(principal.context)` when a context is given), the far `subscriberPath` can only narrow that level, and `null` no longer means "host". Same shapes and the same fail-closed rules as `serve()`'s; only the event-side preconditions apply — the permission system must be enforcing and `api.slothlet.event.resolveLevel` must exist (plus a working `context.run` when a static principal carries a `context`). `permissions.global.checkCall` is **not** required here.

```javascript
const link = await grow(hostApi, workerChannel, { principal: "remote.plugin" });
```

### `context`

**Type**: `object | () => (object | null | undefined)`
**Default**: none

The link's **default** per-call requested context: attached to every call made over this link outside a [`link.with()`](#linkwithcontext-fn-args) extent. A static plain object is validated and copied once (mutating it later changes nothing). A function is called synchronously **per call** and answers the context for that call, or `null` / `undefined` for none — the way a window sends whatever project it currently has pinned while the server holds nothing:

```javascript
let pinned = null; // set by the UI
const link = await grow(viewApi, channel, { context: () => (pinned ? { project: pinned } : null) });
```

The same data-only rules as arguments apply: a static value that is not a plain data object throws at `grow()` (`TypeError` for a non-object, `VINE_DATA_ONLY` for one that is not data); a resolver whose answer is not data rejects that call `VINE_DATA_ONLY`, and one that throws rejects it with its own error — nothing is sent either way. A call carrying a requested context to a far side that does not accept one (`link.context === false`) is refused locally with `VINE_CONTEXT` and nothing is sent. What the far side does with it is its [`context`](#context) check's decision.

### `link.with(context, fn, ...args)`

Not an option — a method on the returned link. Runs `fn(...args)` so that **every call it makes over this link** — directly, through any module, across every `await` — carries `context` on its `call` frame, and resolves to `fn`'s value. The extent is carried on the grow instance's own context scope (so that instance must not be `scope: false`), under a key private to the link: calls over other links are untouched. The innermost extent wins outright (no merge with an outer one or with the default), and `with(null, fn)` runs `fn` with no requested context at all. `context` is validated (`VINE_DATA_ONLY`) and copied up front; a non-function `fn` is a `TypeError`.

```javascript
// Two windows, one link: each call carries its own project, concurrently.
await Promise.all([
	link.with({ project: "A" }, () => viewApi.project.files.list()),
	link.with({ project: "B" }, () => viewApi.project.files.list())
]);
```

---

## Return values

### `serving` (from `serve()`)

| Field       | Type                         | Meaning                                                                                                                                                                                                                    |
| ----------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leaves`    | `string[]`                   | The dotted paths actually offered to the far side.                                                                                                                                                                         |
| `excluded`  | `string[]`                   | Every callable leaf this serve declined to publish — refused by the path-safety guard or filtered out by `paths`. Namespace and data records are never candidates, so they aren't reported here.                           |
| `principal` | `object \| Function \| null` | The channel principal this serve bound: the frozen, normalized `{ path, context? }` for the string / object forms, the resolver itself for the function form, or `null` when none was given. Diagnostics, like `excluded`. |
| `close()`   | `() => void`                 | Stop answering `call` frames. Does **not** close the channel — a channel may outlive one serving, and one a consumer handed in is not this call's to tear down.                                                            |

### `link` (from `grow()`)

| Field        | Type                                | Meaning                                                                                                                                           |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `string`                            | The link's internal moduleID (`vine-<nonce>`), for diagnostics.                                                                                   |
| `leaves`     | `string[]`                          | Paths actually mounted and forwarding.                                                                                                            |
| `skipped`    | `string[]`                          | Far leaves refused locally: an unsafe path, outside `paths`, rejected by `add()`, or published after the link had already ended.                  |
| `collisions` | `string[]`                          | Paths the local instance already occupied. **Not mounted** — the incumbent keeps answering there, and this leaf is unreachable through this link. |
| `context`    | `boolean`                           | Whether the far side accepts a per-call requested context (its `surface` advertised it). When `false`, a call carrying one is refused locally.    |
| `with()`     | `(context, fn, ...args) => Promise` | Run `fn` with a per-call requested context on every call it makes over this link — see [`link.with()`](#linkwithcontext-fn-args).                 |
| `close()`    | `() => Promise<void>`               | Unmount every stub this link owns and settle every in-flight call `VINE_CLOSED`. Idempotent.                                                      |
| `closed`     | `Promise<{ reason, info? }>`        | Resolves once the link ends, whichever way — `reason` is `"closed"` (you called `close()`) or `"gone"` (the far side died).                       |

`leaves`, `skipped`, and `collisions` are **disjoint** and together account for every leaf the far side published.

---

## See also

- [DESIGN.md](DESIGN.md) — the normative Channel contract, frame protocol, and error taxonomy.
- [TRANSPORTS.md](TRANSPORTS.md) — the five built-in transports and how to pick one.
- [ERRORS.md](ERRORS.md) — the `VINE_*` code list and how to branch on link state.
- [PERMISSIONS.md](PERMISSIONS.md) — how slothlet's own permission system gates a mounted stub.
