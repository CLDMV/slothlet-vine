/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/inbox.test.vitest.mjs
 *
 * The pre-handler inbox shared by the built-in port/socket transports (CLDMV/slothlet-vine#41): a
 * frame the transport receives before the core has registered its handler is queued, and replayed —
 * in arrival order, ahead of anything newer — once a handler exists.
 */
import { describe, it, expect } from "vitest";
import { createInbox } from "../src/lib/inbox.mjs";

/** Let queued microtasks (the replay) run. @returns {Promise<void>} */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createInbox", () => {
	it("delivers straight to a registered handler", () => {
		const inbox = createInbox();
		const seen = [];
		inbox.setHandler((f) => seen.push(f));
		inbox.deliver("a");
		expect(seen).toEqual(["a"]);
	});

	it("queues frames that arrive before a handler and replays them in order on registration", async () => {
		const inbox = createInbox();
		inbox.deliver("early-1");
		inbox.deliver("early-2");
		const seen = [];
		inbox.setHandler((f) => seen.push(f));
		expect(seen).toEqual([]); // replay is asynchronous — never re-entrant inside setHandler()
		await tick();
		expect(seen).toEqual(["early-1", "early-2"]);
	});

	it("keeps a frame that arrives while a replay is pending BEHIND the queued ones", async () => {
		const inbox = createInbox();
		inbox.deliver("early");
		const seen = [];
		inbox.setHandler((f) => seen.push(f));
		inbox.deliver("late"); // arrives before the replay microtask has run
		await tick();
		expect(seen).toEqual(["early", "late"]);
	});

	it("replays to the handler registered LAST, and schedules only one replay", async () => {
		const inbox = createInbox();
		inbox.deliver("early");
		const first = [];
		const second = [];
		inbox.setHandler((f) => first.push(f));
		inbox.setHandler((f) => second.push(f));
		await tick();
		expect(first).toEqual([]);
		expect(second).toEqual(["early"]);
	});

	it("a non-function registration clears the handler, and frames queue again until the next one", async () => {
		const inbox = createInbox();
		const seen = [];
		inbox.setHandler((f) => seen.push(f));
		inbox.setHandler(null);
		inbox.deliver("while-cleared");
		expect(seen).toEqual([]);
		inbox.setHandler("not a function");
		await tick();
		expect(seen).toEqual([]);
		const later = [];
		inbox.setHandler((f) => later.push(f));
		await tick();
		expect(later).toEqual(["while-cleared"]);
	});

	it("a handler that clears itself mid-replay stops the replay; the rest stays queued", async () => {
		const inbox = createInbox();
		inbox.deliver("one");
		inbox.deliver("two");
		const seen = [];
		inbox.setHandler((f) => {
			seen.push(f);
			inbox.setHandler(null);
		});
		await tick();
		expect(seen).toEqual(["one"]);
		const rest = [];
		inbox.setHandler((f) => rest.push(f));
		await tick();
		expect(rest).toEqual(["two"]);
	});

	it("a throwing handler never escapes, and does not stop the rest of the replay", async () => {
		const inbox = createInbox();
		inbox.deliver("boom");
		inbox.deliver("after");
		const seen = [];
		inbox.setHandler((f) => {
			seen.push(f);
			if (f === "boom") throw new Error("consumer handler threw");
		});
		await tick();
		expect(seen).toEqual(["boom", "after"]);
		expect(() => inbox.deliver("boom")).not.toThrow();
	});

	it("close() discards the queue and makes the inbox inert", async () => {
		const inbox = createInbox();
		inbox.deliver("queued");
		const seen = [];
		inbox.setHandler((f) => seen.push(f));
		inbox.close(); // before the replay runs
		inbox.deliver("after-close");
		await tick();
		expect(seen).toEqual([]);
		inbox.setHandler((f) => seen.push(f));
		await tick();
		expect(seen).toEqual([]);
	});
});
