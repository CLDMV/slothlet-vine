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
import { assertApi, assertChannel } from "./lib/link.mjs";

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
 * @param {number} [options.budgetMs] - Accepted and IGNORED in v1; the budget is a grow-side
 *   concern. Documented for symmetry with {@link import("./grow.mjs").grow} per the design.
 * @returns {Promise<{ leaves: string[], excluded: string[], close: () => void }>} The live serving
 *   handle. `leaves` is what the far side is offered; `excluded` is every CALLABLE leaf that was
 *   dropped on the way there — refused by {@link isSafePath} or filtered out by `paths` — so a leaf
 *   that quietly failed to appear is visible rather than a mystery. (Namespace and data records are
 *   not "dropped": they were never candidates for a callable surface.)
 * @throws {TypeError} When `api` is not a slothlet instance or `channel` is not a Channel.
 *
 * @example
 * const serving = await serve(api, channel, { paths: ["exts"] });
 * serving.leaves; // ["exts.pdfViewer.open", …]
 * serving.excluded; // ["math.add", …] — real leaves this serve chose not to publish
 * serving.close(); // stop answering (the channel itself is NOT torn down — see close())
 */
export async function serve(api, channel, options = {}) {
	assertChannel(channel, "serve");
	assertApi(api, "serve", ["leaves"]);

	const { leaves, excluded } = await collectLeaves(api, options);
	const served = new Set(leaves);
	let closed = false;

	channel.onMessage((message) => {
		// The Channel contract forbids throwing into the transport, and this handler is the ONLY
		// thing standing between a malformed frame and the transport's own dispatch loop.
		try {
			if (closed) return;
			const frame = parseFrame(message);
			if (frame === null || frame.type !== "call") return;
			void answer(frame);
		} catch {
			// parseFrame is total and answer() never throws synchronously; this is belt-and-braces.
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
			// a leaf this serve does not publish.
			if (!served.has(path)) {
				throw new VineError(CODES.NO_LEAF, `slothlet-vine: '${path}' is not in the served surface`, { path });
			}
			// The grow-side stub already refuses a function-bearing argument before it ever sends a
			// frame (see grow.mjs), but that enforcement only covers frames built by a legitimate
			// vineStub call. Nothing stops a frame constructed directly against the channel — possible
			// only over a by-reference transport like loopback, where no serialization step would
			// otherwise refuse a live function reference — from reaching here with a function hiding in
			// `args`. Re-check before invoking, the same defense-in-depth reasoning as the return-value
			// check below.
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
			const value = await invoke(api, path, args);
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
