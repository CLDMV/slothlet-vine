/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/serve.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:13-07:00 (1790968813)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { CODES, VineError } from "./lib/errors.mjs";
import {
	errorFrame,
	findContextFault,
	findFunctionArg,
	isPlainObject,
	isSafePath,
	parseFrame,
	resultFrame,
	surfaceFrame
} from "./lib/frame.mjs";
import { createEventForwarder } from "./lib/events.mjs";
import { assertApi, assertChannel } from "./lib/link.mjs";
import { assertPrincipalSupport, assertScopeSupport, bindPrincipal, gate } from "./lib/principal.mjs";

/**
 * Serve this instance's leaves to the far side of `channel`.
 *
 * **Deviation from `docs/DESIGN.md`, stated plainly:** the design sketch calls this without `await`.
 * It cannot be synchronous — the surface is read from the loader's records and
 * `api.slothlet.api.leaves()` is async — so `serve` returns a Promise for the documented
 * `{ leaves, close }` object. Everything else matches the sketch; `await` the call.
 *
 * @param {object} api - The local slothlet instance (the object `slothlet()` returned).
 * @param {import("./index.mjs").Channel} channel - The transport seam.
 * @param {object} [options]
 * @param {string[]} [options.paths] - Dotted prefixes to serve. A leaf is served when it equals a
 *   prefix or sits under it. Omit for every callable leaf of the base load. An ARRAY that yields no
 *   usable prefix (`[]`, `["", 7]`) serves NOTHING — a filter that cannot be satisfied is not the
 *   same as no filter, and the fail-closed reading is the safe one for a surface. A non-array value
 *   is ignored.
 * @param {string[]} [options.modules] - Additional moduleIDs (or mount endpoints) whose leaves are
 *   unioned into the surface — the way to serve runtime `api.slothlet.api.add()` mounts, which
 *   `leaves(".")` does not cover. Unknown ids are skipped rather than fatal.
 * @param {number} [options.budgetMs=30000] - Settle budget for THIS end's own event subscriptions to
 *   the far instance (a `sub-ack` that never arrives settles `VINE_BUDGET`). Not used for calls — a
 *   serve answers calls, it does not make them.
 * @param {string|{ path: string, context?: object }|(() => string|{ path: string, context?: object })} [options.principal] -
 *   The **channel principal** (#33): the caller identity this serve binds to the channel, obtained by
 *   the host from the transport's own authentication (a ws upgrade, a token) — never from a frame.
 *   With one set, EVERY `call` frame is judged by slothlet's rules engine as `principal.path` calling
 *   the leaf with the frame's `args`, inside a context scope carrying `principal.context`
 *   (write-protected), and a denial is answered `VINE_DENIED` without the leaf ever running; EVERY
 *   `sub` frame is resolved as the principal, and the far side's own `subscriberPath` can only narrow
 *   that level (`null` no longer means "host"). A string is `{ path }`; a function is called
 *   synchronously per frame and may answer either form (a throw or junk denies that frame). Requires
 *   the instance's permission system to be enabled, `api.slothlet.context.scope` to work, and
 *   `api.slothlet.permissions.global.checkCall` (@cldmv/slothlet ≥ 3.22.0) —
 *   each checked here, fail-closed, as a `TypeError`. Omit it for a trusted transport (a worker you
 *   spawned, a process you forked): nothing changes, byte for byte. See `docs/PERMISSIONS.md`.
 * @param {(requested: object, call: { principal: Readonly<{ path: string, context?: object }>|null, path: string, args: unknown[] }) => object|false|null|undefined|Promise<object|false|null|undefined>} [options.context] -
 *   The host check for a per-call **requested context** (#79): a data-only plain object the far side
 *   attaches to one `call` frame (grow-side `link.with(context, fn)` or `grow({ context })`) — a request,
 *   never identity. Called only for frames that carry one, after the principal is resolved and before
 *   the permission gate, with a private copy of the request, the resolved principal (`null` without
 *   one), the path and the frame's arguments. It ACCEPTS by answering a plain object — the request
 *   itself, or a narrowed or changed one — and REFUSES by answering anything else (`false`, `null`, a
 *   non-plain or function-bearing object) or by throwing/rejecting; a refusal is `VINE_CONTEXT` and
 *   the leaf never runs. May be async. The accepted keys are merged into the call's context scope
 *   UNDER the principal's (a principal key always wins) and every key is write-protected, so
 *   `checkCall`, rule conditions, `requires`-principals, `around` and the leaf all see it and none
 *   can rewrite it. **Without this option a frame that carries a requested context is refused**
 *   (`VINE_CONTEXT`), so a client is never silently unscoped; with it, the `surface` frame advertises
 *   `context: true`, which a grow needs before it will send one. Requires a working
 *   `api.slothlet.context.scope` (checked at setup as a `TypeError`); a principal is NOT required.
 * @param {(call: { callId: string, path: string, args: unknown[], principal: Readonly<{ path: string, context?: object }>|null, context: object|null, invoke: () => Promise<unknown> }) => unknown} [options.around] -
 *   A per-call wrapper (#51) for the host's own scope around each ACCEPTED call: a transaction, a
 *   deadline, an audit record. It runs after every check the vine makes — the served-surface check,
 *   the principal gate (inside the principal's context scope), and the args data-only check — so it
 *   never sees a frame the vine would have refused. `invoke()` runs the gated leaf with the frame's
 *   arguments; it takes no arguments of its own (the call that was authorized is the call that runs)
 *   and may be called more than once (a transaction retried on a write conflict), each time with a
 *   fresh copy of the original arguments. `args` is a private copy for inspection — changing it
 *   changes nothing `invoke()` passes. `principal` is the principal resolved for THIS frame, or `null`
 *   on a serve without one; `context` is the requested context the `context` check accepted for this
 *   call (a private copy), or `null` when the frame carried none. Whatever `around` returns is the call's result (the data-only return
 *   check applies to it, exactly as to a leaf's own value); whatever it throws is the call's error.
 *   Identity is not established here — that is `principal`'s job; `around` decorates a call already
 *   authorized. With `around` set, the call's arguments must be structured-cloneable (they already
 *   must be to cross any real transport).
 * @returns {Promise<{ leaves: string[], excluded: string[], principal: object|Function|null, event: { on: Function, once: Function }, close: () => void }>}
 *   The live serving handle. `leaves` is what the far side is offered; `excluded` is every CALLABLE leaf that was
 *   dropped on the way there — refused by {@link isSafePath} or filtered out by `paths` — so a leaf
 *   that quietly failed to appear is visible rather than a mystery. (Namespace and data records are
 *   not "dropped": they were never candidates for a callable surface.) `principal` is the frozen,
 *   normalized `{ path, context? }` this serve bound (the resolver itself for the function form), or
 *   `null` when none was given.
 * @throws {TypeError} When `api` is not a slothlet instance or `channel` is not a Channel, when
 *   `around` or `context` is given and is not a function, when `context` is given and the instance's
 *   `context.scope` does not work — or, with a `principal`, when it is malformed or the
 *   instance cannot enforce it (see `options.principal`).
 *
 * @example
 * const serving = await serve(api, channel, { paths: ["exts"] });
 * serving.leaves; // ["exts.pdfViewer.open", …]
 * serving.excluded; // ["math.add", …] — real leaves this serve chose not to publish
 * serving.close(); // stop answering (the channel itself is NOT torn down — see close())
 *
 * @example
 * // An authenticated socket: the transport authenticated the peer; serve() binds that identity.
 * const serving = await serve(api, createChannel(socket), {
 *   paths: ["host", "project"],
 *   principal: { path: "remote.renderer", context: { actor: { id: user.id, roles: user.roles } } }
 * });
 */
