/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/link.test.vitest.mjs
 *
 * The correlation machinery in isolation: settle-once, budget timers, bulk settle, and the two
 * misuse guards (`assertChannel` / `assertApi`).
 */
import { describe, it, expect, vi } from "vitest";
import { PendingTable, assertApi, assertChannel, makeNonce, onCloseSafe } from "../src/lib/link.mjs";
import { CODES, VineError } from "../src/lib/errors.mjs";

/**
 * @returns {PendingTable} A table with a fixed nonce, for predictable ids.
 */
function table() {
	return new PendingTable("nonce");
}

describe("makeNonce", () => {
	it("produces distinct non-empty strings", () => {
		const seen = new Set();
		for (let i = 0; i < 200; i++) seen.add(makeNonce());
		expect(seen.size).toBe(200);
		expect([...seen].every((value) => typeof value === "string" && value.length > 0)).toBe(true);
	});

	it("stays collision-free on the no-crypto fallback (older browsers, insecure contexts)", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		try {
			Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
			const seen = new Set();
			for (let i = 0; i < 200; i++) seen.add(makeNonce());
			// The process-local counter alone guarantees this, without leaning on Math.random.
			expect(seen.size).toBe(200);
		} finally {
			if (original) Object.defineProperty(globalThis, "crypto", original);
			else delete globalThis.crypto;
		}
	});
});

describe("PendingTable ids", () => {
	it("uses a monotonic counter behind the link nonce", () => {
		const pending = table();
		expect(pending.nextCallId()).toBe("nonce#1");
		expect(pending.nextCallId()).toBe("nonce#2");
	});
});

