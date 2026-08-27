/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/conformance-minimal.test.vitest.mjs
 *
 * The shared Channel conformance suite against Channel shapes none of the five built-in transports use
 * (all five are fully symmetric and declare `close`/`onClose`/`capabilities` on both ends), so this is
 * the only place the suite's own "this channel doesn't support X" skip branches are ever actually
 * driven — and the only place the harness's OWN promise to tolerate a partial implementation is
 * verified rather than assumed. `docs/DESIGN.md` makes `close`, `onClose` and `capabilities` all
 * independently optional on the Channel contract; a consumer-written transport is free to omit
 * whichever it cannot support.
 *
 * Two shapes:
 * - **minimal** — `send` + `onMessage` only, nothing else at all.
 * - **asymmetric** — both ends support `close()`, but only ONE side supports `onClose`.
 */
import { describe, it, expect } from "vitest";
import { channelConformance } from "../src/testing/conformance.mjs";

/**
 * Build one minimal endpoint: `send`/`onMessage` only. Delivery is asynchronous (a real boundary never
 * delivers synchronously inside `send()`) and a frame sent before a handler is registered is DROPPED —
 * an honest declaration of "no buffering" with no `capabilities` object to spell it out in.
 * @returns {{_peer: object|null, send: Function, onMessage: Function, _deliver: Function}} One endpoint.
 */
function makeMinimalEndpoint() {
	let handler = null;
	const endpoint = {
		_peer: null,
		send(message) {
			const peer = endpoint._peer;
			if (!peer) return;
			queueMicrotask(() => peer._deliver(message));
		},
		onMessage(fn) {
			handler = typeof fn === "function" ? fn : null;
		},
		_deliver(message) {
			try {
				handler?.(message);
			} catch {
				// Channel contract: handlers must never throw into the transport.
			}
		}
	};
	return endpoint;
}

channelConformance(
	"minimal (send + onMessage only — no close/onClose/capabilities)",
	() => {
		const a = makeMinimalEndpoint();
		const b = makeMinimalEndpoint();
		a._peer = b;
		b._peer = a;
		return [a, b];
	},
	{ describe, it, expect }
);

/**
 * Invoke `fn` with `arg` if it is a function, insulating the caller from anything it throws — the same
 * guarantee every built-in transport gives its own registered handlers.
 * @param {Function|null} fn - Handler to invoke, if any.
 * @param {unknown} arg - The argument to pass it.
 * @returns {void}
 */
function safeCall(fn, arg) {
	if (typeof fn !== "function") return;
	try {
		fn(arg);
	} catch {
		// Channel contract: handlers must never throw into the transport.
	}
}

/**
 * Build an ASYMMETRIC pair: both ends support `close()`, but only `a` supports `onClose` — `b` does
 * not. None of the five built-in transports are shaped like this (all are symmetric in what they
 * support), but `onClose` is independently optional per side on the Channel contract, and this is the
 * only shape that drives the suite's own "does the CLOSING end also support onClose" branch.
 * @returns {[object, object]} The two endpoints.
 */
function makeAsymmetricPair() {
	let aHandler = null;
	let aCloseHandler = null;
	let bHandler = null;
	let aClosed = false;
	let bClosed = false;

	const a = {
		capabilities: { structuredClone: true, codec: "none" },
		send(message) {
			if (aClosed) return;
			queueMicrotask(() => {
				if (!bClosed) safeCall(bHandler, message);
			});
		},
		onMessage(fn) {
			aHandler = typeof fn === "function" ? fn : null;
		},
		onClose(fn) {
			aCloseHandler = typeof fn === "function" ? fn : null;
		},
		close() {
			aClosed = true;
		}
	};
	const b = {
		capabilities: { structuredClone: true, codec: "none" },
		send(message) {
			if (bClosed) return;
			queueMicrotask(() => {
				if (!aClosed) safeCall(aHandler, message);
			});
		},
		onMessage(fn) {
			bHandler = typeof fn === "function" ? fn : null;
		},
		// Deliberately NO onClose — the one asymmetry under test.
		close() {
			if (bClosed) return;
			bClosed = true;
			queueMicrotask(() => safeCall(aCloseHandler, { reason: "peer-closed" }));
		}
	};
	return [a, b];
}

channelConformance("asymmetric (only one side supports onClose)", () => makeAsymmetricPair(), { describe, it, expect });
