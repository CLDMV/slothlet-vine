# slothlet-vine — design & protocol (v1)

The implementation contract for `@cldmv/slothlet-vine`. Everything here is normative: the core, every built-in transport, and any consumer-written transport implement THIS. The mechanism is a browser-ready transposition of a production-proven node-side design (per-leaf forwarding stubs mounted at identical paths, permission-gated by slothlet itself, async correlation over an injected channel).

Looking for a guide rather than the normative spec? See [CONFIGURATION.md](CONFIGURATION.md), [TRANSPORTS.md](TRANSPORTS.md), [CUSTOM-TRANSPORTS.md](CUSTOM-TRANSPORTS.md), [ERRORS.md](ERRORS.md), [PERMISSIONS.md](PERMISSIONS.md), and [BROWSER.md](BROWSER.md).

## Vocabulary

- **vine** — the forwarding layer as a whole (`vine.grow` / `vine.serve`).
- **link** — one live connection between two slothlet instances over one channel.
- **channel** — the transport seam: the ONLY thing the core knows about a transport.
- **stub / forwarding leaf** — a synthetic leaf mounted in the grow-side tree at the callee's identical dotted path; calling it forwards over the link.

## The Channel contract (transport seam)

```js
/**
 * @typedef {object} Channel
 * @property {(message: object) => void} send        — deliver one frame to the far side
 * @property {(handler: (message: object) => void) => void} onMessage — register the (single) receive handler
 * @property {() => void} [close]                    — tear the transport down
 * @property {(handler: (info?: object) => void) => void} [onClose] — register a (single) far-side-death/closure handler
 * @property {{ structuredClone?: boolean, codec?: "none"|"json", buffersUntilHandler?: boolean }} [capabilities]
 *   — `structuredClone`/`codec`: what the medium preserves and how it encodes. `buffersUntilHandler`:
 *   whether frames that arrive before `onMessage` is registered are buffered (`true`) or may be
 *   dropped (absent/`false`) — the conformance suite asserts whichever the transport declares.
 */
```

Rules:

