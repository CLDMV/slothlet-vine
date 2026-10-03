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
 *   dropped (absent/`false`) — the conformance suite asserts whichever the transport declares. Every
 *   built-in transport buffers (CLDMV/slothlet-vine#41).
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

| Frame   | Shape                                                                                                        | Direction                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| surface | `{ type: "surface", v: 1, leaves: string[] }`                                                                | serve → grow, once on link start (and again if the served surface changes — v1 sends once)     |
| call    | `{ type: "call", callId: string, path: string, args: unknown[] }`                                            | grow → serve                                                                                   |
| result  | `{ type: "result", callId: string, value?: unknown }`                                                        | serve → grow                                                                                   |
| error   | `{ type: "error", callId: string, error: { name: string, message: string, code?: string, stack?: string } }` | serve → grow                                                                                   |
| sub     | `{ type: "sub", subId: string, event: string, subscriberPath: string \| null }`                              | either → either — subscribe to a far event AS an identity (event forwarding is bidirectional)  |
| sub-ack | `{ type: "sub-ack", subId: string, level: "deny" \| "notify" \| "allow" }`                                   | reply to a `sub` — the resolved delivery level for that subscription                           |
| event   | `{ type: "event", subId: string, event: string, at: number, instanceID: string, payload?: unknown }`         | emitting → subscribing — one forwarded delivery (the `payload` key is present ONLY at `allow`) |
| unsub   | `{ type: "unsub", subId: string }`                                                                           | subscribing → emitting — tear the subscription down                                            |

- `callId`: unique per grow-side link (monotonic counter + link nonce; never `Math.random` collisions).
- `subId`: the event-forwarding correlation id. Event forwarding is bidirectional, so EACH end draws its own subscriptions' `subId`s from its own nonce (separate from `callId`'s, so a `sub-ack` and a call `result` can never be confused, and separate per end, so the two directions' ids never collide); frames route by TYPE regardless. `subscriberPath` is the subscriber's own identity (from `api.slothlet.caller()`), matched — never mounted — against the EMITTING instance's event rules, so an untrusted string cannot pollute a prototype the way an unguarded `call` path could. See [Event forwarding](#event-forwarding-schema-v1).
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
	budgetMs: 30_000, // unused serve-side v1 (documented for symmetry)
	principal: { path: "remote.renderer", context: { actor } } // OPTIONAL: the channel principal (#33) — string | { path, context? } | () => either
});
// serving: { leaves: string[], excluded: string[], principal: object|Function|null, close(): void }

