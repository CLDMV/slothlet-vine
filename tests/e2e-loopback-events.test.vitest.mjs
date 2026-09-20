/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-loopback-events.test.vitest.mjs
 *
 * Cross-vine EVENT forwarding (#20) over the loopback transport, with a REAL slothlet instance on
 * each side: a grow-side subscriber's level is resolved on the serving side and the payload stripped
 * before it crosses (deny / notify / allow), the granted level is a catchable handshake result,
 * unsubscribe and `once` tear the subscription down, a host subscription is trusted (`allow`), and a
 * function in the payload degrades to trigger-only rather than crossing.
 *
 * Requires the two 3.18.0 enablers (`api.slothlet.event.resolveLevel` + `api.slothlet.caller`); the
 * whole suite is skipped cleanly on older slothlet so it stays green until the dependency bump lands.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { createPair } from "../src/transport/loopback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(here, "fixtures", "serve-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");

// Event forwarding needs slothlet ≥ 3.18.0. Gate synchronously on the INSTALLED version so the
// describe below can `skipIf` at collection time rather than failing on an older slothlet.
const installedSlothlet = createRequire(import.meta.url)("@cldmv/slothlet/package.json").version;
const hasEnablers = versionGte(installedSlothlet, "3.18.0");

/**
 * Compare two dotted `major.minor.patch` versions.
 * @param {string} a - Left version.
 * @param {string} b - Right version.
 * @returns {boolean} True when `a >= b`.
 */
function versionGte(a, b) {
	const pa = String(a).split(".").map(Number);
	const pb = String(b).split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] || 0;
		const y = pb[i] || 0;
		if (x !== y) return x > y;
	}
	return true;
}

/** Instances + links to tear down after each test. @type {Array<() => Promise<void>>} */
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
 * Stand up a vine over loopback with the serving side carrying event rules (the trusted side that
 * resolves a far subscriber's level), and the grow side carrying the subscriber module.
 * @param {object} [options]
 * @param {object} [options.serveEvents] - `permissions.events` for the SERVING instance.
 * @returns {Promise<{ serveApi: object, growApi: object, link: object, serving: object }>} The wired pair.
 */
async function wire({ serveEvents } = {}) {
	const serveApi = await slothlet({ base: SERVE_DIR, silent: true, ...(serveEvents ? { permissions: { events: serveEvents } } : {}) });
	const growApi = await slothlet({ base: GROW_DIR, silent: true, permissions: { defaultPolicy: "allow" } });
	teardown.push(async () => serveApi.slothlet?.shutdown?.());
	teardown.push(async () => growApi.slothlet?.shutdown?.());

	const [near, far] = createPair();
	const serving = await serve(serveApi, far);
	const link = await grow(growApi, near, { budgetMs: 5000 });
	teardown.push(async () => {
		await link.close();
		serving.close();
	});
	return { serveApi, growApi, link, serving };
}

/**
 * Poll until a predicate holds, failing loudly rather than hanging the suite.
 * @param {() => boolean} predicate - Condition to await.
 * @returns {Promise<void>} Resolves once true.
 */
async function waitFor(predicate) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a forwarded event");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Baseline serving-side event rules used across the level tests. */
const SERVE_EVENTS = {
	default: "notify",
	rules: [
		{ caller: "events.**", event: "allow.*", effect: "allow" },
		{ caller: "events.**", event: "deny.*", effect: "deny" }
	]
};

describe.skipIf(!hasEnablers)("e2e over loopback — cross-vine event forwarding (#20)", () => {
	it("a host subscription is trusted (allow) and receives the full payload + meta", async () => {
		const { serveApi, link } = await wire();
		const got = [];
		const { level, off } = await link.event.on("orders.created", (payload, meta) => got.push({ payload, meta }));
		expect(level).toBe("allow");

		await serveApi.slothlet.event.emit("orders.created", { id: 42 });
		await waitFor(() => got.length > 0);
		expect(got[0].payload).toEqual({ id: 42 });
		expect(got[0].meta.event).toBe("orders.created");
		expect(typeof got[0].meta.at).toBe("number");
		expect(got[0].meta.instanceID).toBeTruthy();

		off();
		await serveApi.slothlet.event.emit("orders.created", { id: 99 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(got).toHaveLength(1); // unsubscribed → nothing more
	});

	it("a module granted allow on the serving side receives the payload", async () => {
		const { serveApi, growApi, link } = await wire({ serveEvents: SERVE_EVENTS });
		const { level, identity } = await growApi.events.subscribe(link, "allow.thing");
		expect(level).toBe("allow");
		expect(identity).toBe("events.subscribe");

		await serveApi.slothlet.event.emit("allow.thing", { value: 7 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		const got = await growApi.events.drain();
		expect(got).toHaveLength(1);
		expect(got[0].payload).toEqual({ value: 7 });
	});

	it("a module resolved to notify receives the trigger only — the payload never crosses", async () => {
		const { serveApi, growApi, link } = await wire({ serveEvents: SERVE_EVENTS });
		const { level } = await growApi.events.subscribe(link, "notify.thing"); // matches no allow/deny rule → default notify
		expect(level).toBe("notify");

		await serveApi.slothlet.event.emit("notify.thing", { secret: "top" });
		await new Promise((resolve) => setTimeout(resolve, 40));
		const got = await growApi.events.drain();
		expect(got).toHaveLength(1);
		expect(got[0].payload).toBeUndefined(); // stripped on the trusted side, before crossing
		expect(got[0].meta.event).toBe("notify.thing");
	});

	it("a module resolved to deny is never subscribed and never fires", async () => {
		const { serveApi, growApi, link } = await wire({ serveEvents: SERVE_EVENTS });
		const { level } = await growApi.events.subscribe(link, "deny.thing");
		expect(level).toBe("deny");

		await serveApi.slothlet.event.emit("deny.thing", { x: 1 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(await growApi.events.drain()).toHaveLength(0);
	});

	it("unsubscribe stops delivery", async () => {
		const { serveApi, growApi, link } = await wire({ serveEvents: SERVE_EVENTS });
		await growApi.events.subscribe(link, "allow.thing");
		await serveApi.slothlet.event.emit("allow.thing", { n: 1 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(await growApi.events.drain()).toHaveLength(1);

		await growApi.events.unsubscribe();
		await serveApi.slothlet.event.emit("allow.thing", { n: 2 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(await growApi.events.drain()).toHaveLength(0);
	});

	it("once delivers exactly once, then tears the subscription down", async () => {
		const { serveApi, growApi, link } = await wire({ serveEvents: SERVE_EVENTS });
		await growApi.events.subscribe(link, "allow.thing", { once: true });
		await serveApi.slothlet.event.emit("allow.thing", { n: 1 });
		await serveApi.slothlet.event.emit("allow.thing", { n: 2 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(await growApi.events.drain()).toHaveLength(1);
	});

	it("a function anywhere in the payload degrades an allow delivery to trigger-only", async () => {
		const { serveApi, link } = await wire();
		const got = [];
		const { level } = await link.event.on("orders.created", (payload, meta) => got.push({ payload, meta }));
		expect(level).toBe("allow"); // host subscription

		await serveApi.slothlet.event.emit("orders.created", { ok: 1, cb: () => {} });
		await waitFor(() => got.length > 0);
		expect(got[0].payload).toBeUndefined(); // the function could not cross, so nothing did
		expect(got[0].meta.event).toBe("orders.created");
	});
});
