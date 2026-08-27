# @cldmv/slothlet-vine

Vines between slothlet api trees.

[Slothlet](https://github.com/CLDMV/slothlet) composes a folder of modules into an api **tree**. A **vine** connects two trees across an execution boundary — a Web Worker, another thread, another process, or another machine — by mounting **forwarding leaves**: stubs that live at the callee's identical logical path in the caller's tree, so `self.exts.foo.bar()` works the same whether `foo` is co-located or isolated. Slothlet cannot tell a vine leaf from a real one — including its permission identity, so a rule targeting `exts.foo.bar` gates the forwarding stub exactly as it would gate the real leaf, before it dispatches.

That gating follows slothlet's own rule about **who is calling**: a call made by a MODULE (`self.exts.foo.bar()`) is checked against the permission rules, and a denied one never runs the stub body, so it never reaches the wire. A call made through the bound handle `slothlet()` returned — the host itself — carries host standing and is not checked. That carve-out is slothlet's design, not a vine gap, but it does mean "permission-gated" describes module-initiated calls; a host that forwards on someone else's behalf is responsible for its own authorization.

## Status

**Feature-complete for v1; not yet published.** `grow`, `serve`, the frame protocol, the error taxonomy, and the reusable Channel conformance harness are in place, and **all five built-in transports are implemented and tested over their real boundaries**: `loopback` (in-process reference), `post-message` (a real `worker_threads` `MessageChannel` structured-clone hop), `worker-threads` (a real `Worker`), `process` (a real forked child over IPC), and `websocket` (a real `ws` connection on an ephemeral port). Every transport runs the shared Channel conformance suite plus the full six-point e2e bar against real slothlet instances. The package publishes nothing yet.

> **Note on `process`:** the transport declares structured-clone fidelity, which requires the child to be forked with `{ serialization: "advanced" }`. Under Node's default `"json"` serialization, rich types (`Date`, `Map`, `Set`) degrade the same way the websocket JSON codec degrades them; the plain frame envelope works either way.

The normative protocol lives in [`docs/DESIGN.md`](https://github.com/CLDMV/slothlet-vine/blob/master/docs/DESIGN.md); the wire frames are in [`schemas/frame.schema.json`](schemas/frame.schema.json) (shipped in the published package, so this one link stays relative).

## Usage shape (dot notation — the slothlet idiom)

```js
import * as vine from "@cldmv/slothlet-vine";
import { createPair } from "@cldmv/slothlet-vine/transport/loopback";

const [near, far] = createPair();

// serve this instance's leaves to the far side
const serving = await vine.serve(workerApi, far, { paths: ["exts"] });

// mount the far tree's leaves into this instance, at identical paths
const link = await vine.grow(hostApi, near, { budgetMs: 5000 });
await hostApi.exts.pdfViewer.open("a.pdf"); // executes on the serving instance

await link.close(); // stubs unmounted; in-flight calls settle VINE_CLOSED
serving.close();
```

Single-word leaves, context carried by the namespace — never `growVine()`-style camelCase that repeats the package's own name.

## Design

- **Async-only, data-only forwarding**: calls serialize to `{ type: "call", callId, path, args }` frames; correlation by `callId`; settle-once; per-call budget timers; a dead far side force-settles every in-flight call with a coded error instead of hanging. A function-valued argument is refused at the edge (`VINE_DATA_ONLY`) before anything is sent.
- **The `Channel` seam**: every transport implements `{ send(message), onMessage(handler), close?(), onClose?(handler) }` plus a capability declaration. The core consumes only this interface — transports are injected, never imported by it.
- **Batteries included, dependencies contained**: built-in transports ship as subpath exports so each one's dependency loads only if imported:
  - `slothlet-vine/transport/loopback` — in-process pair (tests, simulation)
  - `slothlet-vine/transport/post-message` — browser `Worker` / `MessagePort` (structured clone; no codec)
  - `slothlet-vine/transport/worker-threads` — node worker threads
  - `slothlet-vine/transport/process` — node child-process IPC
  - `slothlet-vine/transport/websocket` — network
- **Schemas**: versioned frame + handshake (leaf-manifest / surface-report) schemas under `slothlet-vine/schemas/*`; each transport declares its codec capability (structured-clone transports pass objects directly; byte transports plug a codec).
- **Custom transports**: implement the `Channel` interface and declare capabilities — nothing else to integrate.

Companion package to `@cldmv/slothlet` (peer dependency); slothlet core stays a dependency-free in-process composition library — the vine is where transports live.

## Documentation

`docs/` isn't included in the published npm package (see [Design](#design) below), so every link here is absolute — they work the same from npmjs.com, an editor previewing the installed package, or GitHub itself.

- **[Design & Protocol](https://github.com/CLDMV/slothlet-vine/blob/master/docs/DESIGN.md)** — the normative Channel contract, frame schema, `grow`/`serve` semantics, and error taxonomy. If a guide below and this disagree, this wins.
- **[Configuration Reference](https://github.com/CLDMV/slothlet-vine/blob/master/docs/CONFIGURATION.md)** — every `grow()`/`serve()` option, with defaults, and what `link`/`serving` return.
- **[Transports](https://github.com/CLDMV/slothlet-vine/blob/master/docs/TRANSPORTS.md)** — the five built-in transports, when to reach for each, and the death-detection/ownership details that differ between them.
- **[Writing a Custom Transport](https://github.com/CLDMV/slothlet-vine/blob/master/docs/CUSTOM-TRANSPORTS.md)** — implementing the Channel contract, the uniform send-failure policy, and verifying it with the shared conformance harness.
- **[Error Reference](https://github.com/CLDMV/slothlet-vine/blob/master/docs/ERRORS.md)** — the `VINE_*` code list, `VineError`/`VineRemoteError`, and why a remote `VINE_*` code is never adopted as-is.
- **[Permissions](https://github.com/CLDMV/slothlet-vine/blob/master/docs/PERMISSIONS.md)** — how slothlet's own permission system gates a mounted stub exactly like a real leaf.
- **[Using a Vine in the Browser](https://github.com/CLDMV/slothlet-vine/blob/master/docs/BROWSER.md)** — a full Web Worker walkthrough with the `post-message` transport.

## License

Apache-2.0 © CLDMV
