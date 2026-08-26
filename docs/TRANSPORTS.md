# Transports

The five built-in Channel implementations, when to reach for each, and the ownership/death-detection details that differ between them. Every one of these is self-contained — the vine core never imports a transport, so picking one is just choosing which `createChannel(...)` to call. Writing your own is covered in [CUSTOM-TRANSPORTS.md](CUSTOM-TRANSPORTS.md).

---

## At a glance

| Subpath                    | Boundary           |   `structuredClone`    | `codec`  | `buffersUntilHandler` |          Real death detection          |
| -------------------------- | ------------------ | :--------------------: | :------: | :-------------------: | :------------------------------------: |
| `transport/loopback`       | same process       |           ✅           | `"none"` |          ✅           |     ✅ (`close()` always notifies)     |
| `transport/post-message`   | `postMessage` port |           ✅           | `"none"` |          ❌           |      medium-dependent — see below      |
| `transport/worker-threads` | node worker thread |           ✅           | `"none"` |          ❌           |   ✅ (`"exit"`/`"error"`/`"close"`)    |
| `transport/process`        | node child process | ✅ (with `"advanced"`) | `"none"` |          ❌           | ✅ (`"exit"`/`"disconnect"`/`"error"`) |
| `transport/websocket`      | network (`ws`)     |           ❌           | `"json"` |          ❌           |    ✅ (socket `"close"`/`"error"`)     |

