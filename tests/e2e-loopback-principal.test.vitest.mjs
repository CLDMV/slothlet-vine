/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-loopback-principal.test.vitest.mjs
 *	@Date: 2026-09-28T12:47:12-07:00 (1790624832)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:16-07:00 (1790968816)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect, afterEach, afterAll } from "vitest";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineRemoteError } from "../src/lib/errors.mjs";
import { createPair } from "../src/transport/loopback.mjs";
import { createChannel as createWsChannel } from "../src/transport/websocket.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRINCIPAL_DIR = path.join(here, "fixtures", "principal-api");
const EVENTS_DIR = path.join(here, "fixtures", "events-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");

// Feature-detect the call gate on a REAL instance (not a version compare): `serve({ principal })`
// is exactly as available as `permissions.global.checkCall` is.
const probe = await slothlet({ base: PRINCIPAL_DIR, silent: true, permissions: { defaultPolicy: "deny" } });
const hasCheckCall = typeof probe.slothlet?.permissions?.global?.checkCall === "function";
await probe.slothlet.shutdown();

/**
 * The actor a rule condition sees. slothlet 3.20.0 hands an EVENT-rule condition the raw context
 * store (`{ instanceID, context: { actor }, … }`) while a CALL-rule condition receives the user context
 * itself (`{ actor }`); read both shapes so the rule means the same thing under either.
 * @param {object} ctx - Whatever the condition received.
 * @returns {object|undefined} The bound actor, if any.
 */
function actorOf(ctx) {
	return ctx?.actor ?? ctx?.context?.actor;
}

/** The serving instance's rules for the call-half tables (design § 7). */
const SERVE_PERMISSIONS = {
	defaultPolicy: "deny",
	rules: [
		{ caller: "remote.**", target: "host.**", effect: "allow" },
		{
			caller: "remote.renderer",
			target: "project.files.list",
			effect: "allow",
			// Resource-scoped: the project named in the CALL must be the actor's own — this is the rule
			// shape only `checkCall` (callMeta) can evaluate; `checkAccess` would make it a non-match.
			condition: (ctx, meta) => actorOf(ctx)?.roles?.includes("reader") === true && meta?.args?.[0] === actorOf(ctx)?.project
		},
		{ caller: "remote.renderer", target: "project.files.actor", effect: "allow" },
		{ caller: "remote.renderer", target: "project.files.tamper", effect: "allow" },
		{ caller: "remote.admin", target: "project.**", effect: "allow" }
	],
	events: {
		default: "deny",
		rules: [
			{ caller: "remote.renderer", event: "jobs.*", effect: "allow" },
			{ caller: "remote.renderer.audit", event: "jobs.*", effect: "notify" }, // a narrower grant for one far module
			{ caller: "remote.renderer", event: "trace.*", effect: "notify" },
			{ caller: "remote.renderer.audit", event: "trace.*", effect: "allow" }, // wider than the channel — must not widen
			{ caller: "remote.admin", event: "**", effect: "allow" }
		]
	}
};

/** The growing instance's EVENT rules for the grow-end tables. */
const GROW_EVENTS = {
	default: "deny",
	rules: [
		{ caller: "remote.plugin", event: "jobs.*", effect: "allow" },
		{ caller: "remote.plugin.audit", event: "jobs.*", effect: "notify" },
		{ caller: "remote.plugin", event: "trace.*", effect: "notify" },
		{ caller: "remote.plugin.audit", event: "trace.*", effect: "allow" },
		{ caller: "remote.admin", event: "**", effect: "allow" },
		{ caller: "events.subscribe", event: "**", effect: "allow" }, // the far module's HONEST identity — still not the channel's
		{ caller: "remote.plugin", event: "cond.*", effect: "allow", condition: (ctx) => actorOf(ctx)?.id === "u1" }
	]
};

const RENDERER = { path: "remote.renderer", context: { actor: { id: "u42", roles: ["reader"], project: "p1" } } };
const ADMIN = { path: "remote.admin", context: { actor: { id: "root", roles: ["admin"], project: "*" } } };

