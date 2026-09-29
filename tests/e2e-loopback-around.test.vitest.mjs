/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-loopback-around.test.vitest.mjs
 *
 * `serve()`'s per-call `around` wrapper (#51) with REAL slothlet instances on both ends of a loopback
 * vine: the host runs each accepted call inside its own scope, and the far side sees exactly what
 * `around` returned or threw.
 *
 * Two halves, gated like `e2e-loopback-principal.test.vitest.mjs`:
 *
 * - WITHOUT a principal, `around` needs nothing new from slothlet, so it runs here against whatever is
 *   installed: a host-established context the leaf reads, a retried transaction, a thrown error.
 * - WITH a principal, the serve needs `api.slothlet.permissions.global.checkCall` (CLDMV/slothlet#508),
 *   so that block is `describe.skipIf(!hasCheckCall)`, feature-detected on a real instance: `around`
 *   receives the channel principal, runs after the gate inside the principal's scope, and a denied
 *   call never reaches it.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineRemoteError } from "../src/lib/errors.mjs";
import { createPair } from "../src/transport/loopback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRINCIPAL_DIR = path.join(here, "fixtures", "principal-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");

const probe = await slothlet({ base: PRINCIPAL_DIR, silent: true, permissions: { defaultPolicy: "deny" } });
const hasCheckCall = typeof probe.slothlet?.permissions?.global?.checkCall === "function";
await probe.slothlet.shutdown();

/** Teardown callbacks, run in reverse after each test. @type {Array<() => Promise<void>|void>} */
let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try {
			await fn();
		} catch {
			// Teardown must never mask the assertion that already failed.
		}
	}
	teardown = [];
});

/**
 * Create a real instance and register its shutdown.
 * @param {object} options - `slothlet()` options.
 * @returns {Promise<object>} The instance.
 */
async function instance(options) {
	const api = await slothlet({ silent: true, ...options });
	teardown.push(async () => api.slothlet?.shutdown?.());
	return api;
}

/**
 * Serve the principal fixture with `options` and grow it onto a fresh instance over loopback.
 * @param {object|((serveApi: object) => object)} options - `serve()` options (merged over
 *   `paths: ["project"]`), or a function of the serving instance that returns them.
 * @param {object} [serveOptions] - Extra `slothlet()` options for the serving instance.
 * @returns {Promise<{ serveApi: object, growApi: object, serving: object }>} The wired pair.
 */
async function vine(options, serveOptions = {}) {
	const serveApi = await instance({ base: PRINCIPAL_DIR, ...serveOptions });
	const growApi = await instance({ base: GROW_DIR });
	const [near, far] = createPair();
	const resolved = typeof options === "function" ? options(serveApi) : options;
	const serving = await serve(serveApi, far, { paths: ["project"], ...resolved });
	const link = await grow(growApi, near, { budgetMs: 2000 });
	teardown.push(async () => {
		await link.close();
		serving.close();
	});
	return { serveApi, growApi, serving };
}

describe("serve({ around }) without a principal — the host's own scope around each call", () => {
	it("the leaf runs inside the context around() establishes", async () => {
		const { growApi } = await vine((serveApi) => ({
			around: ({ invoke }) => serveApi.slothlet.context.run({ actor: { id: "u7" } }, invoke)
		}));
		expect(await growApi.project.files.actor()).toEqual({ id: "u7" });
	});

	it("around sees the call and wraps the value; the far side receives what around returned", async () => {
		const seen = [];
		const { growApi } = await vine({
			around: async ({ callId, path: leaf, args, principal, invoke }) => {
				seen.push({ callId, leaf, args, principal });
				return { ok: true, value: await invoke() };
			}
		});
		expect(await growApi.project.files.list("p9")).toEqual({ ok: true, value: ["p9/readme.md"] });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ leaf: "project.files.list", args: ["p9"], principal: null });
		expect(typeof seen[0].callId).toBe("string");
	});

	it("a retried invoke() runs the leaf again — a transaction retry on a write conflict", async () => {
		let attempts = 0;
		const { serveApi, growApi } = await vine({
			around: async ({ invoke }) => {
				for (;;) {
					attempts++;
					const value = await invoke();
					if (attempts >= 2) return value;
				}
			}
		});
		expect(await growApi.project.files.remove("p1")).toBe("removed:p1");
		expect(attempts).toBe(2);
		expect(await serveApi.project.files.removeCount()).toBe(2);
	});

	it("an error around() throws reaches the far side as a VineRemoteError with its own name and message", async () => {
		const { serveApi, growApi } = await vine({
			around: async () => {
				throw new RangeError("deadline exceeded");
			}
		});
		let caught;
		try {
			await growApi.project.files.remove("p1");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.name).toBe("RangeError");
		expect(caught.message).toContain("deadline exceeded");
		expect(await serveApi.project.files.removeCount()).toBe(0);
	});
});

/** The serving instance's rules for the principal half (a subset of the #33 e2e's). */
const SERVE_PERMISSIONS = {
	defaultPolicy: "deny",
	rules: [
		{ caller: "remote.renderer", target: "project.files.actor", effect: "allow" },
		{ caller: "remote.renderer", target: "project.files.list", effect: "allow" }
	]
};

const RENDERER = { path: "remote.renderer", context: { actor: { id: "u42", roles: ["reader"], project: "p1" } } };

describe.skipIf(!hasCheckCall)("serve({ principal, around }) — around wraps an already-authorized call", () => {
	it("around receives the channel principal, and the leaf still runs under the principal's context", async () => {
		const seen = [];
		const { growApi } = await vine(
			{
				principal: RENDERER,
				around: ({ principal, invoke }) => {
					seen.push(principal);
					return invoke();
				}
			},
			{ permissions: SERVE_PERMISSIONS }
		);
		expect(await growApi.project.files.actor()).toEqual(RENDERER.context.actor);
		expect(seen).toEqual([RENDERER]);
	});

	it("a call the principal may not make is VINE_DENIED and never reaches around", async () => {
		let reached = false;
		const { serveApi, growApi } = await vine(
			{
				principal: RENDERER,
				around: ({ invoke }) => {
					reached = true;
					return invoke();
				}
			},
			{ permissions: SERVE_PERMISSIONS }
		);
		let caught;
		try {
			await growApi.project.files.remove("p1");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.remoteCode).toBe(CODES.DENIED);
		expect(reached).toBe(false);
		expect(await serveApi.project.files.removeCount()).toBe(0);
	});
});
