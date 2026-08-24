/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/grow.mjs
 *
 * The growing end of a vine: take the far side's leaf manifest and mount one forwarding stub per
 * leaf at the IDENTICAL dotted path in the local instance, so a caller writing
 * `self.exts.pdfViewer.open()` cannot tell which process the implementation lives in.
 *
 * ## Why identical paths, and what that buys (probed against @cldmv/slothlet 3.14.0)
 *
 * Stubs are mounted one leaf at a time with the BARE-FUNCTION form,
 * `api.slothlet.api.add(fullPath, stub, { moduleID })`, all sharing ONE moduleID per link:
 *
 * - the recorded permission identity is then the exact path — a rule targeting `far.ns.leaf`
 *   matched a stub mounted that way, verified — which is the whole point: **slothlet's own
 *   permission system gates a stub exactly as it gates a real leaf, and a denied call never runs
 *   the stub body, so it never reaches the wire**;
 * - many per-leaf adds may share one moduleID, and a single `remove(moduleID)` unmounts all of them
 *   (and prunes the namespaces they created) — as long as the id is hyphenated, which is a real and
 *   silent trap documented at the `moduleID` line below;
 * - `remove()` of an id that was never mounted resolves quietly, so close is safe to call twice.
 *
 * Two behaviours a consumer should know about, both verified rather than assumed:
 *
 * - **Permission gating covers module→leaf calls, not host→leaf calls.** A call made through the
 *   bound object `slothlet()` returned carries the host's own standing and is never checked; that
 *   is slothlet's documented host carve-out, not a vine gap. Rules bite when a MODULE calls the
 *   stub (`self.far.ns.leaf()` → `PERMISSION_DENIED`).
 * - **A path already occupied locally is not overwritten.** slothlet's collision handling keeps the
 *   incumbent and the add is a silent no-op unless `forceOverwrite` is passed — which a vine never
 *   does, because clobbering local reality with a remote's idea of the tree is not a trade worth
 *   making. An occupied path is therefore not mounted at all: it is reported on `link.collisions`
 *   and stays off `link.leaves`, so the link never claims to forward a path the incumbent answers.
 *
 * The same respect for local reality governs teardown, where it is easy to get backwards: a path the
 * vine mounted may have been taken over since, and `close()` removes only what the link still OWNS.
 * See the note on `close()`.
 */
import { CODES, VineError, fromWire } from "./lib/errors.mjs";
import { callFrame, findFunctionArg, isSafePath, parseFrame } from "./lib/frame.mjs";
import { PendingTable, assertApi, assertChannel, makeNonce, onCloseSafe } from "./lib/link.mjs";

/** Default per-call settle budget, in ms. @type {number} */
export const DEFAULT_BUDGET_MS = 30_000;

/**
 * Grow a vine from this instance to the far tree on `channel`: await the far side's `surface` frame,
 * mount a forwarding stub per leaf, and return the live link.
 *
 * @param {object} api - The local slothlet instance (the object `slothlet()` returned).
 * @param {import("./index.mjs").Channel} channel - The transport seam.
 * @param {object} [options]
 * @param {number} [options.budgetMs=30000] - Per-call settle budget; expiry settles that call with
 *   `VINE_BUDGET` and a later result frame for it is dropped (settle-once).
 * @param {number} [options.handshakeMs] - Budget for the `surface` frame itself; defaults to
 *   `budgetMs`. **Addition to `docs/DESIGN.md`**, which specifies no handshake deadline: without one
 *   a far side that never publishes leaves would hang `await grow(...)` forever, which contradicts
 *   the design's own "pending calls NEVER hang" rule. `Infinity` is the explicit opt-out and waits
 *   indefinitely; anything else that is not a positive finite number (`null`, `0`, `-1`, `NaN`, a
 *   string) falls back to the default rather than quietly meaning "no deadline" — the same reading
 *   `budgetMs` gets, and the safe one, since the failure mode of a missing deadline is a `grow()`
 *   that never settles.
 * @param {string[]} [options.paths] - Optional dotted prefixes; only far leaves at or under one of
 *   them are mounted. A local defence in depth — the serving side filters too, but a grow should not
 *   have to trust that it did. Same fail-closed reading as
 *   {@link import("./serve.mjs").serve}: an array with no usable prefix mounts nothing; a non-array
 *   value is ignored.
 * @returns {Promise<{ id: string, leaves: string[], skipped: string[], collisions: string[], close: () => Promise<void>, closed: Promise<{reason: string, info?: object}> }>}
 *   The live link. The three path lists are DISJOINT and together account for every leaf the far
 *   side published: `leaves` are the paths actually mounted and forwarding; `skipped` are far leaves
 *   refused locally (unsafe path, outside `paths`, rejected by `add()`, or published after the link
 *   had already ended); `collisions` are paths the local instance already occupied, which are NOT
 *   mounted — the incumbent keeps answering there and the far leaf is unreachable through this link.
 * @throws {TypeError} When `api` is not a slothlet instance or `channel` is not a Channel.
 * @throws {VineError} `VINE_GONE` when the channel closes before the surface arrives, `VINE_BUDGET`
 *   when the handshake budget elapses first.
 *
 * @example
 * const link = await grow(api, channel, { budgetMs: 5000 });
 * await api.exts.pdfViewer.open("a.pdf"); // runs on the far side
 * await link.close();                      // stubs unmounted, pending calls settle VINE_CLOSED
 */