export async function serve(api, channel, options = {}) {
	assertChannel(channel, "serve");
	assertApi(api, "serve", ["leaves"]);
	// The channel principal (#33) — see lib/principal.mjs. Bound and precondition-checked BEFORE the
	// surface is read, so a serve that cannot enforce its principal never publishes anything.
	const principal = bindPrincipal(options.principal, "serve");
	if (principal) await assertPrincipalSupport(api, { calls: true, scope: true }, "serve");
	const around = options.around ?? null;
	if (around !== null && typeof around !== "function") {
		throw new TypeError("@cldmv/slothlet-vine: serve() around must be a function when given");
	}
	// The requested-context check (#79). Checked before the surface is read, like the principal: a
	// serve that cannot open a scope for an accepted context must not advertise that it accepts one.
	const contextCheck = options.context ?? null;
	if (contextCheck !== null && typeof contextCheck !== "function") {
		throw new TypeError("@cldmv/slothlet-vine: serve() context must be a function when given");
	}
	if (contextCheck !== null && !principal) await assertScopeSupport(api, "serve", "a context check");

	const { leaves, excluded } = await collectLeaves(api, options);
	const served = new Set(leaves);
	let closed = false;

	// Bidirectional event forwarding (see lib/events.mjs). This end holds BOTH halves: it serves far
	// subscriptions to this instance's events, AND can subscribe to the far instance's events through
	// the returned `event` surface. `budgetMs` — a grow-side concern for calls — is here the sub-ack
	// handshake budget for THIS end's own outgoing subscriptions.
	const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? Number(options.budgetMs) : 30_000;
	const events = createEventForwarder({ api, channel, budgetMs, principal, ended: () => (closed ? "closed" : null) });

	channel.onMessage((message) => {
		// The Channel contract forbids throwing into the transport, and this handler is the ONLY
		// thing standing between a malformed frame and the transport's own dispatch loop.
		try {
			if (closed) return;
			const frame = parseFrame(message);
			if (frame === null) return;
			if (frame.type === "call") void answer(frame);
			else if (frame.type === "sub" || frame.type === "unsub" || frame.type === "sub-ack" || frame.type === "event")
				events.handleFrame(frame);
		} catch {
			// parseFrame is total and answer()/events.handleFrame() never throw synchronously; this is
			// belt-and-braces.
		}
	});

	/**
	 * Invoke one call frame and send back exactly one terminal frame.
	 * @param {{ callId: string, path: string, args: unknown[] }} frame - The parsed call.
	 * @returns {Promise<void>} Resolves once a terminal frame has been attempted.
	 */
	async function answer(frame) {
		const { callId, path, args } = frame;
		try {
			// NEVER trust the wire: the path is re-validated against the served set on every call, so
			// a peer that learned a path from an earlier, wider surface (or invented one) cannot reach
			// a leaf this serve does not publish. This is the OUTER boundary and comes before the
			// principal gate on purpose: the surface filter is already public in the `surface` frame,
			// so "not served" leaks nothing, and an unauthorized principal's payload should never reach
			// a rule condition for a path that does not even exist here.
			if (!served.has(path)) {
				throw new VineError(CODES.NO_LEAF, `slothlet-vine: '${path}' is not in the served surface`, { path });
			}
			// With a principal: resolve it, open its context scope, ask the rules engine, and only then
			// run the ordinary pipeline — all inside the scope. Without one: the v1 trusted-transport
			// pipeline, unchanged (no gate, no scope, host standing).
			const value = principal
				? await answerAs(callId, path, args, frame.context)
				: frame.context !== undefined
					? await answerScoped(callId, path, args, frame.context)
					: await execute(callId, path, args, null, null);
			// Data-only cuts BOTH ways, and this is the half a grow side cannot enforce. Over a cloning
			// transport a returned function fails as an opaque DataCloneError; over a by-reference one
			// (loopback, same realm) it sails straight through and hands the caller a live closure over
			// this side's scope — the same call, two semantics, one of them a hole in the isolation the
			// vine exists to provide. Refused here, named, before anything is sent.
			const functionAt = findFunctionArg([value]);
			if (functionAt !== null) {
				const location = `value${functionAt.slice("arg[0]".length)}`;
				throw new VineError(CODES.DATA_ONLY, `slothlet-vine: '${path}' returned a function at ${location} — the vine is data-only`, {
					path,
					location
				});
			}
			if (!closed) send(resultFrame(callId, value));
		} catch (err) {
			if (!closed) send(errorFrame(callId, err));
		}
	}

	/**
	 * The per-call pipeline that runs once a call is ACCEPTED — after `NO_LEAF` and, with a principal,
	 * after the gate and inside the principal's scope: the args data-only check, then the invocation,
	 * wrapped by the host's `around` (#51) when one was given.
	 *
	 * `around` never sees a frame the vine would have refused, and it cannot widen what the rules
	 * allowed: it runs AFTER the gate, and its `invoke()` is fixed to the gated path and to a private
	 * snapshot of the gated arguments. The snapshot matters — the parsed frame's `args` is a fresh array
	 * but its elements are shared, so handing `around` the very objects `invoke()` would pass would let
	 * it (or a bug in it) mutate a nested argument after the rules engine judged it. So `around` gets
	 * its own copy to inspect, and every `invoke()` gets a fresh copy of the pristine snapshot, which
	 * also gives a retried invocation the arguments as they arrived rather than as a failed first
	 * attempt left them. Whatever `around` returns flows into the return-value check in {@link answer}
	 * exactly like a leaf's own value.
	 * @param {string} callId - The call's correlation id (handed to `around`).
	 * @param {string} path - The served leaf path.
	 * @param {unknown[]} args - The call's arguments (the parsed frame's fresh copy).
	 * @param {Readonly<{ path: string, context?: object }>|null} who - The principal resolved for this
	 *   frame, or `null` on a serve without one (handed to `around`).
	 * @param {object|null} accepted - The requested context the check accepted (#79), or `null` (handed
	 *   to `around` as a private copy).
	 * @returns {Promise<unknown>} The leaf's (or `around`'s) resolved value.
	 */
	async function execute(callId, path, args, who, accepted) {
		// The grow-side stub already refuses a function-bearing argument before it ever sends a
		// frame (see grow.mjs), but that enforcement only covers frames built by a legitimate
		// vineStub call. Nothing stops a frame constructed directly against the channel — possible
		// only over a by-reference transport like loopback, where no serialization step would
		// otherwise refuse a live function reference — from reaching here with a function hiding in
		// `args`. Re-check before invoking, the same defense-in-depth reasoning as the return-value
		// check in answer().
		const argFunctionAt = findFunctionArg(args);
		if (argFunctionAt !== null) {
			throw new VineError(
				CODES.DATA_ONLY,
				`slothlet-vine: '${path}' was called with a function at ${argFunctionAt} — the vine is data-only`,
				{
					path,
					location: argFunctionAt
				}
			);
		}
		if (around === null) return await invoke(api, path, args);
		const snapshot = copyArgs(path, args);
		return await around({
			callId,
			path,
			args: copyArgs(path, snapshot),
			principal: who,
			context: accepted === null ? null : structuredClone(accepted),
			invoke: () => invoke(api, path, copyArgs(path, snapshot))
		});
	}

	/**
	 * Answer one accepted call AS the channel principal (#33): resolve the principal for this frame,
	 * open a context scope carrying its `context` with every top-level key write-protected (the actor
	 * a leaf reads is the actor the host bound; nothing downstream can reassign it, nested fields
	 * included), ask slothlet's rules engine through {@link gate}, and only on a `true` run
	 * {@link execute} — inside the SAME scope, so conditional rules, `requires`-principals and the leaf
	 * all see one context. The gate comes BEFORE the args data-only scan because rule conditions are
	 * user code that receives `args`: an unauthorized principal's payload should never reach one.
	 *
	 * Fail-closed at every step: an unresolvable principal, a scope that throws (or never runs `fn`),
	 * and a gate that answers anything but `true` are each `VINE_DENIED` — the leaf is never invoked
	 * outside the scope or without a verdict. Host standing INSIDE the scope is unavoidable and fine:
	 * `Reflect.apply(leaf, …)` still enters the leaf without a slothlet gate of its own — which is
	 * exactly why this gate sits in front of it — and once inside, the leaf's own `self.*` calls are
	 * gated as the leaf's module, as for any host-initiated call.
	 *
	 * A requested context (#79) is judged between the two: {@link accept} runs once the principal is
	 * resolved and before the scope opens, and the keys it accepts are merged into the scope UNDER the
	 * principal's — a principal key always wins — and write-protected with them.
	 * @param {string} callId - The call's correlation id.
	 * @param {string} path - The served leaf path.
	 * @param {unknown[]} args - The call's arguments.
	 * @param {unknown} requested - The frame's requested context, or `undefined` when it carried none.
	 * @returns {Promise<unknown>} The leaf's resolved value.
	 * @throws {VineError} `VINE_DENIED` when the principal may not call `path` (or could not be judged);
	 *   `VINE_CONTEXT` when its requested context was refused; `VINE_DATA_ONLY` for one that is not data.
	 */
	async function answerAs(callId, path, args, requested) {
		const who = principal.resolve();
		if (!who) throw denied(path, null);
		const accepted = requested === undefined ? null : await accept(requested, who, path, args);
		const context = accepted === null ? (who.context ?? {}) : { ...accepted, ...(who.context ?? {}) };
		return await scoped(context, path, who, async () => {
			if (!(await gate(api, who, path, args))) throw denied(path, who);
			return await execute(callId, path, args, who, accepted);
		});
	}

	/**
	 * Answer one call that carries a requested context on a serve WITHOUT a principal (#79): judge the
	 * request through {@link accept}, then run the ordinary pipeline inside a scope holding the
	 * accepted keys, write-protected. There is no gate to run — the transport is trusted — but the
	 * request is still the host's to accept.
	 * @param {string} callId - The call's correlation id.
	 * @param {string} path - The served leaf path.
	 * @param {unknown[]} args - The call's arguments.
	 * @param {unknown} requested - The frame's requested context.
	 * @returns {Promise<unknown>} The leaf's resolved value.
	 * @throws {VineError} `VINE_CONTEXT` / `VINE_DATA_ONLY` as for {@link accept}; `VINE_DENIED` when
	 *   the scope cannot be opened.
	 */
	async function answerScoped(callId, path, args, requested) {
		const accepted = await accept(requested, null, path, args);
		return await scoped(accepted, path, null, () => execute(callId, path, args, null, accepted));
	}

	/**
	 * Run `body` inside a context scope carrying `context`, every top-level key write-protected. Fail
	 * closed: a scope that throws or never runs `body` is `VINE_DENIED` — nothing runs outside the
	 * scope the call was accepted into. `body`'s own outcome (value or error) is passed through.
	 * @param {object} context - The scope's context (the principal's, the accepted request's, or both).
	 * @param {string} path - The served leaf path, for the denial.
	 * @param {{ path: string }|null} who - The principal, for the denial's serve-side detail.
	 * @param {() => Promise<unknown>} body - The gated pipeline.
	 * @returns {Promise<unknown>} `body`'s value.
	 */
	async function scoped(context, path, who, body) {
		/** @type {{ value: unknown }|{ err: unknown }|null} Set ONLY by `fn` — null means the scope never ran it. */
		let outcome = null;
		try {
			await api.slothlet.context.scope({
				context,
				protect: Object.keys(context),
				fn: async () => {
					try {
						outcome = { value: await body() };
					} catch (err) {
						outcome = { err };
					}
				}
			});
		} catch {
			// The scope itself failed (SCOPE_DISABLED, CONTEXT_KEY_OWNED, …). `fn` cannot have thrown —
			// it settles `outcome` instead — so nothing of the call's own is lost; it is simply denied.
		}
		if (outcome === null) throw denied(path, who);
		if ("err" in outcome) throw outcome.err;
		return outcome.value;
	}

	/**
	 * Judge one requested context (#79). In order: it must be data (`VINE_DATA_ONLY` — the same rules
	 * as a call's arguments, plus a plain-object shape); a serve without a `context` check refuses it
	 * (`VINE_CONTEXT` — a client must never believe a call is scoped when it is not); the host's check
	 * gets a private copy and must answer a plain, data-only object, anything else — `false`, `null`, a
	 * throw, a rejection, junk — being a refusal (`VINE_CONTEXT`). The accepted answer is copied, so the
	 * host's own object is never shared with the scope.
	 * @param {unknown} requested - The frame's requested context (untrusted).
	 * @param {Readonly<{ path: string, context?: object }>|null} who - The resolved principal, or `null`.
	 * @param {string} path - The served leaf path.
	 * @param {unknown[]} args - The call's arguments (as a rule condition would receive them).
	 * @returns {Promise<object>} The accepted context.
	 * @throws {VineError} `VINE_DATA_ONLY` or `VINE_CONTEXT`.
	 */
	async function accept(requested, who, path, args) {
		const fault = findContextFault(requested);
		if (fault !== null) {
			throw new VineError(
				CODES.DATA_ONLY,
				`slothlet-vine: '${path}' was called with a requested context that is not data (at ${fault}) — the vine is data-only`,
				{ path, location: fault }
			);
		}
		const refused = new VineError(CODES.CONTEXT, `slothlet-vine: the requested context for '${path}' is not accepted on this channel`, {
			path,
			principal: who ? who.path : null
		});
		if (contextCheck === null) throw refused;
		let answer;
		try {
			answer = await contextCheck(structuredClone(requested), { principal: who, path, args: [...args] });
		} catch {
			throw refused;
		}
		if (!isPlainObject(answer) || findContextFault(answer) !== null) throw refused;
		return structuredClone(answer);
	}

	/**
	 * Build the `VINE_DENIED` error for one refused call. The message names the PATH only; the
	 * principal is attached as serve-side detail and never crosses (`toWire` sends `name` / `message` /
	 * `code` / `stack` — see lib/errors.mjs), so a peer learns that it may not, not who it was judged as.
	 * @param {string} path - The refused path.
	 * @param {{ path: string }|null} who - The resolved principal, or `null` when it could not be resolved.
	 * @returns {VineError} The error to answer with.
	 */
	function denied(path, who) {
		return new VineError(CODES.DENIED, `slothlet-vine: '${path}' is not permitted for this channel`, {
			path,
			principal: who ? who.path : null
		});
	}

	/**
	 * Hand a frame to the transport, degrading a send failure (an un-cloneable return value, a socket
	 * that just died) into an error frame rather than an unhandled rejection. If the substitute also
	 * fails the far side's budget timer settles the call — which is exactly why a budget is mandatory.
	 * @param {object} frame - The frame to send.
	 * @returns {void}
	 */
	function send(frame) {
		try {
			channel.send(frame);
		} catch (err) {
			// A surface frame that cannot be sent has no callId to answer on, and an error frame that
			// cannot be sent cannot be replaced by another error frame.
			if (frame.type === "error" || typeof frame.callId !== "string") return;
			try {
				channel.send(
					errorFrame(
						frame.callId,
						new VineError(CODES.BAD_FRAME, `slothlet-vine: result could not be sent: ${err?.message ?? String(err)}`)
					)
				);
			} catch {
				// The channel is unusable. The grow side settles this call on its budget.
			}
		}
	}

	// Publish the surface immediately. v1 sends it exactly once: a grow mounts from one manifest and
	// re-publication is not a re-mount. Sent AFTER the receive handler is registered so a far side
	// that answers instantly cannot race an unregistered channel.
	send(surfaceFrame(leaves, { context: contextCheck !== null }));

	return {
		leaves,
		excluded,
		/**
		 * The channel principal this serve bound (see `options.principal`): the frozen, normalized
		 * `{ path, context? }` for the string / object forms, the host's own resolver for the function
		 * form, or `null` for a trusted-transport serve. Diagnostics, like `excluded`.
		 * @type {Readonly<{ path: string, context?: object }>|Function|null}
		 */
		principal: principal ? principal.declared : null,
		/**
		 * Event-forwarding surface, identical to {@link import("./grow.mjs").grow}'s — this end can
		 * subscribe to the FAR instance's events (the far side resolves the level and sends only what it
		 * permits). Async because the granted level is resolved across the boundary. `on(event, listener,
		 * { once })` / `once(event, listener)` return `Promise<{ level, off }>`.
		 * @type {{ on: Function, once: Function }}
		 */
		event: {
			on: (eventName, listener, options = {}) => events.subscribe(eventName, listener, options?.once === true),
			once: (eventName, listener) => events.subscribe(eventName, listener, true)
		},
		/**
		 * Stop answering. This detaches the vine ONLY — it deliberately does not call
		 * `channel.close()`, because the transport is owned by whoever created it (one channel may
		 * outlive one serving, and a Channel handed in by a consumer is not ours to tear down).
		 * Close the channel yourself when you want the boundary gone.
		 *
		 * The receive closure is released too (mirrors `grow()`'s `close()`): it captures `api`,
		 * `served`, and `excluded`, and the channel may well outlive this serving, so nothing should
		 * hold those references once there is nothing left to answer.
		 * @returns {void}
		 */
		close() {
			closed = true;
			// Drop every forwarded subscription (both halves) and tell the far side to release ours.
			events.teardown({ sendUnsubs: true });
			try {
				channel.onMessage(() => {});
			} catch {
				// A transport that refuses a re-registration after close keeps the old handler; harmless.
			}
		}
	};
}

