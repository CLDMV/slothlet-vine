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
	principal: { path: "remote.renderer", context: { actor } } // OPTIONAL — the channel principal for an untrusted peer
});
// serving: { leaves: string[], excluded: string[], principal: object|Function|null, close(): void }

// The side that MOUNTS the far side's leaves into its own tree, at identical dotted paths.
const link = await grow(api, channel, {
	budgetMs: 30_000, // per-call settle budget; exceeded → VINE_BUDGET
	handshakeMs: 30_000, // deadline for the surface frame itself; defaults to budgetMs
	paths: ["exts"], // dotted prefixes to mount (grow-side mirror of serve's own paths filter)
	principal: "remote.plugin" // OPTIONAL — the channel principal for this end's EVENT server-half only
});
// link: { id, leaves: string[], skipped: string[], collisions: string[], close(): Promise<void>, closed: Promise<{reason}> }
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

`serve()` throws a `TypeError` — before publishing anything — when the principal is malformed, when the instance's permission system is not enforcing (`api.slothlet.permissions.control.enabled !== true`), when `api.slothlet.event.resolveLevel` is missing, when `api.slothlet.permissions.global.checkCall` is missing (**the call half requires the slothlet release carrying [CLDMV/slothlet#508](https://github.com/CLDMV/slothlet/issues/508)**), or when `api.slothlet.context.scope` does not work (a `scope: false` instance). A principal on an instance that cannot enforce it would gate nothing, so it is refused rather than degraded. A principal-bearing serve must run on the async (Node) runtime, not `runtime: "live"`.

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

| Field        | Type                         | Meaning                                                                                                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `string`                     | The link's internal moduleID (`vine-<nonce>`), for diagnostics.                                                                                   |
| `leaves`     | `string[]`                   | Paths actually mounted and forwarding.                                                                                                            |
| `skipped`    | `string[]`                   | Far leaves refused locally: an unsafe path, outside `paths`, rejected by `add()`, or published after the link had already ended.                  |
| `collisions` | `string[]`                   | Paths the local instance already occupied. **Not mounted** — the incumbent keeps answering there, and this leaf is unreachable through this link. |
| `close()`    | `() => Promise<void>`        | Unmount every stub this link owns and settle every in-flight call `VINE_CLOSED`. Idempotent.                                                      |
| `closed`     | `Promise<{ reason, info? }>` | Resolves once the link ends, whichever way — `reason` is `"closed"` (you called `close()`) or `"gone"` (the far side died).                       |

`leaves`, `skipped`, and `collisions` are **disjoint** and together account for every leaf the far side published.

---

## See also

- [DESIGN.md](DESIGN.md) — the normative Channel contract, frame protocol, and error taxonomy.
- [TRANSPORTS.md](TRANSPORTS.md) — the five built-in transports and how to pick one.
- [ERRORS.md](ERRORS.md) — the `VINE_*` code list and how to branch on link state.
- [PERMISSIONS.md](PERMISSIONS.md) — how slothlet's own permission system gates a mounted stub.
