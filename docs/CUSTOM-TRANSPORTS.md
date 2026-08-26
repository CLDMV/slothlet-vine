# Writing a Custom Transport

The vine core never imports a transport — it consumes exactly one interface, the `Channel`. Any object satisfying that interface works, built-in or not: a message queue, a shared-memory ring buffer, a WebRTC data channel, anything with two ends and a way to move a frame between them. This is the guide to implementing one, and to proving it's correct with the same suite every built-in transport runs.

---

## The Channel contract

```javascript
/**
 * @typedef {object} Channel
 * @property {(message: object) => void} send        — deliver one frame to the far side
 * @property {(handler: (message: object) => void) => void} onMessage — register the (single) receive handler
 * @property {() => void} [close]                    — tear the transport down
 * @property {(handler: (info?: object) => void) => void} [onClose] — register a (single) far-side-death/closure handler
 * @property {{ structuredClone?: boolean, codec?: "none"|"json", buffersUntilHandler?: boolean }} [capabilities]
 */
```

Only `send` and `onMessage` are required. `close`, `onClose`, and `capabilities` are all independently optional — a transport that can't detect far-side death simply omits `onClose`, and the core still works (a pending call settles on its `budgetMs` instead of immediately). `docs/DESIGN.md` is the normative source for this contract; this page is the practical "how do I build one" companion.

### The rules, restated as things to actually do

- **`send`/`onMessage` carry plain frame objects.** If your medium structured-clones (like `postMessage`), pass frames through untouched and declare `capabilities.structuredClone: true, codec: "none"`. If your medium only carries bytes/strings, own your encode/decode internally and declare `codec: "json"` (or whatever you use) — see `transport/websocket` for the reference byte transport.
- **`onMessage`/`onClose` are single-handler registrations — last write wins.** A second `onMessage(fn)` call replaces the first, it doesn't add a second listener.
- **A handler must never be allowed to throw into your transport.** Wrap every call to a registered handler:

  ```javascript
  try {
  	handler(message);
  } catch {
  	// Contract: handlers never throw into the transport.
  }
  ```

