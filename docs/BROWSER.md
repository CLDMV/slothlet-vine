# Using a Vine in the Browser

The `post-message` transport is the one built for this: a real browser `Worker` boundary, structured-clone frames, no bundler-unfriendly node built-ins. This walks through growing a vine into a Web Worker end to end.

---

## The shape

Two files: a main-thread module that `grow()`s a link into the worker, and a worker module that `serve()`s a slothlet instance out of it.

```javascript
// main.js — main thread
import { createChannel } from "@cldmv/slothlet-vine/transport/post-message";
import { grow } from "@cldmv/slothlet-vine";
import slothlet from "@cldmv/slothlet";

const hostApi = await slothlet({ base: "./host-api" });

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const channel = createChannel(worker, { deathEvents: ["error"] });

const link = await grow(hostApi, channel, {
	budgetMs: 5000, // per-call timeout once the link is up
	handshakeMs: 30_000, // a worker's first module fetch + eval can take a while — be generous here
	paths: ["exts"]
});

await hostApi.exts.pdfViewer.open("a.pdf"); // executes INSIDE the worker

// tearing the link down later:
await link.close(); // unmount the stubs, settle any in-flight calls VINE_CLOSED
channel.close(); // detach the transport's own listeners
worker.terminate(); // actually end the thread — the vine never does this for you
```

```javascript
// worker.js — inside the Worker
import { createChannel } from "@cldmv/slothlet-vine/transport/post-message";
import { serve } from "@cldmv/slothlet-vine";
import slothlet from "@cldmv/slothlet";

const api = await slothlet({ base: "./exts" });
await serve(api, createChannel(self), { paths: ["exts"] });
```

Inside a worker, the global `self` has both `postMessage(data)` (to the main thread) and `addEventListener("message", fn)` (from the main thread) — exactly the port surface `createChannel` wraps. Nothing worker-specific to configure beyond that.

---

## Death detection is best-effort — know the gap

A browser `Worker`'s main-thread handle has **no `"close"` event and no `"exit"` event** — only `"error"` (an uncaught exception inside the worker) and `"messageerror"` (a failed deserialize). Pass `{ deathEvents: ["error"] }` as shown above to catch a worker that crashes.

What you **cannot** observe: a main-thread-initiated `worker.terminate()` fires no event at all. If you call `worker.terminate()` directly instead of going through `link.close()` first, the grow-side link has no way to learn the far side is gone — any call still in flight sits until its `budgetMs` expires rather than settling immediately with `VINE_GONE`. **Always call `link.close()` (and optionally `channel.close()`) before `worker.terminate()`** if you're the one ending the worker; reserve the `"error"` death signal for the worker crashing on its own.

This gap doesn't mean a pending call ever hangs — it always settles, worst case on its budget — it just means "worker died" and "worker was told to stop" resolve at different speeds depending on which one happened.

---

## What survives the postMessage boundary

`capabilities.structuredClone: true` — the browser's structured-clone algorithm handles the frame, so `Date`, `Map`, `Set`, `ArrayBuffer`, and most other structured-cloneable values in a leaf's arguments or return value survive intact. What does **not** survive, per the vine's own data-only rule (not a browser limitation): a function anywhere in the argument or return graph is refused at the edge with `VINE_DATA_ONLY` before it's ever posted — see [ERRORS.md](ERRORS.md).

An argument or return value the structured-clone algorithm itself can't handle (a `DataCloneError` — e.g., a DOM node, or a value the data-only scan couldn't see hiding a function) is a **per-call** failure (`VINE_BAD_FRAME`), not a dead link — every other in-flight call is unaffected.

---

## Isolation is a permissions concern, not a transport one

The `post-message` transport moves frames; it doesn't decide who's allowed to call what. If the point of isolating something into a worker is to restrict what can reach it, pair the vine with slothlet's own permission rules on the **grow** side — see [PERMISSIONS.md](PERMISSIONS.md). A denied module call is stopped before the stub ever posts a frame, so nothing reaches the worker at all.

---

## See also

- [TRANSPORTS.md](TRANSPORTS.md#transportpost-message) — the full death-detection matrix across every medium `post-message` wraps (browser and node both).
- [CONFIGURATION.md](CONFIGURATION.md) — `handshakeMs`/`budgetMs` tuning.
- [CUSTOM-TRANSPORTS.md](CUSTOM-TRANSPORTS.md) — if `post-message` doesn't fit (e.g. a `SharedWorker`, a `BroadcastChannel`), the same guide applies to writing your own.