/**
 * Read the callable surface from the instance's own records and apply both filters: the caller's
 * `paths` prefixes and the unconditional exclusions (`slothlet.**`, the instance teardown handles,
 * and anything {@link isSafePath} refuses).
 *
 * Both halves of that decision are returned. A silently-shorter surface is one of the harder things
 * to debug from the far side of a boundary — "the leaf is right there and the vine says it isn't" —
 * so every callable record this function declines to publish is reported on `excluded`, whichever
 * filter declined it.
 * @param {object} api - The slothlet instance.
 * @param {{ paths?: string[], modules?: string[] }} options - Serve options.
 * @returns {Promise<{ leaves: string[], excluded: string[] }>} Sorted, de-duplicated dotted leaf
 *   paths: the published surface, and the callable leaves dropped by a filter or the safety guard.
 */
async function collectLeaves(api, options) {
	const prefixes = Array.isArray(options.paths) ? options.paths.filter((p) => typeof p === "string" && p.length > 0) : null;
	const found = new Set();
	const dropped = new Set();

	for (const key of [".", ...(Array.isArray(options.modules) ? options.modules : [])]) {
		let records;
		try {
			records = await api.slothlet.api.leaves(key, { details: true });
		} catch {
			// An unknown moduleID throws API_LEAVES_UNKNOWN_MODULE. Serving a surface is not the place
			// to be fatal about one stale id in a list — skip it and serve the rest.
			continue;
		}
		if (!Array.isArray(records)) continue;
		for (const record of records) {
			if (record?.kind !== "function") continue;
			const path = record.path;
			// `slothlet.**` is excluded by slothlet itself for `leaves(".")`, but a named module could
			// in principle report anything, and isSafePath's UNSAFE_SEGMENTS covers the control plane.
			if (!isSafePath(path)) {
				dropped.add(typeof path === "string" ? path : String(path));
				continue;
			}
			if (prefixes && !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) {
				dropped.add(path);
				continue;
			}
			found.add(path);
		}
	}
	// A path reachable through one module key and filtered out under another is SERVED — the union
	// wins, and it is not also reported as excluded.
	return { leaves: [...found].sort(), excluded: [...dropped].filter((path) => !found.has(path)).sort() };
}