- **`send()` follows a uniform three-way failure policy — this is the one rule every built-in transport implements identically, and the one most worth getting right:**

  | What happened                                                                                                                  | What `send()` does                     | What the core does                                                                               |
  | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
  | The medium **refuses this one frame** (an un-serializable value the data-only scan couldn't see — e.g. a `Symbol`, a `BigInt`) | **Rethrow, synchronously**             | Settles just that call `VINE_BAD_FRAME`. The link and every other in-flight call are unaffected. |
  | The channel is **dead** (socket gone, port closed, process disconnected)                                                       | Swallow the throw, then fire `onClose` | Force-settles every pending call `VINE_GONE`.                                                    |
  | **Close race** (a send after a local `close()`, or a frame crossing a peer's close)                                            | Silent no-op                           | Tolerates it — the call settles on death or budget.                                              |

  Conflating the first two rows is the single most consequential mistake a custom transport can make: it turns one bad argument into a dead link instead of one failed call. Every built-in transport classifies its medium's specific throw (a `DataCloneError` name, a dead-channel error code, a `JSON.stringify` throw) to pick the right row — see any of `src/transport/*.mjs` for a worked example of the classification.

- **Frames may arrive after a local `close()`.** Don't throw; drop them. The core is required to tolerate this.

---

## A minimal example

An in-memory pair using `MessageChannel`-style ports is the shortest real illustration — this is close to what `transport/loopback` itself does, simplified:

```javascript
function makeEndpoint() {
	let handler = null;
	let closeHandler = null;
	let closed = false;
	const endpoint = {
		capabilities: { structuredClone: true, codec: "none", buffersUntilHandler: false },
		_peer: null,
		send(message) {
			if (closed) return;
			const peer = endpoint._peer;
			if (!peer || peer.closed) return;
			queueMicrotask(() => {
				if (peer.closed) return;
				try {
					peer.handler?.(message);
				} catch {
					// Contract: handlers never throw into the transport.
				}
			});
		},
		onMessage(fn) {
			handler = typeof fn === "function" ? fn : null;
		},
		onClose(fn) {
			closeHandler = typeof fn === "function" ? fn : null;
		},
		close() {
			if (closed) return;
			closed = true;
			const peer = endpoint._peer;
			if (peer && !peer.closed) {
				queueMicrotask(() => {
					try {
						peer.closeHandler?.({ reason: "peer-closed" });
					} catch {
						// Contract: handlers never throw into the transport.
					}
				});
			}
		}
	};
	return endpoint;
}

export function createPair() {
	const a = makeEndpoint();
	const b = makeEndpoint();
	a._peer = b;
	b._peer = a;
	return [a, b];
}
```

Delivery is deliberately asynchronous (`queueMicrotask`) even though this is all one process — a synchronous transport would let `send()` re-enter the caller's own stack, and would pass ordering guarantees a real boundary can't actually give you for free.

---

## Verifying it: the conformance harness

`@cldmv/slothlet-vine/testing` exports `channelConformance`, a reusable test suite that exercises the Channel contract itself — delivery, ordering under a burst, large payloads, `onMessage` replacement, handler-throw insulation, close notification, capability declaration — independent of any test framework. Every built-in transport's test file runs this suite alongside its own end-to-end test.

```javascript
import { describe, it, expect } from "vitest";
import { channelConformance } from "@cldmv/slothlet-vine/testing";
import { createPair } from "./my-transport.mjs";

channelConformance("my-transport", () => createPair(), { describe, it, expect });
```

`channelConformance(name, makePair, { describe, it, expect })` takes no test-framework import of its own — you inject `describe`/`it`/`expect`, so the same suite runs unmodified under vitest, `node:test`, jest, or mocha; whatever you already use.

`makePair` may be sync or async, and may return either a plain `[a, b]` tuple or `{ a, b, cleanup? }`. Use the object form when your transport owns a real resource that needs explicit teardown between test cases — a worker, a socket, a server:

```javascript
channelConformance(
	"my-transport",
	async () => {
		const server = await standUp();
		return {
			a: createChannel(server.socketA),
			b: createChannel(server.socketB),
			cleanup: () => server.tearDown()
		};
	},
	{ describe, it, expect }
);
```

### What it actually asserts

- A frame sent from `a` arrives at `b`, and vice versa.
- Delivery is genuinely asynchronous — never synchronous inside `send()`.
- Order is preserved across a 50-frame burst, and interleaved bursts from both ends don't cross-contaminate.
- A large-ish payload (a 200 KB string, a 5000-element array, nested objects) survives intact.
- The suite reads `capabilities.buffersUntilHandler` and asserts **whichever** behavior your transport declares — a frame sent before `onMessage()` is ever called is either replayed (`true`) or dropped (absent/`false`); what's not valid is claiming one and doing the other.
- A second `onMessage()` registration fully replaces the first.
- A throwing handler doesn't break the channel — a later, correctly-behaving handler still receives subsequent frames.
- If your transport declares `close`/`onClose`, closing one end fires the _other_ end's `onClose` exactly once, and does **not** fire the closer's own `onClose`. If it doesn't declare them, this case is skipped — a channel with no such capability has nothing further to assert.
- `close()` is idempotent, and `send()` after close never throws.
- `capabilities.codec` is one of the documented values (or absent).

If your transport omits `close`/`onClose`/`capabilities` entirely, the suite tolerates that — see `tests/conformance-minimal.test.vitest.mjs` in this repo for what running the full suite against the bare minimum (`send` + `onMessage` only) looks like.

---

## See also

- [DESIGN.md](DESIGN.md) — the full normative Channel contract, the frame schema, and the error taxonomy.
- [TRANSPORTS.md](TRANSPORTS.md) — the five built-in transports, as worked examples of everything above.
- [ERRORS.md](ERRORS.md) — what `VINE_BAD_FRAME` / `VINE_GONE` actually mean from the consuming side.