export async function grow(api, channel, options = {}) {
	assertChannel(channel, "grow");
	assertApi(api, "grow", ["add", "remove"]);

	const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? Number(options.budgetMs) : DEFAULT_BUDGET_MS;
	const handshakeMs = handshakeBudget(options.handshakeMs, budgetMs);
	const prefixes = Array.isArray(options.paths) ? options.paths.filter((p) => typeof p === "string" && p.length > 0) : null;

	const nonce = makeNonce();
	// The separator is a HYPHEN, and that is load-bearing. Probed on @cldmv/slothlet 3.14.0: a
	// moduleID containing a COLON (`vine:<uuid>`) is accepted by `add()` but is then silently unknown
	// to `remove()` — the call resolves, reports nothing, and every stub stays mounted AND callable.
	// A hyphenated id removes cleanly. `close()` verifies the outcome regardless (see below).
	// Reported as CLDMV/slothlet#303 and fixed by CLDMV/slothlet#306; the hyphen is kept anyway — it is
	// zero-cost, works on both patched and unpatched slothlet, and nothing benefits from a colon.
	const moduleID = `vine-${nonce}`;
	const pending = new PendingTable(nonce);

	/** @type {{ closed: boolean, gone: boolean }} The link's terminal state; both are one-way. */
	const state = { closed: false, gone: false };

	// The receive handler has to be registered BEFORE the handshake promise exists, because a
	// synchronous transport can deliver the surface frame during `onMessage()` itself. So the two
	// handshake outcomes are CAPTURED first and replayed into the promise when it is created —
	// without this, an early surface is swallowed by a placeholder and `await grow(...)` never
	// settles at all (the handshake timer sees the handshake as already settled and stands down).
	/** @type {{ surface: object|null, error: Error|null }} */
	const captured = { surface: null, error: null };
	/** @type {(surface: {leaves: string[], unsafe: string[]}) => void} */
	let onSurface = (frame) => {
		captured.surface = frame;
	};
	/** @type {(err: Error) => void} */
	let onSurfaceFailed = (err) => {
		captured.error = err;
	};
	let surfaceSettled = false;

	let resolveClosed;
	/** @type {Promise<{reason: string, info?: object}>} */
	const closedPromise = new Promise((resolve) => {
		resolveClosed = resolve;
	});
	let closedResolved = false;

	/**
	 * Resolve `link.closed` exactly once.
	 * @param {{reason: string, info?: object}} outcome - Why the link ended.
	 * @returns {void}
	 */
	function finish(outcome) {
		if (closedResolved) return;
		closedResolved = true;
		resolveClosed(outcome);
	}

	channel.onMessage((message) => {
		// Never throw into the transport (Channel contract).
		try {
			const frame = parseFrame(message);
			if (frame === null) return;
			if (frame.type === "surface") {
				if (surfaceSettled) return; // v1 publishes once; a re-publication is not a re-mount.
				surfaceSettled = true;
				onSurface(frame);
				return;
			}
			// Frames may arrive after a local close, or for an already-settled call (a result racing a
			// budget expiry). PendingTable drops both — settle-once is enforced there, not here.
			if (frame.type === "result") pending.resolve(frame.callId, frame.value);
			else if (frame.type === "error") pending.reject(frame.callId, fromWire(frame.error));
		} catch {
			// Defensive: parseFrame is total and the settle path cannot throw.
		}
	});

	onCloseSafe(channel, (info) => {
		if (state.gone || state.closed) return;
		state.gone = true;
		pending.settleAll(CODES.GONE, "slothlet-vine: the far side of the link is gone");
		if (!surfaceSettled) {
			surfaceSettled = true;
			onSurfaceFailed(new VineError(CODES.GONE, "slothlet-vine: the channel closed before the far side published its surface"));
		}
		finish({ reason: "gone", info });
	});

	const surface = await new Promise((resolve, reject) => {
		onSurface = resolve;
		onSurfaceFailed = reject;
		if (captured.error) return reject(captured.error);
		if (captured.surface) return resolve(captured.surface);
		if (Number.isFinite(handshakeMs) && handshakeMs > 0) {
			const timer = setTimeout(() => {
				if (surfaceSettled) return;
				surfaceSettled = true;
				reject(
					new VineError(CODES.BUDGET, `slothlet-vine: no surface frame within the ${handshakeMs}ms handshake budget`, {
						budgetMs: handshakeMs
					})
				);
			}, handshakeMs);
			if (timer && typeof timer.unref === "function") timer.unref();
		}
	});

	/** @type {string[]} */
	const mounted = [];
	/** @type {string[]} */
	const skipped = [...surface.unsafe];
	/** @type {string[]} */
	const collisions = [];

	for (const path of surface.leaves) {
		// The far side can die mid-mount — `add()` is async and a surface of any size yields to the
		// event loop repeatedly. Mounting the rest would publish stubs for a link that is already over;
		// every one of them would refuse with VINE_GONE anyway, so stop and report them as skipped.
		if (state.gone || state.closed) {
			skipped.push(path);
			continue;
		}
		// Re-validate locally. The serving side filters `slothlet.**` and prototype-walking segments,
		// but "the far side already checked" is not a security property.
		if (!isSafePath(path) || (prefixes && !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))) {
			skipped.push(path);
			continue;
		}
		// An occupied path is NOT mounted, and mounting it anyway would be a lie in two directions:
		// slothlet keeps the incumbent (the add is a silent no-op without `forceOverwrite`, which a vine
		// never passes), so the far leaf is unreachable at that path AND `link.leaves` — documented as
		// "the paths actually mounted" — would claim it forwards. Recorded on `collisions` only.
		if (resolves(api, path)) {
			collisions.push(path);
			continue;
		}
		try {
			await api.slothlet.api.add(path, makeStub(path), { moduleID });
			mounted.push(path);
		} catch {
			// slothlet refuses a reserved or otherwise invalid mount path (INVALID_CONFIG_API_PATH_INVALID).
			// One bad leaf must not abort a link that is otherwise fine.
			skipped.push(path);
		}
	}

	/**
	 * Build the forwarding stub for one leaf. Reached ONLY when slothlet has already allowed the call
	 * — permission denial happens in the wrapper, before this body runs.
	 * @param {string} path - The dotted leaf path.
	 * @returns {(...args: unknown[]) => Promise<unknown>} The mountable async stub.
	 */
	function makeStub(path) {
		return async function vineStub(...args) {
			if (state.gone) {
				throw new VineError(CODES.GONE, `slothlet-vine: '${path}' is unreachable — the far side is gone`, { path });
			}
			if (state.closed) {
				throw new VineError(CODES.CLOSED, `slothlet-vine: '${path}' is unreachable — the link is closed`, { path });
			}
			const functionAt = findFunctionArg(args);
			if (functionAt !== null) {
				throw new VineError(CODES.DATA_ONLY, `slothlet-vine: '${path}' was passed a function at ${functionAt} — the vine is data-only`, {
					path,
					location: functionAt
				});
			}
			const callId = pending.nextCallId();
			const settled = pending.open(callId, { path, budgetMs });
			try {
				channel.send(callFrame(callId, path, args));
			} catch (err) {
				// The frame could not be handed to the transport — an un-cloneable argument the data-only
				// scan cannot see (a getter that returns a function, a Proxy hiding its keys), or a dead
				// socket. Settle now rather than leaving the entry to time out on its budget.
				pending.reject(
					callId,
					new VineError(CODES.BAD_FRAME, `slothlet-vine: call to '${path}' could not be sent: ${err?.message ?? String(err)}`, {
						path,
						callId
					})
				);
			}
			return settled;
		};
	}

	return {
		id: moduleID,
		leaves: mounted,
		skipped,
		collisions,
		closed: closedPromise,
		/**
		 * Tear the link down locally: unmount every stub and settle every in-flight call with
		 * `VINE_CLOSED`. Idempotent. Like {@link import("./serve.mjs").serve}'s close, it does NOT
		 * close the channel — the transport belongs to whoever created it.
		 *
		 * The unmount is VERIFIED rather than assumed. A `remove()` that silently unmounts nothing is
		 * a real failure mode (see the moduleID note above), and the difference between "the link is
		 * closed" and "the paths are gone" is exactly what a consumer relies on here — so any path
		 * that survives the module-scoped removal is removed again by path.
		 *
		 * That fallback is **ownership-scoped**, and it has to be. A path this vine mounted can
		 * legitimately have been taken over since — a local module claiming it with `forceOverwrite`
		 * and its own moduleID — and a blind `remove(path)` would then delete local reality on the way
		 * out. slothlet's own `remove(moduleID)` gets this right (the takeover survives it); the vine
		 * must not undo that. So ownership is read from the loader's records BEFORE the module-scoped
		 * removal (after it, the id is unknown and `leaves()` throws) and only still-owned paths are
		 * removed individually.
		 *
		 * Identity comparison was probed as the alternative and REJECTED: slothlet keeps the same
		 * wrapper function object at a path across a `forceOverwrite` takeover — the resolved value is
		 * `===` what it was while the vine owned it, yet calling it now runs the local implementation.
		 * Identity therefore cannot tell owner from usurper; the records can.
		 * @returns {Promise<void>} Resolves once the stubs are unmounted.
		 */
		async close() {
			if (state.closed) return;
			state.closed = true;
			try {
				const owned = await ownedPaths(api, moduleID, mounted);
				await api.slothlet.api.remove(moduleID);
				for (const path of mounted) {
					if (!owned.has(path) || !resolves(api, path)) continue;
					try {
						await api.slothlet.api.remove(path);
					} catch {
						// Best effort: the link is closing and every stub already refuses to dispatch.
					}
				}
			} finally {
				// Release the receive closure: it captures `api` and the pending table, and the channel may
				// well outlive the link (the transport belongs to whoever created it). Nothing is expected
				// on it any more — every pending call is settled on the next line.
				try {
					channel.onMessage(() => {});
				} catch {
					// A transport that refuses a re-registration after close keeps the old handler; harmless.
				}
				pending.settleAll(CODES.CLOSED, "slothlet-vine: the link was closed");
				finish({ reason: "closed" });
			}
		}
	};
}

