/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/events-units.test.vitest.mjs
 *	@Date: 2026-09-28T03:15:48+00:00 (1790565348)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:22-07:00 (1790968822)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect } from "vitest";
import { createEventForwarder } from "../src/lib/events.mjs";
import { CODES } from "../src/lib/errors.mjs";

/**
 * A fake slothlet instance exposing only the event surfaces the forwarder touches.
 * @param {object} [behaviour]
 * @param {boolean} [behaviour.noEvent] - Omit `slothlet.event` (an instance that predates event forwarding).
 * @param {boolean} [behaviour.noCaller] - Omit `slothlet.caller`.
 * @param {Function} [behaviour.on] - Replacement for `event.on`.
 * @returns {object} The fake api; `api.hostListeners` counts `event.on` registrations.
 */
function fakeApi(behaviour = {}) {
	const api = {
		hostListeners: 0,
		slothlet: {
			caller: () => "events.consumer",
			event: {
				resolveLevel: () => "allow",
				on:
					behaviour.on ??
					(() => {
						api.hostListeners++;
						return { off() {} };
					})
			}
		}
	};
	if (behaviour.noEvent) delete api.slothlet.event;
	if (behaviour.noCaller) delete api.slothlet.caller;
	return api;
}

/**
 * Build a forwarder over a recording channel.
 * @param {object} [behaviour]
 * @param {object} [behaviour.api] - The fake api (default: a fully capable one).
 * @param {Function} [behaviour.send] - Replacement `channel.send`.
 * @param {() => ("gone"|"closed"|null)} [behaviour.ended] - Terminal state probe.
 * @returns {{ forwarder: object, sent: object[], api: object }} The forwarder plus what it sent.
 */
function make(behaviour = {}) {
	const sent = [];
	const api = behaviour.api ?? fakeApi();
	const channel = {
		send: behaviour.send ?? ((frame) => sent.push(frame)),
		onMessage() {}
	};
	const forwarder = createEventForwarder({ api, channel, budgetMs: 1000, ended: behaviour.ended ?? (() => null) });
	return { forwarder, sent, api };
}

describe("createEventForwarder — the serving half", () => {
	it("acks deny for every far sub when the instance cannot resolve levels or subscribe", () => {
		const { forwarder, sent } = make({ api: fakeApi({ noEvent: true }) });
		forwarder.handleFrame({ type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null });
		expect(sent).toEqual([{ type: "sub-ack", subId: "s1", level: "deny" }]);
	});

	it("ignores a repeated subId, so a hostile far side cannot register a second host listener", () => {
		const { forwarder, sent, api } = make();
		const frame = { type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null };
		forwarder.handleFrame(frame);
		forwarder.handleFrame(frame);
		expect(api.hostListeners).toBe(1);
		expect(sent.filter((f) => f.type === "sub-ack")).toHaveLength(1);
	});

	it("acks the level but registers nothing when the instance refuses the host subscription", () => {
		const { forwarder, sent } = make({
			api: fakeApi({
				on: () => {
					throw new Error("locked down");
				}
			})
		});
		forwarder.handleFrame({ type: "sub", subId: "s1", event: "jobs.done", subscriberPath: null });
		expect(sent).toEqual([{ type: "sub-ack", subId: "s1", level: "allow" }]);
		// There is nothing registered under this id, so an unsub for it is a no-op rather than an error.
		expect(() => forwarder.handleFrame({ type: "unsub", subId: "s1" })).not.toThrow();
	});

	it("an unsub for a subscription that never existed is a no-op", () => {
		const { forwarder, sent } = make();
		forwarder.handleFrame({ type: "unsub", subId: "never" });
		expect(sent).toEqual([]);
	});
});

describe("createEventForwarder — the subscribing half", () => {
	it("rejects a bad event name, a non-function listener, and an instance with no caller()", async () => {
		const { forwarder } = make();
		await expect(forwarder.subscribe("", () => {}, false)).rejects.toThrow(/non-empty event name/);
		await expect(forwarder.subscribe(42, () => {}, false)).rejects.toThrow(/non-empty event name/);
		await expect(forwarder.subscribe("jobs.done", "nope", false)).rejects.toThrow(/listener function/);
		const noCaller = make({ api: fakeApi({ noCaller: true }) });
		await expect(noCaller.forwarder.subscribe("jobs.done", () => {}, false)).rejects.toThrow(/api\.slothlet\.caller\(\)/);
	});

	it("refuses with VINE_GONE or VINE_CLOSED once the end has terminated", async () => {
		const gone = make({ ended: () => "gone" });
		await expect(gone.forwarder.subscribe("jobs.done", () => {}, false)).rejects.toMatchObject({ code: CODES.GONE });
		const closed = make({ ended: () => "closed" });
		await expect(closed.forwarder.subscribe("jobs.done", () => {}, false)).rejects.toMatchObject({ code: CODES.CLOSED });
	});

	it.each([
		["an Error", new Error("socket died"), "socket died"],
		["a thrown string", "boom", "boom"]
	])("settles VINE_BAD_FRAME when the sub frame cannot be sent (%s)", async (_label, thrown, text) => {
		const { forwarder } = make({
			send: () => {
				throw thrown;
			}
		});
		await expect(forwarder.subscribe("jobs.done", () => {}, false)).rejects.toMatchObject({
			code: CODES.BAD_FRAME,
			message: expect.stringContaining(text)
		});
	});

	it("off() unsubscribes once; a second off() sends nothing more", async () => {
		const { forwarder, sent } = make();
		const pending = forwarder.subscribe("jobs.done", () => {}, false);
		const { subId } = sent[0];
		forwarder.handleFrame({ type: "sub-ack", subId, level: "allow" });
		const { off } = await pending;
		off();
		off();
		expect(sent.filter((f) => f.type === "unsub")).toEqual([{ type: "unsub", subId }]);
	});

	it("resolves a denied subscription with a no-op off() and registers no delivery", async () => {
		const { forwarder, sent } = make();
		const pending = forwarder.subscribe("jobs.done", () => {}, false);
		const { subId } = sent[0];
		forwarder.handleFrame({ type: "sub-ack", subId, level: "deny" });
		const { level, off } = await pending;
		expect(level).toBe("deny");
		expect(off()).toBeUndefined();
		expect(sent.filter((f) => f.type === "unsub")).toEqual([]);
	});
});
