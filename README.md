# @cldmv/slothlet-vine

Vines between slothlet api trees.

[Slothlet](https://github.com/CLDMV/slothlet) composes a folder of modules into an api **tree**. A **vine** connects two trees across an execution boundary — a Web Worker, another thread, another process, or another machine — by mounting **forwarding leaves**: stubs that live at the callee's identical logical path in the caller's tree, so `self.exts.foo.bar()` works the same whether `foo` is co-located or isolated. Slothlet cannot tell a vine leaf from a real one — including its permission identity, so slothlet's own permission system gates every cross-boundary call before it dispatches.

## Status

**Pre-implementation scaffold.** The design is proven (the forwarding mechanism runs in production node-side in a consuming project, built entirely on slothlet's public API) and the browser transposition is being spiked. The package publishes nothing yet.

## Design

- **Async-only forwarding**: calls serialize to `{ type: "call", callId, path, args, context }` frames; correlation by `callId`; settle-once; per-call budget timers; a dead far side force-settles every in-flight call with a coded error instead of hanging.
- **The `Channel` seam**: every transport implements `{ send(message), onMessage(handler), close() }`. The bridge consumes only this interface — transports are injected, never imported by the core.
- **Batteries included, dependencies contained**: built-in transports ship as subpath exports so each one's dependency loads only if imported:
  - `slothlet-vine/transport/loopback` — in-process pair (tests, simulation)
  - `slothlet-vine/transport/post-message` — browser `Worker` / `MessagePort` (structured clone; no codec)
  - `slothlet-vine/transport/worker-threads` — node worker threads
  - `slothlet-vine/transport/process` — node child-process IPC
  - `slothlet-vine/transport/websocket` — network
- **Schemas**: versioned frame + handshake (leaf-manifest / surface-report) schemas under `slothlet-vine/schemas/*`; each transport declares its codec capability (structured-clone transports pass objects directly; byte transports plug a codec).
- **Custom transports**: implement the `Channel` interface and declare capabilities — nothing else to integrate.

Companion package to `@cldmv/slothlet` (peer dependency); slothlet core stays a dependency-free in-process composition library — the vine is where transports live.

## License

Apache-2.0 © CLDMV