/**
 * Which of `paths` does the link's module still OWN, according to the loader's own records?
 *
 * Must be asked while the module is still mounted: a successful `remove(moduleID)` makes the id
 * unknown and `leaves(id)` throws `API_LEAVES_UNKNOWN_MODULE`. A path the vine mounted and a local
 * module later took over (`forceOverwrite`, its own moduleID) is reassigned in the records and so
 * is absent from the answer — which is exactly the distinction the teardown needs.
 *
 * When ownership cannot be established at all — `leaves()` absent (grow only requires `add` and
 * `remove`), throwing, or answering something that is not a record list — every mounted path counts
 * as owned. That is the pre-existing behaviour and it keeps the fallback's real purpose intact: a
 * `remove(moduleID)` that silently unmounts NOTHING must still leave no callable stub behind.
 * @param {object} api - The slothlet instance.
 * @param {string} moduleID - The link's module id.
 * @param {string[]} paths - The paths this link mounted.
 * @returns {Promise<Set<string>>} The subset still owned by the link (or all of them, when unknown).
 */
async function ownedPaths(api, moduleID, paths) {
	try {
		const records = await api.slothlet.api.leaves(moduleID, { details: true });
		if (!Array.isArray(records)) return new Set(paths);
		const owned = new Set(records.map((record) => record?.path).filter((path) => typeof path === "string"));
		return new Set(paths.filter((path) => owned.has(path)));
	} catch {
		return new Set(paths);
	}
}

