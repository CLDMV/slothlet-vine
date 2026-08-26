# Error Reference

Every failure a vine produces on its own account is a `VineError` carrying a stable `.code`. A failure produced by the **far side's application code** crosses as data and re-throws locally as a `VineRemoteError`, which keeps the original error's own `name` / `message` / `code`. Both are exported from the package root:

```javascript
import { CODES, VineError, VineRemoteError } from "@cldmv/slothlet-vine";
```

---

## `VINE_*` codes

| Code             | Fires when                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VINE_GONE`      | The far side died — its channel closed (or a transport-detected death fired) with the call still in flight.                                                                                                  |
| `VINE_BUDGET`    | The per-call settle budget (`budgetMs`) elapsed before a terminal frame arrived. Also fires for a `grow()` handshake that never sees a `surface` frame within `handshakeMs`.                                 |
| `VINE_CLOSED`    | `link.close()` was called with the call still in flight, or a call was made after `close()`.                                                                                                                 |
| `VINE_DATA_ONLY` | A function-valued argument or return value was found in the data graph — the vine is data-only in v1.                                                                                                        |
| `VINE_BAD_FRAME` | A frame couldn't be parsed, or an outbound frame couldn't be handed to the transport (the medium refused it — see [TRANSPORTS.md](TRANSPORTS.md)).                                                           |
| `VINE_NO_LEAF`   | A call named a path that isn't in the served surface. Re-validated serve-side on **every** call — a path learned from an earlier, wider surface (or invented) can't reach a leaf this serve doesn't publish. |
| `VINE_REMOTE`    | `.code` on a `VineRemoteError` for a remote application error that carried no `code` of its own — or one whose code was a reserved `VINE_*` value (see below).                                               |

Every one of these is a `VineError` instance, so `err instanceof VineError` is the general "this came from the vine itself" check, and `err.code === CODES.GONE` (etc.) is how you branch on which one.

```javascript
try {
	await hostApi.exts.pdfViewer.open("a.pdf");
} catch (err) {
	if (err instanceof VineError && err.code === CODES.GONE) {
		// the far side is dead — reconnect, or surface a "disconnected" state
	} else if (err instanceof VineRemoteError) {
		// the far side's OWN application code threw — err.name/.message/.code are its own
	} else {
		throw err; // not a vine error at all
	}
}
```

---

## `VineError`

```javascript
class VineError extends Error {
	code; // a CODES value — branch on this, never on .message
	// plus whatever `details` the throw site attached (typically path, callId, budgetMs)
}
```

`.name` is always `"VineError"`. Extra fields vary by code — a `VINE_BUDGET` carries `.path`, `.callId`, `.budgetMs`; a `VINE_NO_LEAF` carries `.path`; and so on. Treat `.code` as the stable contract and anything else as diagnostic detail.

---

## `VineRemoteError`

A failure the **far side's own application code** threw, re-thrown locally. It deliberately impersonates the original error — `.name` and `.message` are the remote's own, and so is `.code` when it had one, so an existing `err.code === "E_THING"` check written against the local version of that error keeps working across the boundary unmodified.

```javascript
class VineRemoteError extends VineError {
	name; // the REMOTE error's own name — NOT "VineRemoteError"
	code; // the remote's own .code, or CODES.REMOTE if it had none
	remoteCode; // the remote's .code, VERBATIM — including a reserved VINE_* one (see below)
	remoteStack; // the far side's stack, kept off .stack so the local trace stays local
}
```

Because `.name` is the _remote's_ name, don't use `.name` to detect a forwarded error — use `instanceof VineRemoteError` (or check for `.remoteStack`):

```javascript
try {
	await hostApi.exts.pdfViewer.open("missing.pdf");
} catch (err) {
	if (err instanceof VineRemoteError) {
		console.error(`far side threw ${err.name}: ${err.message}\n${err.remoteStack}`);
	}
}
```

### The one code that is never adopted from the wire: `VINE_*`

`.code` is adopted from the far side's error with a single, deliberate exception: **a remote `code` in the reserved `VINE_*` namespace is remapped to `VINE_REMOTE`**, and the far side's own spelling is kept on `.remoteCode`.

Without that remap, a far side — hostile, or merely running its own vine and forwarding a failure verbatim — could send `{ name: "VineError", code: "VINE_CLOSED" }` and the resulting local error would satisfy `err instanceof VineError && err.code === CODES.CLOSED`, the documented way to detect _this_ link closing, and drive a consumer's teardown path from **across the boundary**. A link-state code describes this link's own state; it can only ever be produced locally.

The remap is blind to which `VINE_*` code arrived — including ones the far side's own `serve()` legitimately produced, like `VINE_NO_LEAF` or `VINE_DATA_ONLY`. Read `.remoteCode` to see what the far side actually said; read `.code` to know it came from over there:

```javascript
try {
	await hostApi.exts.thing.doSomething();
} catch (err) {
	if (err instanceof VineRemoteError && err.code === CODES.REMOTE) {
		// err.remoteCode might be "E_SOMETHING", or it might be a VINE_* code the FAR side produced —
		// e.g. the far side's own serve() answered VINE_NO_LEAF because ITS surface changed underneath it
		console.log(err.remoteCode);
	}
}
```

---

## See also

- [CONFIGURATION.md](CONFIGURATION.md) — the `budgetMs`/`handshakeMs` options that determine when `VINE_BUDGET` fires.
- [TRANSPORTS.md](TRANSPORTS.md) — per-transport detail on what "the medium refuses this frame" looks like for each one (`VINE_BAD_FRAME`'s trigger).
- [DESIGN.md](DESIGN.md) — the normative frame protocol and the full send-failure classification table.
