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
	budgetMs: 30_000 // accepted, IGNORED in v1 — documented for symmetry with grow()
});
// serving: { leaves: string[], excluded: string[], close(): void }

// The side that MOUNTS the far side's leaves into its own tree, at identical dotted paths.
const link = await grow(api, channel, {
	budgetMs: 30_000, // per-call settle budget; exceeded → VINE_BUDGET
	handshakeMs: 30_000, // deadline for the surface frame itself; defaults to budgetMs
	paths: ["exts"] // dotted prefixes to mount (grow-side mirror of serve's own paths filter)
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

### `paths`

**Type**: `string[]`
**Default**: every leaf the far side published

Dotted prefixes to mount — the grow-side mirror of `serve()`'s own `paths`. This is defence in depth: the serving side already filters, but "the far side already checked" is not a security property a grow should rely on. Same fail-closed reading as `serve()`'s: an array with no usable prefix mounts nothing, and a non-array value is ignored.

```javascript
const link = await grow(api, channel, { paths: ["exts"] });
```

---

## Return values

### `serving` (from `serve()`)

| Field      | Type         | Meaning                                                                                                                                                                                          |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `leaves`   | `string[]`   | The dotted paths actually offered to the far side.                                                                                                                                               |
| `excluded` | `string[]`   | Every callable leaf this serve declined to publish — refused by the path-safety guard or filtered out by `paths`. Namespace and data records are never candidates, so they aren't reported here. |
| `close()`  | `() => void` | Stop answering `call` frames. Does **not** close the channel — a channel may outlive one serving, and one a consumer handed in is not this call's to tear down.                                  |

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