describe("PendingTable settling", () => {
	it("resolves a pending call", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.b", budgetMs: 1000 });
		expect(pending.size).toBe(1);
		expect(pending.has(id)).toBe(true);
		expect(pending.resolve(id, 42)).toBe(true);
		await expect(promise).resolves.toBe(42);
		expect(pending.size).toBe(0);
	});

	it("rejects a pending call", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.b", budgetMs: 1000 });
		pending.reject(id, new VineError(CODES.NO_LEAF, "gone"));
		await expect(promise).rejects.toMatchObject({ code: CODES.NO_LEAF });
	});

	it("settles ONCE — every later terminal is dropped", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.b", budgetMs: 1000 });
		expect(pending.resolve(id, "first")).toBe(true);
		expect(pending.resolve(id, "second")).toBe(false);
		expect(pending.reject(id, new Error("late"))).toBe(false);
		await expect(promise).resolves.toBe("first");
	});

	it("ignores terminals for an unknown callId", () => {
		const pending = table();
		expect(pending.resolve("never-opened", 1)).toBe(false);
		expect(pending.reject("never-opened", new Error("x"))).toBe(false);
		expect(pending.has("never-opened")).toBe(false);
	});

	it("fires the budget timer with a VINE_BUDGET error", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.slow", budgetMs: 20 });
		await expect(promise).rejects.toMatchObject({ code: CODES.BUDGET, path: "a.slow", callId: id, budgetMs: 20 });
		expect(pending.size).toBe(0);
	});

	it("drops a result that arrives after the budget expired", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.slow", budgetMs: 10 });
		await expect(promise).rejects.toMatchObject({ code: CODES.BUDGET });
		expect(pending.resolve(id, "too late")).toBe(false);
	});

	it("clears the budget timer when a call settles normally", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.b", budgetMs: 20 });
		pending.resolve(id, "quick");
		await expect(promise).resolves.toBe("quick");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(pending.size).toBe(0);
	});

	it("arms no timer for a non-positive or non-finite budget", async () => {
		const pending = table();
		for (const budgetMs of [0, -5, Infinity, NaN, undefined]) {
			const id = pending.nextCallId();
			const promise = pending.open(id, { path: "a.b", budgetMs });
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(pending.has(id)).toBe(true);
			pending.resolve(id, "ok");
			await expect(promise).resolves.toBe("ok");
		}
	});

	it("tolerates a budget timer handle with no unref() (a browser-style setTimeout)", async () => {
		// Node's setTimeout returns a Timeout with unref(); a browser's returns a bare number. The
		// `timer && typeof timer.unref === "function"` guard exists for that second case — reproduce it
		// faithfully by wrapping the real timer (so it still fires) in a handle that lacks unref(),
		// rather than asserting a tautology.
		const realSetTimeout = globalThis.setTimeout;
		vi.stubGlobal("setTimeout", (fn, ms) => ({ id: realSetTimeout(fn, ms) }));
		try {
			const pending = table();
			const id = pending.nextCallId();
			// Let the budget expire naturally (never resolved early) — clearTimeout is never invoked on
			// this fake handle, so there is nothing to mismatch against the real underlying timer.
			const promise = pending.open(id, { path: "a.slow", budgetMs: 10 });
			await expect(promise).rejects.toMatchObject({ code: CODES.BUDGET });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("PendingTable.settleAll", () => {
	it("rejects every pending call with the given code and drains the table", async () => {
		const pending = table();
		const ids = [pending.nextCallId(), pending.nextCallId(), pending.nextCallId()];
		const promises = ids.map((id) => pending.open(id, { path: `p.${id}`, budgetMs: 5000 }));
		expect(pending.settleAll(CODES.GONE, "far side gone")).toBe(3);
		expect(pending.size).toBe(0);
		for (const [index, promise] of promises.entries()) {
			await expect(promise).rejects.toMatchObject({ code: CODES.GONE, message: "far side gone", callId: ids[index] });
		}
	});

	it("is a no-op on an empty table", () => {
		expect(table().settleAll(CODES.CLOSED, "x")).toBe(0);
	});

	it("settles an entry that has no timer (a budget-less call)", async () => {
		const pending = table();
		const id = pending.nextCallId();
		const promise = pending.open(id, { path: "a.b", budgetMs: 0 });
		expect(pending.settleAll(CODES.GONE, "gone")).toBe(1);
		await expect(promise).rejects.toMatchObject({ code: CODES.GONE });
	});

	it("drains BEFORE rejecting, so a re-entrant handler sees an empty table", async () => {
		const pending = table();
		const id = pending.nextCallId();
		let sizeDuringRejection = -1;
		const promise = pending.open(id, { path: "a.b", budgetMs: 5000 }).catch(() => {
			sizeDuringRejection = pending.size;
		});
		pending.settleAll(CODES.CLOSED, "closed");
		await promise;
		expect(sizeDuringRejection).toBe(0);
	});
});

describe("assertChannel", () => {
	it("accepts a minimal Channel", () => {
		expect(() => assertChannel({ send() {}, onMessage() {} }, "grow")).not.toThrow();
	});

	it("rejects anything missing send or onMessage", () => {
		for (const bad of [null, undefined, 7, "channel", {}, { send() {} }, { onMessage() {} }, { send: 1, onMessage() {} }]) {
			expect(() => assertChannel(bad, "grow")).toThrow(TypeError);
		}
		expect(() => assertChannel({}, "grow")).toThrow(/grow\(\) needs a Channel/);
	});
});

describe("assertApi", () => {
	it("accepts an object exposing the required api.slothlet.api methods", () => {
		const api = { slothlet: { api: { add() {}, remove() {}, leaves() {} } } };
		expect(() => assertApi(api, "grow", ["add", "remove"])).not.toThrow();
	});

	it("names the missing methods", () => {
		const api = { slothlet: { api: { add() {} } } };
		expect(() => assertApi(api, "grow", ["add", "remove"])).toThrow(/remove/);
		expect(() => assertApi({}, "serve", ["leaves"])).toThrow(/leaves/);
		expect(() => assertApi(null, "serve", ["leaves"])).toThrow(TypeError);
	});
});

describe("onCloseSafe", () => {
	it("reports false when the transport has no onClose", () => {
		expect(onCloseSafe({ send() {}, onMessage() {} }, () => {})).toBe(false);
	});

	it("registers the handler and swallows anything it throws", () => {
		let registered = null;
		const channel = {
			onClose(handler) {
				registered = handler;
			}
		};
		expect(
			onCloseSafe(channel, () => {
				throw new Error("handler blew up");
			})
		).toBe(true);
		expect(() => registered({ reason: "peer-closed" })).not.toThrow();
	});

	it("forwards the close info", () => {
		let registered = null;
		let seen = null;
		onCloseSafe(
			{
				onClose(handler) {
					registered = handler;
				}
			},
			(info) => {
				seen = info;
			}
		);
		registered({ reason: "peer-closed" });
		expect(seen).toEqual({ reason: "peer-closed" });
	});
});