/**
 * A structured clone of a call's (already data-only-checked) arguments, for the `around` wrapper's
 * private snapshot and views (see `execute()` in {@link serve}). Anything structured clone refuses —
 * a Symbol, a WeakMap — is not data either, and answers `VINE_DATA_ONLY` rather than an opaque
 * DataCloneError.
 * @param {string} path - The leaf path, for the error.
 * @param {unknown[]} args - Arguments to copy.
 * @returns {unknown[]} A deep copy.
 * @throws {VineError} `VINE_DATA_ONLY` when the arguments cannot be structured-cloned.
 */
function copyArgs(path, args) {
	try {
		return structuredClone(args);
	} catch (err) {
		throw new VineError(
			CODES.DATA_ONLY,
			`slothlet-vine: '${path}' was called with arguments that cannot be copied (${err?.message ?? String(err)}) — the vine is data-only`,
			{ path }
		);
	}
}

/**
 * Resolve a dotted path against the LIVE api and invoke it. The leaf is called as
 * `parent[last](...args)` — the same shape as an ordinary `api.math.add(1, 2)` — so `this` is the
 * namespace the leaf lives on, exactly as a local caller would produce.
 *
 * The dispatch is `Reflect.apply(leaf, parent, args)`, NOT `leaf.apply(parent, args)`, and that is
 * not a style choice. Probed on @cldmv/slothlet 3.14.0: merely READING `.apply` off a leaf
 * materializes it into the loader's records — `intl.café` is reported as `function` before the call
 * and as a `namespace` with a child `intl.café.apply` (`function`) after it. Serving a leaf would
 * therefore corrupt the record tree it was read from: a later `serve()` of the same instance would
 * publish `intl.café.apply` in place of `intl.café`, handing the far side `Function.prototype.apply`
 * bound to a real leaf. `Reflect.apply` reads no property and leaves the records untouched (also
 * verified) — and, incidentally, cannot be hijacked by a leaf that shadows `apply` with its own.
 * Reported as CLDMV/slothlet#304 and fixed by CLDMV/slothlet#307; `Reflect.apply` is kept regardless,
 * because it is the idiomatic this-arg + args-array dispatch AND shadow-proof — strictly better than
 * `leaf.apply` on a fixed slothlet too.
 * @param {object} api - The slothlet instance.
 * @param {string} path - Validated dotted path.
 * @param {unknown[]} args - Call arguments.
 * @returns {Promise<unknown>} The leaf's resolved value.
 * @throws {VineError} `VINE_NO_LEAF` when the path no longer resolves to a function.
 */
async function invoke(api, path, args) {
	const segments = path.split(".");
	const last = segments.pop();
	let parent = api;
	for (const segment of segments) {
		parent = parent?.[segment];
		if (parent === null || (typeof parent !== "object" && typeof parent !== "function")) {
			throw new VineError(CODES.NO_LEAF, `slothlet-vine: '${path}' no longer resolves on the served instance`, { path });
		}
	}
	const leaf = parent?.[last];
	if (typeof leaf !== "function") {
		throw new VineError(CODES.NO_LEAF, `slothlet-vine: '${path}' is not a callable leaf on the served instance`, { path });
	}
	return await Reflect.apply(leaf, parent, args);
}