// grow: mount the far side's leaves into this instance
const link = await vine.grow(api, channel, {
	budgetMs: 30_000, // per-call settle budget; exceeded → VINE_BUDGET error
	handshakeMs: 30_000, // deadline for the surface frame; Infinity to wait forever
	paths: ["exts"], // dotted prefixes to mount (grow-side mirror of serve's)
	principal: "remote.plugin" // OPTIONAL: the channel principal for this end's EVENT server-half only (a grow answers no calls)
});
// link: { id, leaves: string[], skipped: string[], collisions: string[], close(): Promise<void>, closed: Promise<{reason}> }
```

Semantics:

- **serve** answers `call` frames by resolving the dotted path against the live api and invoking it. It re-validates that the path is within the served surface (never trust the wire). Thrown/rejected errors become `error` frames. It sends `surface` immediately on start, derived from the instance's leaf records filtered by `paths` and the hard `slothlet.**` exclusion.
- **serve with a `principal`** judges every `call` frame as that identity before anything runs. The pipeline, in order: `VINE_NO_LEAF` (the surface filter is the outer boundary and is already public in the `surface` frame) → resolve the principal (a function form is called per frame; a throw or a non-principal answer denies the frame) → open `api.slothlet.context.scope({ context: principal.context ?? {}, protect: Object.keys(context), fn })` → `api.slothlet.permissions.global.checkCall(principal.path, path, args)` inside that scope, `VINE_DENIED` unless it answers exactly `true` → the args data-only check (`VINE_DATA_ONLY`) → invoke (through `around`, when one is given), still inside the scope → the return-value data-only check → `result`. The gate precedes the args scan because rule conditions are user code that receives `args`: an unauthorized principal's payload never reaches one. Without a `principal` the pipeline is the v1 one above, byte for byte — no gate, no scope, host standing. See [Channel principal (#33)](#channel-principal-33) under the implementation notes.
- **serve with `around`** hands each accepted call to the host's wrapper in place of the bare invocation: `around({ callId, path, args, principal, invoke })` runs after the surface check, the principal gate (inside its scope) and the args data-only check, and its return value — not the leaf's — goes through the return-value data-only check and becomes the `result`; a throw becomes the `error`. `invoke()` is fixed to the gated path and to a private snapshot of the gated arguments: it takes no arguments, may be called more than once (a retried transaction), and each call receives a fresh structured clone of the snapshot, while `around`'s own `args` is a separate copy. The parsed frame's `args` is a fresh array whose elements are still shared, so without the snapshot a wrapper — or a bug in one — could mutate a nested argument after the rules engine judged it. See [CONFIGURATION.md → `around`](CONFIGURATION.md#around).
- **grow** awaits the `surface` frame (subject to `handshakeMs`), then mounts one async stub per leaf at the identical dotted path via slothlet's synthetic in-memory add (`api.slothlet.api.add(path, stubFn, { moduleID })`, one shared link moduleID) so **slothlet's own permission system gates stub calls exactly like real leaves**. `link.close()` removes the mounts (`api.slothlet.api.remove(moduleID)`) and settles all pending calls with `VINE_CLOSED`.
- A **channel is directional**: one serve end, one grow end. Bidirectional forwarding = two channels (transports that have paired endpoints expose pairs).
- **Death**: `channel.onClose` (or transport-detected far-side death) force-settles every pending call with `VINE_GONE` and resolves `link.closed`. Pending calls NEVER hang.
- **Budget**: each grow-side call arms a timer (`budgetMs`); expiry settles that call with `VINE_BUDGET` (the late result frame, if it arrives, is ignored — settle-once).
- **Settle-once** everywhere: a callId settles exactly once (result | error | budget | gone | closed); later frames for it are dropped.

Error codes (all `VineError` subclasses carrying `.code`): `VINE_GONE`, `VINE_BUDGET`, `VINE_CLOSED`, `VINE_DATA_ONLY`, `VINE_BAD_FRAME`, `VINE_NO_LEAF` (call for a path not in the served surface), `VINE_DENIED` (the channel principal may not call this path — produced only by a serve that bound a `principal`), `VINE_REMOTE`. Remote application errors re-throw as `VineRemoteError` (their own name/message/code) — except a `VINE_*` code, which is never adopted from the wire; see [Errors](#errors) below.

## Event forwarding (schema v1)

The vine also carries slothlet's instance-wide **events** (`api.slothlet.event`, slothlet #407) across the boundary, **in both directions**: an event emitted in either linked instance reaches subscribers in the other. This works because the two instances are copies of one api (per-leaf stubs at identical paths) and therefore hold the SAME event permissions. slothlet stays boundary-agnostic — it gates SUBSCRIBERS, never emitters, resolving each subscriber to one of three levels (`deny` = nothing, `notify` = a trigger with no payload, `allow` = trigger + payload) — so the one boundary rule the vine adds is: **a subscriber only ever receives what its level allows, and nothing more than that is ever put on a wire heading toward it.** Because the rules are identical in every instance, the **emitting** side resolves each far subscriber itself and sends only what its level permits — so a `notify` subscriber's payload never crosses — and whichever side resolves gets the same answer, so there is no trust flag, no authority handoff, and no gate on who may emit. It rests on two slothlet primitives, present on both ends: `api.slothlet.caller()` (a subscriber's own identity) and `api.slothlet.event.resolveLevel(subscriberPath, event)` (the emitting side's resolver). Both first shipped in **3.18.0**, but a **same-process** transport (the loopback, or any pair sharing a process) requires **≥ 3.18.1**: 3.18.0 leaked a foreign instance's caller across the process-shared async context, pinning the emitting side's forwarding listener to the far subscriber's identity so the host-only re-resolve was denied at emit and nothing was forwarded (CLDMV/slothlet#436). A real cross-process boundary (worker, process, socket) cannot propagate that context and works on 3.18.0+, but 3.18.1 is the floor for reliable forwarding across every transport.

Both ends expose the same surface — `link.event` on the grow side, the serve handle's `event` on the serve side — async, because the granted level is resolved across the boundary:

```js
// grow side subscribing to a serve-emitted event:
const { level, off } = await link.event.on("orders.created", (payload, meta) => {
	// meta is { event, at, instanceID }; payload is undefined at `notify`.
});
// serve side subscribing to a grow-emitted event (identical shape):
const sub = await serving.event.on("renderer.click", (payload, meta) => {});
// .once(event, listener) is the single-delivery form on either surface.
```

The flow, per subscription, is symmetric — "near" is the subscribing side, "far" the emitting side (either can be grow or serve):

1. **The near side subscribes as its real identity.** `event.on` reads `api.slothlet.caller()` — the subscribing module's own dotted path (the same identity `event.on` captures locally), `null` for a host subscription — and sends a `sub` frame `{ subId, event, subscriberPath }`. The identity is captured synchronously before the first `await`, while the subscriber's extent is the active caller.
2. **The far side resolves and acks.** The emitting side calls `api.slothlet.event.resolveLevel(subscriberPath, event)` against its own (identical) rules and returns the level in a `sub-ack`. A downgrade or denial is therefore a **distinct, catchable result** on the near side (`{ level }`), never a silent absence of payloads — which makes a manifest/consumer mismatch or a version skew observable. At `deny` the near side registers no listener and `off` is a no-op. **When the emitting end bound a channel `principal`** (`serve()` / `grow()` option, #33), it resolves as `principal.path` instead — `null` from the far side is the channel itself, not the host — inside `context.run(principal.context)` when a context is bound, and the far `subscriberPath` is honoured only when it sits at or under the principal's path, and then only to narrow (the lower of the two levels; `deny` < `notify` < `allow`). A claim anywhere else is ignored and the channel's own level is used.
3. **The far side host-subscribes and cuts per emit.** Unless denied, the emitting side subscribes to the event at the host level (full payload) and, on each emit, **re-resolves** the far subscriber's level and forwards an `event` frame carrying the payload only at `allow` — omitting the `payload` key entirely at `notify`. Re-resolving per emit (not just at subscribe) honours a later rule change live, and the `subscriberPath` is only ever glob-matched, never mounted.
4. **The near side re-delivers.** The `event` frame is delivered to the subscription's listener as `(payload, meta)` — `payload` `undefined` when the key was absent (`notify`), the value when present (`allow`). A `once` subscription is torn down before delivery and an `unsub` is sent.

Each end runs both halves at once (`src/lib/events.mjs`), and the two never cross wires: an end draws its own subscriptions' `subId`s from its own nonce, and frames are routed by TYPE (`sub`/`unsub` → the serving half, `sub-ack`/`event` → the subscribing half), so the same four frames flow both ways over one channel.

Cross-cutting rules, consistent with the call path:

- **Data-only.** Event payloads are data. A function anywhere in a payload cannot cross (over a by-reference transport it would hand the far side a live closure), so an `allow` delivery whose payload hides a function degrades to trigger-only rather than leaking it — the emitting side's `findFunctionArg` check, the same guard the call path uses on arguments and return values.
- **Lifecycle.** `off()` sends `unsub` and stops local delivery; either end's `close()` unsubscribes every subscription it made, tells the far side to drop them, and settles in-flight handshakes `VINE_CLOSED`; far-side death settles them `VINE_GONE`. A subscribe handshake has its own budget (a `sub-ack` that never arrives settles `VINE_BUDGET`). Each end drops every host-level listener it registered on close.
- **Enforcement is on the emitting side; across an untrusted boundary, the channel principal is the identity.** The level is resolved and the payload cut where the event originates, against that instance's rules — so a `notify` subscriber's payload never leaves the emitter. On a trusted transport (a worker you spawned, a process you forked) the far side's `subscriberPath` is its honest `caller()` and is resolved as-is. Across an **untrusted** boundary — a browser that could forge `subscriberPath` to claim a higher level, or send `null` to be treated as the host — the emitting end binds a `principal` to the channel (#33): the transport authenticates the peer, `serve()` / `grow()` binds the resulting identity, and the far side's asserted path can then only narrow what the channel is granted, never widen it. Per-module paths from the far side remain useful only as least privilege between well-behaved modules; the security boundary is the channel.
- **Graceful degradation.** An end without `resolveLevel` (slothlet < 3.18.0) refuses every incoming `sub` with a catchable `deny` rather than forwarding ungated — the vine never carries a payload it cannot gate. An end without `api.slothlet.caller()` throws a clear `TypeError` from `event.on`. On 3.18.0 the primitives are _present_ (so these guards pass) but the cross-instance caller bug silently drops same-process deliveries — hence the ≥ 3.18.1 floor above for a shared-process transport; a real cross-process boundary is unaffected.

### Event volume (no backpressure in v1)

Forwarded events are fire-and-forget. Each emit that clears a subscriber's resolved level is sent as one `event` frame the moment it fires (see `accept`'s host listener in `src/lib/events.mjs`) — there is no vine-level rate cap, queue, coalescing, or backpressure signal from a slow far side back to the emitter. A call's `budgetMs` bounds how long a caller waits for a _result_; forwarded events have nothing equivalent beyond the one-time subscribe handshake's own budget (the `sub-ack`). A high-frequency emitter can flood a slow transport, and a slow subscriber on the far side has no channel-level way to ask the emitter to slow down.

Volume control belongs in the emitter — throttle, debounce, or coalesce before emitting, the same way you would for any other high-frequency event source:

```javascript
// At most one forwarded "pointer.move" per 50 ms; intermediate positions are dropped.
let last = 0;
function emitPointerMove(x, y) {
	const now = Date.now();
	if (now - last < 50) return;
	last = now;
	void api.slothlet.event.emit("pointer.move", { x, y });
}
```

or in the transport — its own buffering or limits, e.g. checking a WebSocket's `bufferedAmount` before writing more, or watching a worker's own message-queue depth.

Any limit added this way must only ever _reduce_ what crosses the boundary, never widen it past what the subscriber's resolved level already allows — the same confidentiality rule the rest of event forwarding runs on: a throttled or coalesced emit may drop to nothing or to trigger-only, but it may never smuggle a payload past a `notify`/`deny` subscriber.

This is independent of the [channel principal](#channel-principal-33) — that decides _who_ may subscribe and at what level; this note is about _how much_ crosses once a subscription is granted.

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

The sketch states the rule for arguments, enforced grow-side before a stub ever sends a frame. It applies to **return values** too, and that half can only be enforced serve-side: a leaf whose return value contains a function anywhere is answered with an `error` frame carrying `VINE_DATA_ONLY` instead of a `result`. Left unchecked, the same call has two different meanings depending on the transport — over a cloning boundary it fails as an opaque `DataCloneError`, while over a by-reference one (loopback, same realm) the function crosses intact and hands the caller a live closure over the other side's scope, which is a hole in the isolation the vine exists to provide.

Serve also re-checks **arguments**, as a backstop, for the identical reason: the grow-side stub's own pre-send check only covers frames a legitimate `vineStub` call actually built. Nothing stops a frame constructed directly against the channel — possible only over a by-reference transport like loopback, where no serialization step would otherwise refuse a live function reference — from reaching `serve()` with a function hiding in `args`. `serve()` therefore runs the same `findFunctionArg` check on `args` before invoking the leaf, answering `VINE_DATA_ONLY` rather than ever calling the leaf with a live function reference.

### Paths

- A path segment must be a valid ECMAScript **IdentifierName** (`ID_Start`/`ID_Continue`, `$`, `_`, ZWNJ/ZWJ) and must not be `__proto__`, `constructor`, `prototype`, `slothlet`, `shutdown` or `destroy`. The alphabet is deliberately unicode-aware: slothlet sanitizes file and directory names, but a leaf's name is its EXPORT name, which it does not touch — `export function café() {}` is a real, callable, `leaves()`-reported leaf, and an ASCII-only guard drops it for no security gain.
- **Serve dispatches with `Reflect.apply(leaf, parent, args)`, never `leaf.apply(parent, args)`.** Probed on slothlet 3.14.0, merely reading `.apply` off a leaf materializes it into the loader's records: the leaf is reported as a `namespace` owning a child `<leaf>.apply` afterwards. Answering a call would otherwise corrupt the record tree it was read from, and a later `serve()` of the same instance would publish `<leaf>.apply` — `Function.prototype.apply` bound to a real leaf — in place of the leaf.

### Channel principal (#33)

The serve side answers `call` frames with host standing: `invoke()` walks the bound `api` object and `Reflect.apply`s the leaf, and slothlet's own gate never fires for a host-initiated call. The frame carries no identity, and the event half's `subscriberPath` is caller-asserted. On a trusted transport that is the intended v1 model. Facing a peer the host cannot trust — a browser page with a socket — the vine needs an identity the far side cannot set, and the only such identity is the one the host bound to the channel from the transport's own authentication. That is the `principal` option, implemented in `src/lib/principal.mjs`:

- **Shape.** `string | { path, context? } | () => (string | { path, context? })`. `path` is a dotted caller identity slothlet's `caller:` globs match (call rules and event rules alike), validated with the same path guard as a leaf; `context` must be a plain object (it is deep-cloned per scope, and only plain data gets full-depth `protect`). A function is called synchronously per frame — a host can rotate identity on re-auth without re-serving — and a throw or a non-principal answer denies that one frame. The normalized value is frozen and exposed as `serving.principal` (the resolver itself for the function form; `null` when unset).
- **Why the vine asks, then enforces.** slothlet has no public way to dispatch a call _as_ an identity: caller identity is a genuine wrapper slothlet's own `runInContext` places on the async store, and `context.run()` / `scope()` from the host keep host standing. So the serve side asks the rules engine and enforces the answer itself — the same shape the event half already uses with `event.resolveLevel`. The call-side twin is `api.slothlet.permissions.global.checkCall(callerPath, targetPath, args)` (CLDMV/slothlet#508): full call-gate semantics — `callMeta = { args, target }` for function conditions, the ambient runtime context, stale `requires`-principals resolved, the caller treated as a module with no source file, audit events. The older `global.checkAccess(caller, target)` is a silent query that passes `callMeta = null`, so a resource-scoped condition (`(ctx, { args }) => args[0] === ctx.actor.project`) is a non-match through it in whichever direction `defaultPolicy` points; the vine therefore does not fall back to it. One seam function, `gate()`, wraps the call and fails closed: a missing API, a throw, or any verdict other than literal `true` is a denial.
- **Preconditions, checked once at `serve()` / `grow()` as a `TypeError`** (before any frame is answered; the surface is never published on failure): the instance's permission system must be enforcing (`api.slothlet.permissions.control.enabled === true` — verified on 3.20.0: `permissions` exists whether or not a block was configured, and the accessor reads `false` with no block, `true` with any block, and tracks `control.disable()` / `enable()`); `api.slothlet.event.resolveLevel` must exist; for `serve()`, `permissions.global.checkCall` must exist and `api.slothlet.context.scope` must _work_ — probed with an empty scope, because a `scope: false` instance still exposes `scope` as a function that rejects `SCOPE_DISABLED`; for `grow()`, `context.run` is probed the same way only when a static principal carries a `context`. A principal on an unenforced instance would gate nothing — a silent lie — so it is refused rather than warned about. A later `control.disable()` by the host reopens the gate for principals exactly as for local modules; that is the host's own act.
- **Calls.** The pipeline is given under [API surface](#api-surface-dot-notation--single-word-leaves). Both the gate and the invocation run inside one `context.scope` carrying `principal.context` with every top-level key in `protect`, so conditional rules, `requires`-principals and the leaf see the same context and nothing downstream can reassign the actor (nested fields included — `CONTEXT_KEY_PROTECTED`). The scope's own failure (it throws, or resolves without ever running `fn`) is `VINE_DENIED`; the leaf never runs outside the scope or without a verdict.
- **Events.** With a principal, `null` from the far side is the channel; a far `subscriberPath` at or under the principal's path narrows to the lower of the two levels; any other claim is ignored. Prefix _substitution_ (use the hint's level whenever it is under the prefix) was considered and rejected: a forged sibling under the prefix could claim a sibling's higher grant. Resolution runs inside `context.run(principal.context)` when a context is bound, at subscribe and again per emit. On the installed slothlet `context.run()` returns a Promise even for a synchronous callback, so a principal-bound `sub` is acked after that resolution settles and each emit is forwarded after its re-resolution; a `sub` repeated while the first is still resolving registers nothing, and an `unsub` or a teardown that lands in that window cancels it — nothing is acked and no listener is registered. Without a principal the event half is synchronous and unchanged.
- **`grow({ principal })`.** The forwarder is symmetric and the trusted end of a channel is not always the serving end — a host that grows leaves out of an untrusted worker plugin still answers that plugin's `sub` frames for host events. So `grow()` takes the same option for its event server-half only; a grow answers no `call` frames, so `checkCall` is not required there.
- **`VINE_DENIED`.** A new vine code, not slothlet's `PERMISSION_DENIED`: it is the vine refusing on its own account, and the contract is that those are `VineError`s. Not `VINE_NO_LEAF` either — the surface frame already disclosed what exists, and a distinguishable "you may not" hides nothing extra. The message names the path only; the principal is serve-side detail and never crosses (`toWire` sends `name` / `message` / `code` / `stack`). Grow-side it arrives, like every remote `VINE_*` code, as a `VineRemoteError` with `.code === "VINE_REMOTE"` and `.remoteCode === "VINE_DENIED"`.
- **Wire format unchanged.** No frame, schema or `FRAME_VERSION` change: the `call` frame still carries no identity (identity is the channel's, not the frame's), and the `sub` frame still carries the far side's own `caller()`. A 1.1.x grow talks to a serve with a principal, and vice versa, unchanged.
- **Runtime caveat.** A principal-bearing serve must run on the async (Node) runtime: under `runtime: "live"` (and in browser mode) concurrent `scope()` calls on one instance interleave, and one channel's actor could be attributed to another channel's call. The instance does not expose its runtime mode publicly, so this is documented rather than refused.
- **`paths` / `modules` are orthogonal.** The surface filter decides what is reachable at all (published in `surface`, reported in `excluded`); the principal gate decides who may call it. With a principal, `paths` is the coarse allow-list and the rules are the fine one; both are consulted on every frame.

### Security notes (v1 limits, deliberate)

- **No serve-side concurrency cap.** A peer may have any number of calls in flight; each one invokes a real leaf (with a `principal`, each one is first judged by the rules engine — but a denial is still work). The boundary is assumed to be one you established (a worker you spawned, a process you forked, a socket you authenticated at the transport layer), not an open port. A hostile peer on such a channel can exhaust the serving side by volume alone.
- **No grow-side surface-size cap.** A `surface` frame may name any number of leaves and each one becomes a mount. The path guard bounds what a leaf may be _called_, not how many arrive.
- Both are non-goals for v1 rather than oversights; a transport that faces an untrusted network should apply its own limits before the frames reach the vine. What the vine _does_ decide at an untrusted boundary is identity and authorization: the channel principal above.
- **No event-volume control.** Forwarded events have no rate cap, queue, coalescing, or backpressure signal beyond the one-time subscribe handshake's `budgetMs` — each emit that clears a subscriber's level is sent as one `event` frame immediately; see [Event volume](#event-volume-no-backpressure-in-v1) above. Also a non-goal for v1: volume control belongs in the emitter or the transport, not the vine core.

## Non-goals (v1)

Streaming/callback args (data-only), bidirectional-on-one-channel, reconnection/retry, surface re-publication on live reload, auth handshakes (transport-level concern; same-origin/same-process built-ins don't need one), rich byte codecs.