/**
 * Normalize the handshake deadline. Mirrors `budgetMs`'s reading — anything that is not a usable
 * positive number falls back to the default rather than silently meaning "no deadline", because a
 * missing deadline here is a `grow()` that never settles. `Infinity` is the one explicit opt-out.
 * @param {unknown} value - The caller's `handshakeMs`.
 * @param {number} fallback - The default (the call budget).
 * @returns {number} A positive millisecond budget, or `Infinity` to wait indefinitely.
 */
function handshakeBudget(value, fallback) {
	// Number-only, like `budgetMs`: a coercion here could itself throw (a Symbol, a hostile
	// `valueOf`), and `grow()` failing with a TypeError out of an options read is not a useful
	// diagnosis of "that isn't a number".
	if (typeof value !== "number") return fallback;
	if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Does a dotted path already resolve to something on the local api? Used only to REPORT collisions —
 * the mount itself never overwrites. Any failure while probing counts as "no collision": this is
 * diagnostics, and a lazy namespace that objects to being read is not a reason to fail a link.
 * @param {object} api - The slothlet instance.
 * @param {string} path - Validated dotted path.
 * @returns {boolean} True when something already lives at that path.
 */
function resolves(api, path) {
	try {
		let node = api;
		for (const segment of path.split(".")) {
			if (node === null || (typeof node !== "object" && typeof node !== "function")) return false;
			node = node[segment];
		}
		return node !== undefined;
	} catch {
		return false;
	}
}
