/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/process.mjs
 *
 * The node `child_process` IPC transport — a Channel implementation over a forked child's IPC channel.
 * It has TWO endpoints, one per side of the boundary, and each side wraps a different object:
 *
 * - **Parent** — {@link createChannel}`(child)` wraps a `ChildProcess` returned by `fork(...)`. It
 *   sends with `child.send(frame)`, receives on `child.on("message", …)`, and detects the child's
 *   death on `child.on("exit"|"disconnect"|"error", …)` — real death detection, not a heartbeat.
 * - **Child** — {@link createParentChannel}`()` wraps the child's own `process` global. It sends with
 *   `process.send(frame)`, receives on `process.on("message", …)`, and detects the parent going away
 *   on `process.on("disconnect", …)`.
 *
 * A channel is DIRECTIONAL (one serve end, one grow end); a forked child gives you exactly the pair
 * you need — grow on the parent over `createChannel(child)`, serve in the child over
 * `createParentChannel()`.
 *
 * ## Serialization — fork with `{ serialization: "advanced" }`
 *
 * Node IPC has two serialization modes. The default, `"json"`, round-trips a frame through
 * `JSON.stringify`/`JSON.parse`, which SILENTLY DEGRADES the structured-clone types: a `Date` becomes
 * an ISO string, a `Map`/`Set` becomes `{}`, a `Buffer` becomes `{ type: "Buffer", data: [...] }`.
 * `"advanced"` uses the V8 structured-clone serializer, which preserves all of those with fidelity —
 * so a consumer that forwards `Date`/`Map`/`Set`/`Buffer` payloads MUST fork with
 * `fork(modulePath, args, { serialization: "advanced" })`, and both sides then agree.
 *
 * This transport DECLARES `capabilities.structuredClone: true` because that is the mode it is meant to
 * run under and the one the e2e exercises. The honest caveat: the transport cannot force the far
 * side's fork options, so under the DEFAULT `"json"` serialization that guarantee does not hold. In
 * vine v1 the wire frames are plain JSON-safe objects (strings, numbers, arrays, nested plain
 * objects), so `"json"` still works for the protocol itself — `"advanced"` is the recommended mode,
 * required only once a leaf's arguments or return value carry a structured-clone type. `codec: "none"`
 * either way: the medium clones for us, so this module never encodes/decodes frames itself.
 *
 * ## Ownership
 *
 * The parent's `close()` detaches its listeners and, if the child is still connected, calls
 * `child.disconnect()` — it does NOT `child.kill()`. Whoever forked the child owns its lifecycle; a
 * transport tearing the process down would be reaching past its boundary. Death detection stays live
 * regardless: a killed or crashed child surfaces on `onClose` via `exit`/`disconnect`/`error`. The
 * child's `close()` detaches its listeners and leaves the IPC channel alone for the same reason — the
 * parent owns the connection, and the parent already learns of the child's exit on its own `exit`
 * event, so the child need not disconnect itself.
 */

/**
 * Wrap a forked `ChildProcess` (parent side of the boundary). Send/receive ride the child's IPC
 * channel; `onClose` fires the first time the child dies or disconnects.
 *
 * @param {import("node:child_process").ChildProcess} child - The process returned by `fork(...)`.
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `child` is not a ChildProcess-shaped object (no `send`/`on`).
 *
 * @example
 * import { fork } from "node:child_process";
 * import { grow } from "@cldmv/slothlet-vine";
 * import { createChannel } from "@cldmv/slothlet-vine/transport/process";
 *
 * const child = fork("./serve-child.mjs", [], { serialization: "advanced" });
 * const link = await grow(hostApi, createChannel(child));
 * // …
 * await link.close();     // unmounts the stubs (does NOT close the channel)
 * child.kill();           // the parent owns the child's lifecycle
 */
export function createChannel(child) {
	if (child === null || typeof child !== "object" || typeof child.send !== "function" || typeof child.on !== "function") {
		throw new TypeError(
			"@cldmv/slothlet-vine: transport/process createChannel(child) needs a ChildProcess from fork() — an object with send() and on()"
		);
	}
	return makeEndpoint(child, "parent");
}

/**
 * Wrap the child's own `process` (child side of the boundary). Send/receive ride the process's IPC
 * channel to its parent; `onClose` fires when the parent disconnects (or the channel otherwise
 * closes). Named for what it connects TO — the parent — so a reader on the child side is not left
 * guessing which end this is.
 *
 * `proc` defaults to the live `process` and is the object a real child wraps; it is a parameter only
 * so the endpoint can be driven against a fake in tests without attaching to the real IPC channel.
 * Production code calls it with no arguments.
 *
 * @param {NodeJS.Process|object} [proc=process] - The process to wrap (defaults to the current one).
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `proc` has no `send` (not forked with an IPC channel).
 *
 * @example
 * // serve-child.mjs — the file passed to fork()
 * import slothlet from "@cldmv/slothlet";
 * import { serve } from "@cldmv/slothlet-vine";
 * import { createParentChannel } from "@cldmv/slothlet-vine/transport/process";
 *
 * const api = await slothlet({ base: "./api" });
 * await serve(api, createParentChannel());
 */