`structuredClone: true` means the medium clones the frame for you (`Date`/`Map`/`Set`/etc. survive); `codec: "json"` means the transport encodes/decodes the frame itself, and only plain-JSON-safe values survive intact. See [`capabilities.codec` degradation notes](#the-websocket-json-codec) below for what that costs.

A pending call never actually hangs on a transport with no death detection — it still settles on its `budgetMs`. Death detection just makes that settlement immediate instead of budget-bound.

---

## `transport/loopback`

Two Channels wired to each other **inside one process** — the reference implementation, and the workhorse the conformance harness and most of vine's own unit tests run against. There's no real boundary here: frames cross by reference, not by clone, so it's the fastest option and the wrong one for anything that actually needs isolation.

```javascript
import { createPair } from "@cldmv/slothlet-vine/transport/loopback";
import { grow, serve } from "@cldmv/slothlet-vine";

const [near, far] = createPair();
const serving = await serve(workerApi, far);
const link = await grow(hostApi, near, { budgetMs: 5000 });
```

Delivery is still asynchronous (`queueMicrotask`) — a synchronous loopback would let `send()` re-enter the caller's own stack, and would pass ordering guarantees a real boundary doesn't give for free. Frames sent before the peer registers a handler are **buffered**, not dropped (`buffersUntilHandler: true`) — the only built-in transport that makes that promise, because it's the only one with nowhere for a buffer to be lost.

Use it for: tests, simulating a vine before wiring a real boundary, or composing two slothlet instances in the same process for reasons unrelated to isolation.

---

## `transport/post-message`

Wraps anything exposing `postMessage(frame)` plus an `addEventListener('message', …)`-style `message` event — a browser `Worker`, a browser `MessagePort`, or a node `worker_threads` `MessagePort`. One module serves all of them because they share that surface. See [BROWSER.md](BROWSER.md) for a full Web Worker walkthrough.

**Not this transport for a node `worker_threads` `Worker` handle** — the object `new Worker(...)` returns on the main thread. It has `postMessage()` but, unlike `MessagePort`, is a plain `EventEmitter` with no `addEventListener` and no working `onmessage=` setter, so this transport's receive path never wires up and every inbound frame is silently dropped. Use [`transport/worker-threads`](#transportworker-threads) for that object instead.

```javascript
import { createChannel } from "@cldmv/slothlet-vine/transport/post-message";
import { grow } from "@cldmv/slothlet-vine";

const worker = new Worker("./serve.js"); // a real browser Worker
const link = await grow(hostApi, createChannel(worker, { deathEvents: ["error"] }), { budgetMs: 5000 });
```

### Death detection is medium-specific — the honest matrix

`onClose` fires only on a signal the port genuinely emits, and what that is varies:

- **node `worker_threads` `MessagePort`** — a real `"close"` event on the peer when the other side closes, plus `"messageerror"` on a failed deserialize. This is the case with genuine peer-death detection.
- **browser `Worker`** — no `"close"`, no `"exit"`; only `"error"` (an uncaught error inside the worker) and `"messageerror"`. A main-thread `terminate()` is a LOCAL action and fires no event — main-thread-initiated death is not observable through the port at all. Pass `{ deathEvents: ["error"] }` for the best-effort signal that exists.
- **browser `MessagePort`** — `close()` is local-only per the HTML spec: closing one port does **not** notify the other. There is no peer-death detection here at all. `"messageerror"` still fires.

`options.deathEvents` is unioned with the defaults (`"close"`, `"messageerror"`), never replaces them.

`buffersUntilHandler: false` — the underlying listener attaches eagerly, but a frame arriving before `onMessage()` is called finds no inner handler and is dropped. `grow()`/`serve()` both register their receive handler synchronously, before the far side's asynchronously-delivered `surface` frame can arrive, so this doesn't lose anything in practice.

---

## `transport/worker-threads`

A Channel over the node `worker_threads` boundary specifically — not the generic port surface `post-message` wraps, but the two purpose-built endpoints for a parent/child pair, with **real** death detection on both sides.

```javascript
// main thread (parent side)
import { Worker } from "node:worker_threads";
import { createChannel } from "@cldmv/slothlet-vine/transport/worker-threads";
import { grow } from "@cldmv/slothlet-vine";

const worker = new Worker(new URL("./serve-worker.mjs", import.meta.url));
const link = await grow(hostApi, createChannel(worker), { budgetMs: 5000 });
```

```javascript
// serve-worker.mjs (child side)
import slothlet from "@cldmv/slothlet";
import { serve } from "@cldmv/slothlet-vine";
import { createParentChannel } from "@cldmv/slothlet-vine/transport/worker-threads";

const api = await slothlet({ base: SERVE_DIR });
await serve(api, createParentChannel());
```

- **Parent** (`createChannel(worker)`) — `onClose` fires on the worker's real `"exit"` (any code) or `"error"`, so a dead thread force-settles every in-flight call immediately rather than waiting out a budget. `close()` detaches listeners but **never terminates the worker** — whoever created it owns its lifecycle.
- **Child** (`createParentChannel()`, defaulting to the ambient `parentPort`) — `onClose` fires on the port's `"close"`. `close()` **does** close the wrapped port, because inside a worker the port _is_ the transport.

That asymmetry is deliberate, not a bug: only the side that owns the underlying resource tears it down on `close()`. See [CUSTOM-TRANSPORTS.md](CUSTOM-TRANSPORTS.md) if you're writing a transport with a similar two-endpoint shape.

---

## `transport/process`

A Channel over a forked child's IPC channel — `child_process.fork()`, not a generic spawn.

```javascript
// parent
import { fork } from "node:child_process";
import { createChannel } from "@cldmv/slothlet-vine/transport/process";
import { grow } from "@cldmv/slothlet-vine";

const child = fork("./serve-child.mjs", [], { serialization: "advanced" });
const link = await grow(hostApi, createChannel(child));
// …
await link.close(); // unmounts the stubs — does NOT close the channel
child.kill(); // the parent owns the child's lifecycle
```

```javascript
// serve-child.mjs
import slothlet from "@cldmv/slothlet";
import { serve } from "@cldmv/slothlet-vine";
import { createParentChannel } from "@cldmv/slothlet-vine/transport/process";

const api = await slothlet({ base: "./api" });
await serve(api, createParentChannel());
```

### Fork with `{ serialization: "advanced" }`

Node IPC has two serialization modes. The default, `"json"`, round-trips every frame through `JSON.stringify`/`JSON.parse` — which silently degrades `Date` → ISO string, `Map`/`Set` → `{}`, `Buffer` → `{ type: "Buffer", data: [...] }`. `"advanced"` uses the V8 structured-clone serializer and preserves all of those with fidelity. This transport declares `capabilities.structuredClone: true` because that's the mode it's meant to run under — it cannot force the far side's fork options, so the guarantee only holds when you actually fork with `{ serialization: "advanced" }`. The wire frames themselves are plain JSON-safe objects, so the protocol works under either mode; `"advanced"` is required only once a leaf's arguments or return value carry a richer type.

**Ownership**: the parent's `close()` detaches its listeners and, if the child is still connected, calls `child.disconnect()` — never `child.kill()`. The child's `close()` detaches its listeners and leaves the channel alone entirely; the parent already learns of the child's exit on its own `"exit"` event, so the child doesn't need to disconnect itself.

---

## `transport/websocket`

The one **byte** transport — the medium carries strings, so this module owns its own JSON encode/decode rather than relying on structured clone.

```javascript
// server side
import { WebSocketServer } from "ws";
import { createChannel } from "@cldmv/slothlet-vine/transport/websocket";
import { serve } from "@cldmv/slothlet-vine";

const wss = new WebSocketServer({ port: 0 });
wss.on("connection", async (socket) => {
	await serve(api, createChannel(socket), { paths: ["exts"] });
});
```

```javascript
// client side
import { connect } from "@cldmv/slothlet-vine/transport/websocket";
import { grow } from "@cldmv/slothlet-vine";

const channel = await connect("ws://127.0.0.1:8710");
const link = await grow(hostApi, channel, { budgetMs: 5000 });
```

`ws` is an **optional peer dependency** — imported by nothing in the core, and only lazily by this module's own `connect()`. `createChannel(socket)` wraps a socket you already have (a live socket is itself proof `ws` is installed), so it needs no import; `connect(url)` is the one entry point that constructs a client socket, so it's the one that imports `ws`, and the one that throws a clear "install the optional peer dependency `ws`" error when it's missing.

### The websocket JSON codec

Frames cross as `JSON.stringify(frame)` / `JSON.parse`. That's faithful for the plain-object frame shapes the vine actually sends, but JSON is lossy for richer values a leaf's args or return value might contain:

- `Date` → an ISO **string**, not a `Date`.
- `Map` / `Set` → `{}` — entries are lost entirely.
- `Symbol` — dropped: a symbol-valued property vanishes, a symbol array element becomes `null`.
- `undefined` object properties and array holes — dropped / `null`.
- `TypedArray` / `ArrayBuffer` / `Buffer` — a plain object of indices, not the buffer.

Those are lossy-but-**valid** degradations — the frame still crosses. A `BigInt` is different: it **throws** in `JSON.stringify`, so the codec can't encode the frame at all. That's a per-call refusal (`VINE_BAD_FRAME`), not a dead link — everything else in flight stays fine. If you need `Date`/`Map`/`Set` fidelity, use a structured-clone transport (the `post-message` family) instead.

**Send-before-`OPEN`** is buffered and flushed on `open` (a client socket connects asynchronously, so `send()` may run before the socket is ready). A send on a `CLOSING`/`CLOSED` socket is a silent no-op. `close()` closes the underlying socket — the one built-in transport where `close()` doesn't merely detach listeners, because a `ws` socket is 1:1 with its channel and the conformance suite's "closing one end fires the other's `onClose`" case is only observable over a real socket if `close()` actually closes it.

---

## See also

- [CONFIGURATION.md](CONFIGURATION.md) — the `grow()`/`serve()` options every transport is used with.
- [CUSTOM-TRANSPORTS.md](CUSTOM-TRANSPORTS.md) — implementing and validating your own Channel.
- [BROWSER.md](BROWSER.md) — a full Web Worker walkthrough using `post-message`.
- [DESIGN.md](DESIGN.md) — the normative Channel contract and the uniform send-failure policy every transport here implements identically.
