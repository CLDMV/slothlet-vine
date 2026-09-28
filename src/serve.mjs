/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/serve.mjs
 *
 * The serving end of a vine: publish this instance's callable leaves to the far side of a channel,
 * then answer `call` frames by invoking the real leaf.
 *
 * ## Where the surface comes from, and why
 *
 * `docs/DESIGN.md` allows either enumerating from the loader's records
 * (`api.slothlet.api.leaves`) or walking the live api object, and asks for the choice to be
 * documented. This implementation uses the RECORDS. Both options were probed against
 * @cldmv/slothlet 3.14.0:
 *
 * - **Walking the live object is wrong under `mode: "lazy"`.** An un-materialized namespace is a
 *   CALLABLE proxy with no own keys, so a walk of a lazy instance reports `deep` as a leaf and never
 *   sees `deep.tools.slow` at all. It also can't tell a namespace from a leaf without invoking
 *   materialization as a side effect of merely being served.
 * - **`leaves(".", { details: true })` is complete under lazy** (it settles the owned subtree and
 *   answers from the loader's records) and it labels every path `namespace` / `function` / `data`,
 *   so data leaves — `export const answer = 42` — are excluded from a CALLABLE surface for free.
 *   Verified: a lazy instance answered `["deep.nested.more.x", "deep.tools.slow", "math.add"]`.
 *
 * The one thing records cannot do is enumerate the WHOLE tree. `leaves(".")` covers the base load
 * only; runtime `api.slothlet.api.add()` mounts are module-scoped and there is no registry of
 * mounted moduleIDs to iterate (`api.slothlet.api.modules` is the module-DISCOVERY helper, not a
 * mount registry). That is what {@link serve}'s `modules` option is for: name the runtime mounts to
 * include and their leaves are unioned in, still from the records.
 *
 * A second records quirk worth knowing: a mount made with the BARE-FUNCTION form
 * (`add(path, fn, { moduleID })`) is recorded with `kind: "data"`, so it is absent from
 * `leaves(id)`'s callable answer and present as `data` under `{ details: true }`. Mounts made with
 * the `{ exports }` form are recorded as `function` correctly. Vine-grown stubs use the bare form
 * (see `grow.mjs`), which means a grown surface is NOT re-served onward by default — chaining a
 * vine through a middle instance is out of scope for v1 either way.
 */
import { CODES, VineError } from "./lib/errors.mjs";
import { errorFrame, findFunctionArg, isSafePath, parseFrame, resultFrame, surfaceFrame } from "./lib/frame.mjs";
import { createEventForwarder } from "./lib/events.mjs";
import { assertApi, assertChannel } from "./lib/link.mjs";
import { assertPrincipalSupport, bindPrincipal, gate } from "./lib/principal.mjs";

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
 *   `api.slothlet.permissions.global.checkCall` (the slothlet release carrying CLDMV/slothlet#508) —
 *   each checked here, fail-closed, as a `TypeError`. Omit it for a trusted transport (a worker you
 *   spawned, a process you forked): nothing changes, byte for byte. See `docs/PERMISSIONS.md`.
 * @returns {Promise<{ leaves: string[], excluded: string[], principal: object|Function|null, event: { on: Function, once: Function }, close: () => void }>}
 *   The live serving handle. `leaves` is what the far side is offered; `excluded` is every CALLABLE leaf that was
 *   dropped on the way there — refused by {@link isSafePath} or filtered out by `paths` — so a leaf
 *   that quietly failed to appear is visible rather than a mystery. (Namespace and data records are
 *   not "dropped": they were never candidates for a callable surface.) `principal` is the frozen,
 *   normalized `{ path, context? }` this serve bound (the resolver itself for the function form), or
 *   `null` when none was given.
 * @throws {TypeError} When `api` is not a slothlet instance or `channel` is not a Channel — or, with a
 *   `principal`, when it is malformed or the instance cannot enforce it (see `options.principal`).
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
			const value = principal ? await answerAs(path, args) : await execute(path, args);
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
	 * after the gate and inside the principal's scope: the args data-only check, then the invocation.
	 *
	 * EXTENSION POINT (#51 `around`): a host's per-call wrapper slots in here, between the args check
	 * and `invoke` — `around ? around({ callId, path, args, principal, invoke: () => invoke(api, path, args) }) : invoke(api, path, args)`
	 * — so it never sees a frame the vine would have refused, cannot widen what the rules allowed (it
	 * runs AFTER the gate, and `invoke` is fixed to the gated path/args), and whatever it returns flows
	 * into the return-value check in {@link answer} exactly like a leaf's own value.
	 * @param {string} path - The served leaf path.
	 * @param {unknown[]} args - The call's arguments (the parsed frame's fresh copy).
	 * @returns {Promise<unknown>} The leaf's resolved value.
	 */
	async function execute(path, args) {
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
		return await invoke(api, path, args);
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
	 * @param {string} path - The served leaf path.
	 * @param {unknown[]} args - The call's arguments.
	 * @returns {Promise<unknown>} The leaf's resolved value.
	 * @throws {VineError} `VINE_DENIED` when the principal may not call `path` (or could not be judged).
	 */
	async function answerAs(path, args) {
		const who = principal.resolve();
		if (!who) throw denied(path, null);
		const context = who.context ?? {};
		/** @type {{ value: unknown }|{ err: unknown }|null} Set ONLY by `fn` — null means the scope never ran it. */
		let outcome = null;
		try {
			await api.slothlet.context.scope({
				context,
				protect: Object.keys(context),
				fn: async () => {
					try {
						if (!(await gate(api, who, path, args))) throw denied(path, who);
						outcome = { value: await execute(path, args) };
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
	send(surfaceFrame(leaves));

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