- The **core never imports a transport**. Transports are self-contained modules that produce Channels; the core consumes only this interface. Adding a transport = adding one module; consumers may pass ANY object satisfying this contract.
- `send`/`onMessage` carry **plain frame objects**. A transport whose medium structured-clones (postMessage family) passes them through (`capabilities.structuredClone: true`, `codec: "none"`). A byte transport (websocket) owns its own encode/decode internally (`codec: "json"` in v1 — document that JSON degrades `Date`/`Map`/`Set`; a richer codec is a future capability).
- `onMessage`/`onClose` are single-handler registrations (last write wins). Handlers must never throw into the transport; the core wraps its handlers.
- **`send()` has a three-way failure policy, uniform across every transport** (this is what the core's immediate-settle path relies on):
  - **The medium REFUSES this frame** — an un-serializable argument the data-only scan cannot see (a `DataCloneError` on the structured-clone family; a synchronous serializer throw from `child.send`; a `JSON.stringify` throw on a `BigInt` for the websocket codec). This is a **per-call** problem: `send()` **rethrows** (throws synchronously), and the core settles just that one call with `VINE_BAD_FRAME`. It does NOT fire `onClose` or kill the link — every other in-flight call is unaffected.
  - **The channel is DEAD** — `ERR_IPC_CHANNEL_CLOSED`/`EPIPE`/similar, a socket gone, a port closed. `send()` fires `onClose` (link death; the core force-settles all pending calls `VINE_GONE`) and does NOT rethrow.
  - **Close race** — a send after a local `close()`, or a frame crossing a peer close the medium silently drops. A silent no-op; the core tolerates it (the call settles on death or budget).
- Frames may arrive after `close()` was called locally; the core must tolerate (ignore) them.
- Every built-in transport module exports `createChannel(...)` (arguments transport-specific) and may export helpers (e.g. a pair factory). Where a transport spans processes, it also exports what the far side needs (e.g. a child-side `createChannel`).

## Frames (schema v1 — `schemas/frame.schema.json` is normative)

All frames are objects with a `type`. Unknown `type`s are ignored (forward compatibility).

| Frame   | Shape                                                                                                        | Direction                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| surface | `{ type: "surface", v: 1, leaves: string[] }`                                                                | serve → grow, once on link start (and again if the served surface changes — v1 sends once) |
| call    | `{ type: "call", callId: string, path: string, args: unknown[] }`                                            | grow → serve                                                                               |
| result  | `{ type: "result", callId: string, value?: unknown }`                                                        | serve → grow                                                                               |
| error   | `{ type: "error", callId: string, error: { name: string, message: string, code?: string, stack?: string } }` | serve → grow                                                                               |

- `callId`: unique per grow-side link (monotonic counter + link nonce; never `Math.random` collisions).
- `path`: the dotted leaf path exactly as served (e.g. `exts.pdfViewer.open`).
- Function-valued `args` are **rejected grow-side** before dispatch (`VINE_DATA_ONLY`) — the vine is data-only in v1. So are function-valued **return values**, rejected serve-side with the same code; see [Data-only, both directions](#data-only-both-directions).
- Errors cross as data and are re-thrown grow-side as `VineRemoteError` (name/message/code preserved, remote stack attached as `.remoteStack`).

## API surface (dot notation — single-word leaves)

```js
import * as vine from "@cldmv/slothlet-vine";

// serve: expose this instance's leaves to the far side of the channel
const serving = await vine.serve(api, channel, {
	paths: ["exts"], // dotted prefixes to serve; DEFAULT: all leaves EXCEPT "slothlet.**" (the control plane is NEVER served)
	modules: ["ext-1"], // extra moduleIDs to union in (runtime add() mounts)
	budgetMs: 30_000 // unused serve-side v1 (documented for symmetry)
});
// serving: { leaves: string[], excluded: string[], close(): void }

// grow: mount the far side's leaves into this instance
const link = await vine.grow(api, channel, {
	budgetMs: 30_000, // per-call settle budget; exceeded → VINE_BUDGET error
	handshakeMs: 30_000, // deadline for the surface frame; Infinity to wait forever
	paths: ["exts"] // dotted prefixes to mount (grow-side mirror of serve's)
});
// link: { id, leaves: string[], skipped: string[], collisions: string[], close(): Promise<void>, closed: Promise<{reason}> }
```

Semantics:

- **serve** answers `call` frames by resolving the dotted path against the live api and invoking it. It re-validates that the path is within the served surface (never trust the wire). Thrown/rejected errors become `error` frames. It sends `surface` immediately on start, derived from the instance's leaf records filtered by `paths` and the hard `slothlet.**` exclusion.
- **grow** awaits the `surface` frame (subject to `handshakeMs`), then mounts one async stub per leaf at the identical dotted path via slothlet's synthetic in-memory add (`api.slothlet.api.add(path, stubFn, { moduleID })`, one shared link moduleID) so **slothlet's own permission system gates stub calls exactly like real leaves**. `link.close()` removes the mounts (`api.slothlet.api.remove(moduleID)`) and settles all pending calls with `VINE_CLOSED`.
- A **channel is directional**: one serve end, one grow end. Bidirectional forwarding = two channels (transports that have paired endpoints expose pairs).
- **Death**: `channel.onClose` (or transport-detected far-side death) force-settles every pending call with `VINE_GONE` and resolves `link.closed`. Pending calls NEVER hang.
- **Budget**: each grow-side call arms a timer (`budgetMs`); expiry settles that call with `VINE_BUDGET` (the late result frame, if it arrives, is ignored — settle-once).
- **Settle-once** everywhere: a callId settles exactly once (result | error | budget | gone | closed); later frames for it are dropped.

Error codes (all `VineError` subclasses carrying `.code`): `VINE_GONE`, `VINE_BUDGET`, `VINE_CLOSED`, `VINE_DATA_ONLY`, `VINE_BAD_FRAME`, `VINE_NO_LEAF` (call for a path not in the served surface), `VINE_REMOTE`. Remote application errors re-throw as `VineRemoteError` (their own name/message/code) — except a `VINE_*` code, which is never adopted from the wire; see [Errors](#errors) below.

## Built-in transports (each: one self-contained module + e2e test)

See [TRANSPORTS.md](TRANSPORTS.md) for a usage guide, code examples, and the ownership/death-detection details that differ between the two-endpoint transports (`worker-threads`, `process`) — referenced from the conformance harness note below.

| Subpath                    | Boundary                                                         | Notes                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport/loopback`       | same process                                                     | `createPair()` → two linked Channels; `setImmediate`/`queueMicrotask` delivery (async like a real boundary). The reference implementation + test workhorse. |
| `transport/post-message`   | anything with the `postMessage`/`onmessage`/`close` port surface | wraps a browser `Worker`, `MessagePort`, or node `worker_threads` MessagePort (same surface). `capabilities.structuredClone: true`.                         |
| `transport/worker-threads` | node worker                                                      | parent: wrap a `Worker`; child: wrap `parentPort`.                                                                                                          |
| `transport/process`        | node child process                                               | parent: wrap a `ChildProcess` (fork, `serialization: "advanced"` recommended); child: wrap `process`.                                                       |
| `transport/websocket`      | network                                                          | wrap a `ws` WebSocket (client or server-accepted socket). `codec: "json"` v1. `ws` is an optional peer dependency — imported ONLY by this module.           |

## Conformance harness (`@cldmv/slothlet-vine/testing`)

`channelConformance(name, makePair, { test framework injection })` — a reusable suite ANY transport (built-in or consumer) runs against a factory producing a connected channel pair. Verifies: delivery, ordering, multi-frame bursts, large-ish payloads, `onMessage` registered-after-send behavior (frames sent before a handler is registered may be dropped OR buffered — the suite asserts the transport's declared behavior), `close()` idempotence, `onClose` firing on far-side close. Every built-in transport's test file runs this harness PLUS its e2e. See [CUSTOM-TRANSPORTS.md](CUSTOM-TRANSPORTS.md) for a walkthrough of writing a transport and running this suite against it.

## E2E test bar (every transport, no exceptions)

Each transport's test composes a REAL slothlet instance on the serve side (a small api: sync leaf, async leaf, throwing leaf) and a REAL slothlet instance on the grow side, links them over that transport's real boundary (real `Worker`, real forked child, real ws server on an ephemeral port), and asserts:

1. sync + async round-trips return correct values through `growApi.<path>()`;
2. a thrown remote error re-throws grow-side as `VineRemoteError` with the original message;
3. a slothlet **deny rule** on the grow side blocks the stub call (permission gating works on mounted stubs);
4. `VINE_BUDGET` fires on a deliberately-slow leaf with a small budget;
5. killing the far side (terminate worker / kill child / close socket) settles in-flight calls with `VINE_GONE`;
6. `link.close()` unmounts the stubs (path gone from the api) and later calls fail `VINE_CLOSED`.

Process/worker child entry files live under `tests/fixtures/`.

## v1 implementation notes & deviations

Where the shipped implementation differs from the sketch above, or settles something the sketch left open. These are normative for v1 — the sketch is the intent, this section is what the code does.

### Signatures

- **`serve()` is async.** The sketch calls it without `await`. It cannot be synchronous: the surface is read from the loader's records and `api.slothlet.api.leaves()` returns a Promise. `serve()` therefore returns `Promise<{ leaves, excluded, close }>`. `grow()` was always async.
- **`grow(api, channel, { handshakeMs })`** — a deadline for the `surface` frame itself, which the sketch does not specify. Without one, a far side that never publishes leaves hangs `await grow(...)` forever, contradicting the design's own "pending calls NEVER hang" rule. Defaults to `budgetMs`. `Infinity` is the explicit opt-out and waits indefinitely; anything else that is not a positive finite number (`null`, `0`, `-1`, `NaN`, a string) falls back to the default rather than silently meaning "no deadline" — the same reading `budgetMs` gets.
- **`grow(api, channel, { paths })`** — dotted prefixes, the grow-side mirror of `serve`'s. Defence in depth: the serving side filters too, but "the far side already checked" is not a security property. Both read an unsatisfiable array (`[]`, `["", 7]`) as fail-closed — nothing is served / mounted — and ignore a non-array value.
- **`serve(api, channel, { modules })`** — additional moduleIDs whose leaves are unioned into the surface. `leaves(".")` covers the base load only; runtime `api.slothlet.api.add()` mounts are module-scoped and there is no registry of mounted ids to iterate. Unknown ids are skipped, not fatal.

### Reporting surfaces

- **`serving.excluded`** — the callable leaves this serve declined to publish, whether refused by the path guard or filtered out by `paths`. A surface that is quietly shorter than expected is otherwise very hard to diagnose from the far side of a boundary. Namespace and data records are not reported: they were never candidates for a callable surface.
- **`link.skipped` / `link.collisions`** — with `link.leaves`, these three lists are **disjoint** and together account for every leaf the far side published. `leaves` are the paths actually mounted and forwarding. `skipped` are far leaves refused locally (unsafe path, outside `paths`, rejected by `add()`, or published after the link had already ended — mounting stops if the far side dies mid-manifest). `collisions` are paths the local instance already occupied: they are **not mounted at all**, the incumbent keeps answering there, and the far leaf is simply unreachable through this link. A vine never passes `forceOverwrite` — clobbering local reality with a remote's idea of the tree is not a trade worth making.
- **`link.close()` is ownership-scoped.** It removes the link's module, then verifies: any path that survived the module-scoped removal is removed again individually — but only if the loader's records still say the link OWNS it. A local module may legitimately have taken a vine path over (`forceOverwrite`, its own moduleID) while the link was up, and slothlet's own `remove(moduleID)` correctly leaves such a takeover in place; the vine must not undo that on the way out. Ownership is read before the module removal, because afterwards the id is unknown and `leaves(id)` throws.

### Errors

- **`VINE_REMOTE`** joins the code list: the `.code` of a re-thrown remote error that carried none of its own.
- **Reserved codes are never adopted from the wire.** A remote `code` matching `VINE_*` is remapped to `VINE_REMOTE`, and the far side's own spelling is preserved on `.remoteCode`. Otherwise a peer could send `{ name: "VineError", code: "VINE_CLOSED" }` and satisfy `err instanceof VineError && err.code === CODES.CLOSED` — the documented way to branch on link state — driving a consumer's teardown path from across the boundary. A vine link-state code describes _this_ link and can only be produced locally. The remap is blind to which reserved code arrived, including ones a far side's serve legitimately produced (`VINE_NO_LEAF`, `VINE_DATA_ONLY`): read `.remoteCode` for what the far side said, `.code` for the fact that it came from over there.

### Transport send-failure classification (the `VINE_BAD_FRAME` vs `VINE_GONE` line)

Every transport's `send()` honours the three-way policy in the Channel contract above. What "the medium refuses this frame" concretely is, per transport — the un-serializable case is uniform (`VINE_BAD_FRAME`, that one call only, link alive) even though each medium signals it differently:

| Transport                         | Un-serializable frame in `send()`                                       | Result           |
| --------------------------------- | ----------------------------------------------------------------------- | ---------------- |
| `loopback`                        | passed BY REFERENCE — nothing to serialize, never refused               | (n/a — crosses)  |
| `post-message` / `worker-threads` | `postMessage` throws `DataCloneError` → **rethrown**                    | `VINE_BAD_FRAME` |
| `process`                         | `child.send` throws synchronously (no dead-channel code) → **rethrown** | `VINE_BAD_FRAME` |
| `websocket`                       | `JSON.stringify` throws (a `BigInt`) → **rethrown**                     | `VINE_BAD_FRAME` |

Dead-channel signals (`ERR_IPC_CHANNEL_CLOSED`/`EPIPE`, socket/port gone) fire `onClose` → `VINE_GONE` instead, and a send across a local close is a silent no-op. The websocket JSON codec's lossy-but-VALID degradations (`Date`→ISO string, `Map`/`Set`→`{}`, `Symbol` dropped) are NOT refusals — the frame still crosses; only an un-encodable value (`BigInt`) is refused. This uniformity is what lets a single bad argument on one call fail just that call rather than tearing down the whole link.

### Process transport serialization — `fork(..., { serialization: "advanced" })`

The `process` transport declares `capabilities.structuredClone: true`, but the transport cannot force the child's fork options. That guarantee holds only when the child is forked with `{ serialization: "advanced" }` (the V8 structured-clone serializer). Under the DEFAULT `"json"` serialization, rich types degrade exactly as the websocket JSON codec degrades them (`Date`→string, `Map`/`Set`→`{}`), so a consumer that forwards structured-clone types over `process` MUST fork advanced. The plain JSON-safe frame envelope itself works under either mode.

### Data-only, both directions

The sketch states the rule for arguments. It applies to **return values** too, and that half can only be enforced serve-side: a leaf whose return value contains a function anywhere is answered with an `error` frame carrying `VINE_DATA_ONLY` instead of a `result`. Left unchecked, the same call has two different meanings depending on the transport — over a cloning boundary it fails as an opaque `DataCloneError`, while over a by-reference one (loopback, same realm) the function crosses intact and hands the caller a live closure over the other side's scope, which is a hole in the isolation the vine exists to provide.

### Paths

- A path segment must be a valid ECMAScript **IdentifierName** (`ID_Start`/`ID_Continue`, `$`, `_`, ZWNJ/ZWJ) and must not be `__proto__`, `constructor`, `prototype`, `slothlet`, `shutdown` or `destroy`. The alphabet is deliberately unicode-aware: slothlet sanitizes file and directory names, but a leaf's name is its EXPORT name, which it does not touch — `export function café() {}` is a real, callable, `leaves()`-reported leaf, and an ASCII-only guard drops it for no security gain.
- **Serve dispatches with `Reflect.apply(leaf, parent, args)`, never `leaf.apply(parent, args)`.** Probed on slothlet 3.14.0, merely reading `.apply` off a leaf materializes it into the loader's records: the leaf is reported as a `namespace` owning a child `<leaf>.apply` afterwards. Answering a call would otherwise corrupt the record tree it was read from, and a later `serve()` of the same instance would publish `<leaf>.apply` — `Function.prototype.apply` bound to a real leaf — in place of the leaf.

### Security notes (v1 limits, deliberate)

- **No serve-side concurrency cap.** A peer may have any number of calls in flight; each one invokes a real leaf. The boundary is assumed to be one you established (a worker you spawned, a process you forked, a socket you authenticated at the transport layer), not an open port. A hostile peer on such a channel can exhaust the serving side by volume alone.
- **No grow-side surface-size cap.** A `surface` frame may name any number of leaves and each one becomes a mount. The path guard bounds what a leaf may be _called_, not how many arrive.
- Both are non-goals for v1 rather than oversights; a transport that faces an untrusted network should apply its own limits before the frames reach the vine.

## Non-goals (v1)

Streaming/callback args (data-only), bidirectional-on-one-channel, reconnection/retry, surface re-publication on live reload, auth handshakes (transport-level concern; same-origin/same-process built-ins don't need one), rich byte codecs.