export function createParentChannel(proc = process) {
	if (proc === null || typeof proc !== "object" || typeof proc.send !== "function" || typeof proc.on !== "function") {
		throw new TypeError(
			"@cldmv/slothlet-vine: transport/process createParentChannel() must run in a process forked with an IPC channel (process.send is undefined otherwise)"
		);
	}
	return makeEndpoint(proc, "child");
}

/**
 * Build one IPC endpoint over `target`. The two sides differ only in which events signal far-side
 * death and whether `close()` disconnects: the parent watches `exit`/`disconnect`/`error` and
 * disconnects a still-connected child on close; the child watches `disconnect` and leaves the channel
 * to the parent (see the ownership note in the module header).
 *
 * The receive listener is attached NOW, at construction, not lazily in `onMessage`. On the parent that
 * is immediately after `fork()`, before the child can emit anything, so no early frame is lost to a
 * missing listener; frames that nonetheless arrive before `onMessage` registers a handler are dropped
 * (`buffersUntilHandler: false`) rather than queued.
 *
 * @param {object} target - A `ChildProcess` (parent) or `process` (child).
 * @param {"parent"|"child"} side - Which end this is.
 * @returns {object} The Channel.
 */
function makeEndpoint(target, side) {
	const isParent = side === "parent";

	/** @type {((message: object) => void)|null} */
	let handler = null;
	/** @type {((info?: object) => void)|null} */
	let onCloseHandler = null;
	let closed = false;
	let deathFired = false;

	/**
	 * Fire the far-side-death/closure handler at most once. A send that fails on a dead channel routes
	 * here too, so a caller that only ever `send`s still learns the link is gone.
	 * @param {object} [info] - Why the far side is gone (`reason`, and `code`/`signal`/`error` when known).
	 * @returns {void}
	 */
	function fireClose(info) {
		if (deathFired) return;
		deathFired = true;
		if (typeof onCloseHandler !== "function") return;
		try {
			onCloseHandler(info);
		} catch {
			// Channel contract: a consumer handler must never surface as a transport fault.
		}
	}

	/**
	 * Dispatch one inbound frame to the registered handler. Frames arriving before a handler exists, or
	 * after a local `close()`, are dropped — the core tolerates a dropped post-close frame, and this
	 * transport declares it does not buffer pre-handler.
	 * @param {object} message - The frame.
	 * @returns {void}
	 */
	function onMessageListener(message) {
		if (closed || typeof handler !== "function") return;
		try {
			handler(message);
		} catch {
			// Channel contract: handlers never throw into the transport.
		}
	}

	/** @returns {void} */
	function onExit(code, signal) {
		fireClose({ reason: "exit", code, signal });
	}
	/** @returns {void} */
	function onDisconnect() {
		fireClose({ reason: "disconnect" });
	}
	/** @param {Error} err @returns {void} */
	function onError(err) {
		fireClose({ reason: "error", error: err });
	}

	target.on("message", onMessageListener);
	target.on("disconnect", onDisconnect);
	if (isParent) {
		target.on("exit", onExit);
		// An 'error' listener also keeps a spawn/kill/send failure from throwing as an unhandled 'error'.
		target.on("error", onError);
	}

	/**
	 * Remove one listener from `target`, tolerating a target that doesn't implement `off`/
	 * `removeListener` at all, or whose removal throws. `target` is validated only for `send`/`on`
	 * (see {@link createChannel}/{@link createParentChannel} — `proc` is explicitly documented as
	 * test-double-friendly), so a minimal fake lacking either must not crash `close()`, and one bad
	 * removal must not skip the rest.
	 * @param {string} event - The event name.
	 * @param {Function} listener - The listener to remove.
	 * @returns {void}
	 */
	function off(event, listener) {
		try {
			const remove =
				typeof target.off === "function" ? target.off : typeof target.removeListener === "function" ? target.removeListener : null;
			if (remove) remove.call(target, event, listener);
		} catch {
			// Best effort: close() must never throw because the far side's object is uncooperative.
		}
	}

	/**
	 * Detach every listener this endpoint attached. Idempotent in practice (removing an absent
	 * listener is a no-op).
	 * @returns {void}
	 */
	function detach() {
		off("message", onMessageListener);
		off("disconnect", onDisconnect);
		if (isParent) {
			off("exit", onExit);
			off("error", onError);
		}
	}

	return {
		capabilities: { structuredClone: true, codec: "none", buffersUntilHandler: false },

		/**
		 * Hand one frame to the IPC channel. A `child.send` failure has TWO distinct causes and this
		 * transport keeps them apart — conflating them was the defect this classification fixes:
		 *
		 * - **The channel is DEAD** (`ERR_IPC_CHANNEL_CLOSED`/`EPIPE`/…, or `connected === false`, or an
		 *   asynchronous delivery error reported through the callback). That is link death: `fireClose`,
		 *   the same signal a real `exit` produces, so a caller that only ever `send`s still learns the
		 *   link is gone. Not thrown out of the transport — the core requires a frame crossing a close to
		 *   be tolerated.
		 * - **The V8 serializer REFUSED this frame** (an un-cloneable argument the data-only scan cannot
		 *   see — a `Symbol`, a value hiding a function). `child.send` throws that SYNCHRONOUSLY with no
		 *   dead-channel code. It is a PER-CALL fault, not link death, so the throw is RE-RAISED: the
		 *   core's send wrapper catches it and settles just that one call `VINE_BAD_FRAME` while the link
		 *   and every other in-flight call stay alive.
		 *
		 * Serialization refusals surface synchronously (here), so the async callback path is only ever a
		 * channel-delivery failure — always treated as death.
		 * @param {object} message - The frame.
		 * @returns {void}
		 * @throws {Error} Re-raises a synchronous serialization refusal so the core settles that call
		 *   `VINE_BAD_FRAME`; a dead-channel throw is caught here and surfaced through `onClose` instead.
		 */
		send(message) {
			if (closed) return;
			if (target.connected === false) {
				fireClose({ reason: "disconnect" });
				return;
			}
			try {
				target.send(message, (err) => {
					// Reached only asynchronously, for a delivery failure on a channel that closed under us
					// (a serialization refusal is the synchronous throw handled below, never a callback). So
					// a callback error is a dead channel: report it as death.
					if (err) fireClose({ reason: "error", error: err });
				});
			} catch (err) {
				if (isDeadChannelError(err)) {
					fireClose({ reason: "error", error: err });
				} else {
					// A serialization refusal — per-call, not link death. Let the core settle VINE_BAD_FRAME.
					throw err;
				}
			}
		},

		/**
		 * Register the (single) receive handler; a later registration replaces the earlier one.
		 * @param {(message: object) => void} fn - The receive handler.
		 * @returns {void}
		 */
		onMessage(fn) {
			handler = typeof fn === "function" ? fn : null;
		},

		/**
		 * Register the (single) far-side-death/closure handler; a later registration replaces the
		 * earlier one.
		 * @param {(info?: object) => void} fn - The close handler.
		 * @returns {void}
		 */
		onClose(fn) {
			onCloseHandler = typeof fn === "function" ? fn : null;
		},

		/**
		 * Tear this end down: detach the listeners and release the handler closures, so no further frame
		 * or death event dispatches and nothing consumer-registered stays reachable through this channel.
		 * On the PARENT, additionally `child.disconnect()` a still-connected child to close the IPC channel —
		 * but never `child.kill()`, because whoever forked the child owns its lifecycle. On the CHILD,
		 * leave the channel to the parent (the parent already learns of the child's exit on its own
		 * side). Idempotent.
		 * @returns {void}
		 */
		close() {
			if (closed) return;
			closed = true;
			handler = null;
			onCloseHandler = null;
			detach();
			if (isParent) {
				try {
					if (target.connected) target.disconnect();
				} catch {
					// Already disconnected / never connected — nothing to tear down.
				}
			}
		}
	};
}

/** Node error codes that mean the IPC channel itself is gone — not a per-frame serialization refusal. @type {Set<string>} */
const DEAD_CHANNEL_CODES = new Set(["ERR_IPC_CHANNEL_CLOSED", "ERR_IPC_DISCONNECTED", "EPIPE", "ERR_STREAM_DESTROYED"]);

/**
 * Classify a synchronous `child.send` throw: is the channel dying, or is the serializer refusing this
 * one frame? A dead-channel code means link death (→ `onClose`); anything else — chiefly the code-less
 * `Error` the V8 serializer throws for an un-cloneable value — is a per-call refusal the caller must
 * re-raise so the core settles that call `VINE_BAD_FRAME`.
 * @param {unknown} err - The thrown error.
 * @returns {boolean} True when the error signals a dead IPC channel.
 */
function isDeadChannelError(err) {
	return err !== null && typeof err === "object" && typeof err.code === "string" && DEAD_CHANNEL_CODES.has(err.code);
}
