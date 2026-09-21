/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-loopback-events-bidirectional.test.vitest.mjs
 *
 * Cross-vine EVENT forwarding is BIDIRECTIONAL (#20). The two linked instances are copies of the same
 * api and hold the SAME event permissions, so an emit in EITHER instance reaches subscribers in the
 * other, gated by that emitter's own (identical) rules. This covers the direction the loopback e2e in
 * `e2e-loopback-events` does not: the GROW side emits and a SERVE-side subscriber receives — the same
 * resolve-then-send-only-allowed path, now running on the grow end too — plus both directions over one
 * link at once.
 *
 * Same slothlet floor as the other event e2e: same-process forwarding needs the cross-instance
 * caller-isolation fix (slothlet ≥ 3.18.1, CLDMV/slothlet#436), which applies in BOTH directions.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { createPair } from "../src/transport/loopback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// One base for BOTH instances — they are copies, which is exactly the model bidirectional forwarding
// rests on. The base carries only the `events` subscriber module; each instance gets its own isolated
// copy of its module state, so the two sides' drains never cross.
const EVENTS_DIR = path.join(here, "fixtures", "events-api");

const installedSlothlet = createRequire(import.meta.url)("@cldmv/slothlet/package.json").version;
const hasEnablers = versionGte(installedSlothlet, "3.18.1");

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

/** A short settle for a forwarded delivery over the async loopback. @returns {Promise<void>} */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

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
 * Stand up a vine over loopback with both instances built from the copies base. Either instance may
 * carry `permissions.events`; the SERVE side publishes no leaves (`paths: []`) so the shared base's
 * `events` module does not self-collide when grow mounts — events flow regardless of the surface.
 * @param {object} [options]
 * @param {object} [options.serveEvents] - `permissions.events` for the SERVE instance.
 * @param {object} [options.growEvents] - `permissions.events` for the GROW instance.
 * @returns {Promise<{ serveApi: object, growApi: object, serving: object, link: object }>} The wired pair.
 */
async function wire({ serveEvents, growEvents } = {}) {
	const serveApi = await slothlet({
		base: EVENTS_DIR,
		silent: true,
		permissions: { defaultPolicy: "allow", ...(serveEvents ? { events: serveEvents } : {}) }
	});
	const growApi = await slothlet({
		base: EVENTS_DIR,
		silent: true,
		permissions: { defaultPolicy: "allow", ...(growEvents ? { events: growEvents } : {}) }
	});
	teardown.push(async () => serveApi.slothlet?.shutdown?.());
	teardown.push(async () => growApi.slothlet?.shutdown?.());

	const [near, far] = createPair();
	const serving = await serve(serveApi, far, { paths: [] });
	const link = await grow(growApi, near, { budgetMs: 5000 });
	teardown.push(async () => {
		await link.close();
		serving.close();
	});
	return { serveApi, growApi, serving, link };
}

/** Rules that grant `events.**` subscribers `allow` on `allow.*`, `deny` on `deny.*`, else the default. */
const RULES = (prefix) => ({
	default: "notify",
	rules: [
		{ caller: "events.**", event: `${prefix}.allow.*`, effect: "allow" },
		{ caller: "events.**", event: `${prefix}.deny.*`, effect: "deny" }
	]
});

describe.skipIf(!hasEnablers)("e2e over loopback — bidirectional event forwarding (#20)", () => {
	it("REVERSE: a serve-side module subscribes, the grow side emits, and the payload is delivered (allow)", async () => {
		// The EMITTER (grow) holds the rules — it resolves the far (serve) subscriber's level.
		const { serveApi, growApi, serving } = await wire({ growEvents: RULES("g") });
		const { level, identity } = await serveApi.events.subscribe(serving, "g.allow.thing");
		expect(level).toBe("allow");
		expect(identity).toBe("events.subscribe"); // the serve-side module's own identity

		await growApi.slothlet.event.emit("g.allow.thing", { value: 7 });
		await settle();
		const got = await serveApi.events.drain();
		expect(got).toHaveLength(1);
		expect(got[0].payload).toEqual({ value: 7 });
		expect(got[0].meta.event).toBe("g.allow.thing");
	});

	it("REVERSE: a notify-resolved serve subscriber gets the trigger only — the payload never crosses", async () => {
		const { serveApi, growApi, serving } = await wire({ growEvents: RULES("g") });
		const { level } = await serveApi.events.subscribe(serving, "g.notify.thing"); // matches no rule → default notify
		expect(level).toBe("notify");

		await growApi.slothlet.event.emit("g.notify.thing", { secret: "top" });
		await settle();
		const got = await serveApi.events.drain();
		expect(got).toHaveLength(1);
		expect(got[0].payload).toBeUndefined(); // stripped on the grow (emitting) side, before crossing
		expect(got[0].meta.event).toBe("g.notify.thing");
	});

	it("REVERSE: a deny-resolved serve subscriber is never subscribed and never fires", async () => {
		const { serveApi, growApi, serving } = await wire({ growEvents: RULES("g") });
		const { level } = await serveApi.events.subscribe(serving, "g.deny.thing");
		expect(level).toBe("deny");

		await growApi.slothlet.event.emit("g.deny.thing", { x: 1 });
		await settle();
		expect(await serveApi.events.drain()).toHaveLength(0);
	});

	it("REVERSE: unsubscribe stops delivery to the serve subscriber", async () => {
		const { serveApi, growApi, serving } = await wire({ growEvents: RULES("g") });
		await serveApi.events.subscribe(serving, "g.allow.thing");
		await growApi.slothlet.event.emit("g.allow.thing", { n: 1 });
		await settle();
		expect(await serveApi.events.drain()).toHaveLength(1);

		await serveApi.events.unsubscribe();
		await growApi.slothlet.event.emit("g.allow.thing", { n: 2 });
		await settle();
		expect(await serveApi.events.drain()).toHaveLength(0);
	});

	it("REVERSE: a host subscription on the serve handle is trusted (allow) and receives the full payload", async () => {
		const { growApi, serving } = await wire();
		const got = [];
		const { level, off } = await serving.event.on("g.anything", (payload, meta) => got.push({ payload, meta }));
		expect(level).toBe("allow"); // host subscription — no module caller

		await growApi.slothlet.event.emit("g.anything", { id: 42 });
		await settle();
		expect(got).toHaveLength(1);
		expect(got[0].payload).toEqual({ id: 42 });

		off();
		await growApi.slothlet.event.emit("g.anything", { id: 99 });
		await settle();
		expect(got).toHaveLength(1); // unsubscribed → nothing more
	});

	it("BOTH directions over one link: serve→grow and grow→serve deliver independently, each gated by the emitter's rules", async () => {
		// Each side holds the rules for the events IT emits; the far subscriber is resolved there.
		const { serveApi, growApi, serving, link } = await wire({ serveEvents: RULES("s"), growEvents: RULES("g") });

		// grow subscribes to a SERVE event; serve subscribes to a GROW event — different instances, so
		// their buffers are isolated.
		const forward = await growApi.events.subscribe(link, "s.allow.thing");
		const reverse = await serveApi.events.subscribe(serving, "g.allow.thing");
		expect(forward.level).toBe("allow");
		expect(reverse.level).toBe("allow");

		await serveApi.slothlet.event.emit("s.allow.thing", { dir: "forward" });
		await growApi.slothlet.event.emit("g.allow.thing", { dir: "reverse" });
		await settle();

		const gotForward = await growApi.events.drain();
		const gotReverse = await serveApi.events.drain();
		expect(gotForward).toHaveLength(1);
		expect(gotForward[0].payload).toEqual({ dir: "forward" });
		expect(gotReverse).toHaveLength(1);
		expect(gotReverse[0].payload).toEqual({ dir: "reverse" });
	});

	it("REVERSE: a function anywhere in the payload degrades an allow delivery to trigger-only", async () => {
		const { growApi, serving } = await wire();
		const got = [];
		const { level } = await serving.event.on("g.cb", (payload, meta) => got.push({ payload, meta }));
		expect(level).toBe("allow"); // host subscription

		await growApi.slothlet.event.emit("g.cb", { ok: 1, cb: () => {} });
		await settle();
		expect(got).toHaveLength(1);
		expect(got[0].payload).toBeUndefined(); // the function could not cross, so nothing did
		expect(got[0].meta.event).toBe("g.cb");
	});
});