/** Teardown callbacks, run in reverse after each test. @type {Array<() => Promise<void>|void>} */
let teardown = [];
/** Every ws server stood up, closed in afterAll as a backstop. @type {Set<import("ws").WebSocketServer>} */
const servers = new Set();

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

afterAll(async () => {
	for (const wss of servers) await new Promise((resolve) => wss.close(() => resolve()));
	servers.clear();
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
 * A RAW peer on one channel end: collects every frame it receives and builds `call` / `sub` frames
 * by hand — the page script with a socket that #33 is about.
 * @param {object} channel - The channel end to drive.
 * @returns {object} The peer controls.
 */
function rawPeer(channel) {
	const frames = [];
	const waiters = new Set();
	channel.onMessage((frame) => {
		frames.push(frame);
		for (const waiter of waiters) waiter();
	});
	/**
	 * @param {(frame: object) => boolean} predicate - Frame to wait for.
	 * @returns {Promise<object>} The first matching frame.
	 */
	async function waitFor(predicate) {
		const deadline = Date.now() + 3000;
		for (;;) {
			const hit = frames.find(predicate);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
			await new Promise((resolve) => {
				const waiter = () => {
					waiters.delete(waiter);
					resolve();
				};
				waiters.add(waiter);
				setTimeout(waiter, 20);
			});
		}
	}
	let seq = 0;
	return {
		frames,
		waitFor,
		/** @returns {Promise<object>} The surface frame a serve publishes. */
		surface: () => waitFor((frame) => frame.type === "surface"),
		/**
		 * @param {string} path - Leaf path.
		 * @param {unknown[]} [args] - Arguments.
		 * @returns {Promise<object>} The terminal frame.
		 */
		call(path, args = []) {
			const callId = `raw#${++seq}`;
			channel.send({ type: "call", callId, path, args });
			return waitFor((frame) => (frame.type === "result" || frame.type === "error") && frame.callId === callId);
		},
		/**
		 * @param {string} event - Event name.
		 * @param {string|null} subscriberPath - The asserted identity.
		 * @returns {Promise<{ subId: string, level: string }>} The ack.
		 */
		async sub(event, subscriberPath) {
			const subId = `rsub#${++seq}`;
			channel.send({ type: "sub", subId, event, subscriberPath });
			const ack = await waitFor((frame) => frame.type === "sub-ack" && frame.subId === subId);
			return { subId, level: ack.level };
		},
		/**
		 * @param {string} subId - Subscription id.
		 * @returns {object[]} Deliveries for it so far.
		 */
		deliveries: (subId) => frames.filter((frame) => frame.type === "event" && frame.subId === subId),
		/** Publish an empty surface so a grow on the other end settles. @returns {void} */
		publish: () => channel.send({ type: "surface", v: 1, leaves: [] })
	};
}

/**
 * Wait a beat for forwarded deliveries to land.
 * @returns {Promise<void>} Resolves after 40 ms.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * A growing instance with `GROW_EVENTS`, bound to a principal, with a RAW peer on the far end that
 * subscribes to the grow instance's events.
 * @param {unknown} principal - The `grow()` principal option.
 * @param {object} [events] - Event rules for the growing instance.
 * @returns {Promise<{ growApi: object, peer: object, link: object }>} The wired pair.
 */
async function growWithPrincipal(principal, events = GROW_EVENTS) {
	const growApi = await instance({ base: GROW_DIR, permissions: { events } });
	const [near, far] = createPair();
	const peer = rawPeer(far);
	peer.publish();
	const link = await grow(growApi, near, { budgetMs: 2000, principal });
	teardown.push(() => link.close());
	return { growApi, peer, link };
}

describe("grow({ principal }) — the grow end answers far subscriptions as its principal (real instances)", () => {
	it("null (a far host subscription) is the CHANNEL, not the host: allowed where the principal is, denied elsewhere", async () => {
		const { growApi, peer } = await growWithPrincipal("remote.plugin");
		const jobs = await peer.sub("jobs.done", null);
		const billing = await peer.sub("billing.paid", null);
		expect(jobs.level).toBe("allow");
		expect(billing.level).toBe("deny"); // v1 would have said allow — null used to mean host
		await growApi.slothlet.event.emit("jobs.done", { id: 7 });
		await growApi.slothlet.event.emit("billing.paid", { amount: 1 });
		await settle();
		expect(peer.deliveries(jobs.subId)).toHaveLength(1);
		expect(peer.deliveries(jobs.subId)[0].payload).toEqual({ id: 7 });
		expect(peer.deliveries(billing.subId)).toHaveLength(0);
	});

	it("a forged claim outside the principal's prefix is ignored — even one with a wider grant", async () => {
		const { peer } = await growWithPrincipal("remote.plugin");
		expect((await peer.sub("billing.paid", "remote.admin")).level).toBe("deny");
		expect((await peer.sub("billing.paid", "events.subscribe")).level).toBe("deny");
		expect((await peer.sub("jobs.done", "remote.admin")).level).toBe("allow"); // only because the channel itself is allowed
	});

	it("a hint at/under the principal can NARROW (allow ∧ notify = notify) and the payload never crosses", async () => {
		const { growApi, peer } = await growWithPrincipal("remote.plugin");
		const audit = await peer.sub("jobs.done", "remote.plugin.audit");
		expect(audit.level).toBe("notify");
		await growApi.slothlet.event.emit("jobs.done", { secret: "no" });
		await settle();
		const [delivery] = peer.deliveries(audit.subId);
		expect(delivery.event).toBe("jobs.done");
		expect(delivery).not.toHaveProperty("payload");
	});

	it("a hint at/under the principal cannot WIDEN (notify ∧ allow = notify)", async () => {
		const { peer } = await growWithPrincipal("remote.plugin");
		expect((await peer.sub("trace.step", "remote.plugin")).level).toBe("notify");
		expect((await peer.sub("trace.step", "remote.plugin.audit")).level).toBe("notify");
	});

	it("a conditional event rule sees the principal's context (resolved inside context.run)", async () => {
		const u1 = await growWithPrincipal({ path: "remote.plugin", context: { actor: { id: "u1" } } });
		expect((await u1.peer.sub("cond.thing", null)).level).toBe("allow");
		const u2 = await growWithPrincipal({ path: "remote.plugin", context: { actor: { id: "u2" } } });
		expect((await u2.peer.sub("cond.thing", null)).level).toBe("deny");
	});

	it("re-resolves per emit: a runtime rule that downgrades the channel stops deliveries live", async () => {
		const { growApi, peer } = await growWithPrincipal("remote.plugin");
		const jobs = await peer.sub("jobs.done", null);
		expect(jobs.level).toBe("allow");
		await growApi.slothlet.event.emit("jobs.done", { n: 1 });
		await settle();
		expect(peer.deliveries(jobs.subId)).toHaveLength(1);
		growApi.slothlet.event.rules.add({ caller: "remote.plugin", event: "jobs.done", effect: "deny" });
		await growApi.slothlet.event.emit("jobs.done", { n: 2 });
		await settle();
		expect(peer.deliveries(jobs.subId)).toHaveLength(1);
	});

	it("a function principal is re-evaluated per frame and per emit: a rotated identity loses its grant", async () => {
		let identity = "remote.plugin";
		const { growApi, peer } = await growWithPrincipal(() => identity);
		const jobs = await peer.sub("jobs.done", null);
		expect(jobs.level).toBe("allow");
		identity = "remote.guest"; // matches no rule → default deny
		await growApi.slothlet.event.emit("jobs.done", { n: 1 });
		await settle();
		expect(peer.deliveries(jobs.subId)).toHaveLength(0);
		expect((await peer.sub("jobs.done", null)).level).toBe("deny");
	});

	it("through a REAL serving end: its host and module subscriptions are both resolved as the grow end's principal", async () => {
		const growApi = await instance({ base: GROW_DIR, permissions: { events: GROW_EVENTS } });
		const serveApi = await instance({ base: EVENTS_DIR });
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		const link = await grow(growApi, near, { budgetMs: 2000, principal: "remote.plugin" });
		teardown.push(async () => {
			await link.close();
			serving.close();
		});
		// The serving HOST subscribes (subscriberPath null): the channel's level, not host `allow`.
		const got = [];
		const host = await serving.event.on("jobs.done", (payload) => got.push(payload));
		expect(host.level).toBe("allow");
		expect((await serving.event.on("billing.paid", () => {})).level).toBe("deny");
		// A serving MODULE subscribes with its honest identity `events.subscribe` — which the grow
		// instance's rules would grant `**` — yet it is not under the channel's prefix, so it is ignored.
		expect((await serveApi.events.subscribe(serving, "billing.paid")).level).toBe("deny");
		await growApi.slothlet.event.emit("jobs.done", { ok: true });
		await settle();
		expect(got).toEqual([{ ok: true }]);
	});

	it("fails closed at setup on an instance whose permission system is not enforcing", async () => {
		const growApi = await instance({ base: GROW_DIR }); // no permissions block → control.enabled === false
		const [near, far] = createPair();
		rawPeer(far).publish();
		await expect(grow(growApi, near, { principal: "remote.plugin" })).rejects.toThrow(/permission system enabled/);
	});

	it("fails closed at setup when a context is given but the instance disabled context scopes", async () => {
		const growApi = await instance({ base: GROW_DIR, scope: false, permissions: { events: GROW_EVENTS } });
		const [near, far] = createPair();
		rawPeer(far).publish();
		await expect(grow(growApi, near, { principal: { path: "remote.plugin", context: { actor: {} } } })).rejects.toThrow(/context\.run\(\)/);
	});
});

describe.skipIf(hasCheckCall)("serve({ principal }) on a slothlet WITHOUT permissions.global.checkCall", () => {
	it("fails closed at setup — a TypeError naming the missing gate — and publishes no surface", async () => {
		const serveApi = await instance({ base: PRINCIPAL_DIR, permissions: SERVE_PERMISSIONS });
		const [near, far] = createPair();
		const peer = rawPeer(near);
		await expect(serve(serveApi, far, { paths: ["host", "project"], principal: RENDERER })).rejects.toThrow(
			/checkCall.*CLDMV\/slothlet#508/
		);
		await settle();
		expect(peer.frames).toEqual([]);
		// The same instance serves fine WITHOUT a principal — v1 is untouched.
		const serving = await serve(serveApi, far, { paths: ["host"] });
		expect((await peer.surface()).leaves).toEqual(["host.deps.list"]);
		serving.close();
	});
});

/**
 * A serving instance with `SERVE_PERMISSIONS`, served to a RAW client with `principal`.
 * @param {unknown} principal - The `serve()` principal option.
 * @returns {Promise<{ serveApi: object, peer: object, serving: object, near: object }>} The wired pair.
 */
async function serveWithPrincipal(principal) {
	const serveApi = await instance({ base: PRINCIPAL_DIR, permissions: SERVE_PERMISSIONS });
	const [near, far] = createPair();
	const peer = rawPeer(near);
	const serving = await serve(serveApi, far, { paths: ["host", "project"], principal });
	teardown.push(() => serving.close());
	await peer.surface();
	return { serveApi, peer, serving, near };
}

describe.skipIf(!hasCheckCall)("serve({ principal }) — calls are judged as the channel principal (design § 7.1 / § 7.2)", () => {
	it("the same raw frames on a renderer channel: allowed by rule, allowed by resource-scoped condition, denied, NO_LEAF first", async () => {
		const { serveApi, peer, serving } = await serveWithPrincipal(RENDERER);
		expect(serving.principal).toEqual(RENDERER);
		expect((await peer.call("host.deps.list")).value).toEqual(["slothlet", "slothlet-vine"]); // remote.** → host.**
		expect((await peer.call("project.files.list", ["p1"])).value).toEqual(["p1/readme.md"]); // condition: args[0] === actor.project
		expect((await peer.call("project.files.list", ["p2"])).error.code).toBe(CODES.DENIED); // condition non-match → default deny
		expect((await peer.call("project.files.remove", ["p1"])).error.code).toBe(CODES.DENIED); // no matching allow rule
		expect(await serveApi.project.files.removeCount()).toBe(0); // the leaf never ran
		expect((await peer.call("secrets.dump")).error.code).toBe(CODES.NO_LEAF); // outside `paths` — the surface filter is first
	});

	it("the same raw frames on an admin channel: the destructive leaf runs", async () => {
		const { serveApi, peer } = await serveWithPrincipal(ADMIN);
		expect((await peer.call("project.files.remove", ["p1"])).value).toBe("removed:p1");
		expect(await serveApi.project.files.removeCount()).toBe(1);
	});

	it("the gate runs BEFORE the args data-only scan: a denied call with a function in its args is DENIED, an allowed one is DATA_ONLY", async () => {
		const { peer } = await serveWithPrincipal(RENDERER);
		expect((await peer.call("project.files.list", [{ cb() {} }])).error.code).toBe(CODES.DENIED); // args[0] !== "p1" → denied first
		expect((await peer.call("project.files.list", ["p1", () => {}])).error.code).toBe(CODES.DATA_ONLY); // allowed, then refused as data-only
	});

	it("VINE_DENIED crosses with the path only — never the principal", async () => {
		const { peer } = await serveWithPrincipal(RENDERER);
		const frame = await peer.call("project.files.remove", ["p1"]);
		expect(frame.error.message).toContain("'project.files.remove'");
		expect(frame.error.message).not.toContain("remote.renderer");
		expect(frame.error).not.toHaveProperty("principal");
	});

	it("the leaf runs under the principal's context, and cannot reassign it (protect)", async () => {
		const { peer } = await serveWithPrincipal(RENDERER);
		expect((await peer.call("project.files.actor")).value).toEqual(RENDERER.context.actor);
		const tamper = await peer.call("project.files.tamper");
		expect(tamper.type).toBe("error");
		expect(tamper.error.code).toBe("CONTEXT_KEY_PROTECTED");
		expect((await peer.call("project.files.actor")).value).toEqual(RENDERER.context.actor); // unchanged
	});

	it("a denial audits on the serving instance's lifecycle bus exactly as a real call's would, marked via checkCall", async () => {
		/**
		 * Serve the principal fixture with `permissions` and collect `event` from its lifecycle bus.
		 * @param {object} permissions - The serving instance's permissions block.
		 * @param {string} event - The lifecycle event to collect.
		 * @returns {Promise<{ peer: object, seen: object[] }>} The raw peer and the collected payloads.
		 */
		async function audited(permissions, event) {
			const serveApi = await instance({ base: PRINCIPAL_DIR, permissions });
			const seen = [];
			serveApi.slothlet.lifecycle.on(event, (data) => seen.push(data));
			const [near, far] = createPair();
			const peer = rawPeer(near);
			const serving = await serve(serveApi, far, { paths: ["host", "project"], principal: RENDERER });
			teardown.push(() => serving.close());
			await peer.surface();
			return { peer, seen };
		}
		const probed = (seen) =>
			seen.some((d) => d.caller === "remote.renderer" && d.target === "project.files.remove" && d.via === "checkCall");

		// An explicit deny rule audits `permission:denied` under the default audit level.
		const explicit = await audited(
			{
				...SERVE_PERMISSIONS,
				rules: [...SERVE_PERMISSIONS.rules, { caller: "remote.renderer", target: "project.files.remove", effect: "deny" }]
			},
			"permission:denied"
		);
		expect((await explicit.peer.call("project.files.remove", ["p1"])).error.code).toBe(CODES.DENIED);
		await settle();
		expect(probed(explicit.seen)).toBe(true);

		// A default-policy deny audits `permission:default`, which slothlet emits under `audit: "verbose"`.
		const byDefault = await audited({ ...SERVE_PERMISSIONS, audit: "verbose" }, "permission:default");
		expect((await byDefault.peer.call("project.files.remove", ["p1"])).error.code).toBe(CODES.DENIED);
		await settle();
		expect(probed(byDefault.seen)).toBe(true);
	});

	it("through a REAL grow: the grow-side stub is not the gate — the serve end denies on its own account", async () => {
		const serveApi = await instance({ base: PRINCIPAL_DIR, permissions: SERVE_PERMISSIONS });
		const growApi = await instance({ base: GROW_DIR, permissions: { defaultPolicy: "allow" } });
		const [near, far] = createPair();
		const serving = await serve(serveApi, far, { paths: ["host", "project"], principal: RENDERER });
		const link = await grow(growApi, near, { budgetMs: 2000 });
		teardown.push(async () => {
			await link.close();
			serving.close();
		});
		expect(await growApi.host.deps.list()).toEqual(["slothlet", "slothlet-vine"]);
		let caught;
		try {
			await growApi.project.files.remove("p1"); // host standing on the GROW side — v1 would have executed it
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.code).toBe(CODES.REMOTE);
		expect(caught.remoteCode).toBe(CODES.DENIED);
		expect(await serveApi.project.files.removeCount()).toBe(0);
	});

	it("a function principal rotates identity per frame without re-serving", async () => {
		let who = RENDERER;
		const { peer } = await serveWithPrincipal(() => who);
		expect((await peer.call("project.files.remove", ["p1"])).error.code).toBe(CODES.DENIED);
		who = ADMIN;
		expect((await peer.call("project.files.remove", ["p1"])).value).toBe("removed:p1");
	});
});

describe.skipIf(!hasCheckCall)("serve({ principal }) — subscriptions are resolved as the channel principal (design § 7.3)", () => {
	it("null is the channel; a forged claim is ignored; a hint under the principal narrows and never widens", async () => {
		const { serveApi, peer } = await serveWithPrincipal(RENDERER);
		const jobs = await peer.sub("jobs.done", null);
		expect(jobs.level).toBe("allow");
		expect((await peer.sub("billing.paid", null)).level).toBe("deny");
		expect((await peer.sub("billing.paid", "remote.admin")).level).toBe("deny");
		expect((await peer.sub("jobs.done", "remote.renderer.audit")).level).toBe("notify");
		expect((await peer.sub("trace.step", "remote.renderer.audit")).level).toBe("notify");
		await serveApi.slothlet.event.emit("jobs.done", { id: 1 });
		await settle();
		expect(peer.deliveries(jobs.subId)[0].payload).toEqual({ id: 1 });
	});

	it("re-resolves per emit after a runtime downgrade", async () => {
		const { serveApi, peer } = await serveWithPrincipal(RENDERER);
		const jobs = await peer.sub("jobs.done", null);
		serveApi.slothlet.event.rules.add({ caller: "remote.renderer", event: "jobs.done", effect: "notify" });
		await serveApi.slothlet.event.emit("jobs.done", { id: 1 });
		await settle();
		expect(peer.deliveries(jobs.subId)).toHaveLength(1);
		expect(peer.deliveries(jobs.subId)[0]).not.toHaveProperty("payload");
	});
});

describe.skipIf(!hasCheckCall)("serve({ principal }) over websocket — one server, two clients, two principals", () => {
	it("the same call is denied on the renderer socket and allowed on the admin socket", async () => {
		const serveApi = await instance({ base: PRINCIPAL_DIR, permissions: SERVE_PERMISSIONS });
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.add(wss);
		teardown.push(() => new Promise((resolve) => wss.close(() => resolve())));
		await once(wss, "listening");
		const { port } = wss.address();
		// The fake handshake: the identity comes from the upgrade request, never from a frame.
		wss.on("connection", async (socket, request) => {
			const channel = createWsChannel(socket);
			const who = new URL(request.url, "ws://localhost").searchParams.get("who") === "admin" ? ADMIN : RENDERER;
			await serve(serveApi, channel, { paths: ["host", "project"], principal: who });
		});
		/**
		 * @param {string} who - `renderer` / `admin`.
		 * @returns {Promise<object>} A raw peer over a live client socket.
		 */
		async function client(who) {
			const socket = new WebSocket(`ws://127.0.0.1:${port}/?who=${who}`);
			// Wrap BEFORE any await: `ws` drops a message that arrives with no listener, and the server's
			// surface frame can land the moment the socket opens (TRANSPORTS.md).
			const peer = rawPeer(createWsChannel(socket));
			teardown.push(() => socket.terminate());
			await once(socket, "open");
			await peer.surface();
			return peer;
		}
		const renderer = await client("renderer");
		const admin = await client("admin");
		expect((await renderer.call("project.files.remove", ["p1"])).error.code).toBe(CODES.DENIED);
		expect((await admin.call("project.files.remove", ["p1"])).value).toBe("removed:p1");
		expect((await renderer.call("host.deps.list")).value).toEqual(["slothlet", "slothlet-vine"]);
	});
});
