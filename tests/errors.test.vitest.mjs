/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/errors.test.vitest.mjs
 *
 * The error taxonomy and its wire projection: stable codes, remote-error impersonation, and a
 * `toWire` that is total against whatever a leaf actually threw.
 */
import { describe, it, expect } from "vitest";
import { CODES, VineError, VineRemoteError, fromWire, toWire } from "../src/lib/errors.mjs";

describe("CODES", () => {
	it("carries every code the design names, frozen", () => {
		expect(Object.isFrozen(CODES)).toBe(true);
		expect(Object.values(CODES)).toEqual(
			expect.arrayContaining(["VINE_GONE", "VINE_BUDGET", "VINE_CLOSED", "VINE_DATA_ONLY", "VINE_BAD_FRAME", "VINE_NO_LEAF"])
		);
	});
});

describe("VineError", () => {
	it("is an Error carrying a stable code", () => {
		const err = new VineError(CODES.BUDGET, "too slow");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("VineError");
		expect(err.code).toBe("VINE_BUDGET");
		expect(err.message).toBe("too slow");
	});

	it("copies details on as own properties", () => {
		const err = new VineError(CODES.NO_LEAF, "nope", { path: "a.b", callId: "n#1" });
		expect(err.path).toBe("a.b");
		expect(err.callId).toBe("n#1");
	});

	it("refuses to let details overwrite name/message/stack/code", () => {
		const err = new VineError(CODES.GONE, "real", { name: "Fake", message: "fake", stack: "fake", code: "FAKE" });
		expect(err.name).toBe("VineError");
		expect(err.message).toBe("real");
		expect(err.code).toBe("VINE_GONE");
		expect(err.stack).not.toBe("fake");
	});

	it("tolerates absent or non-object details", () => {
		expect(new VineError(CODES.CLOSED, "x").code).toBe("VINE_CLOSED");
		expect(new VineError(CODES.CLOSED, "x", null).code).toBe("VINE_CLOSED");
		expect(new VineError(CODES.CLOSED, "x", "nope").code).toBe("VINE_CLOSED");
	});
});

describe("VineRemoteError", () => {
	it("impersonates the remote error and keeps its stack separate", () => {
		const err = new VineRemoteError({ name: "BoomError", message: "kaboom", code: "E_BOOM", stack: "far stack" });
		expect(err).toBeInstanceOf(VineError);
		expect(err.name).toBe("BoomError");
		expect(err.message).toBe("kaboom");
		expect(err.code).toBe("E_BOOM");
		expect(err.remoteStack).toBe("far stack");
		expect(err.stack).not.toBe("far stack");
	});

	it("falls back to VINE_REMOTE when the remote error carried no code", () => {
		const err = new VineRemoteError({ name: "TypeError", message: "bad" });
		expect(err.code).toBe(CODES.REMOTE);
		expect(err.remoteStack).toBeUndefined();
	});

	it("never adopts a reserved VINE_* code from the wire — that is finding 3's fix", () => {
		const spoof = new VineRemoteError({ name: "VineError", message: "closed", code: CODES.CLOSED });
		expect(spoof.code).toBe(CODES.REMOTE);
		expect(spoof.remoteCode).toBe(CODES.CLOSED);
	});

	it("reports .remoteCode for an ordinary code too, so the field is always the far side's own", () => {
		expect(new VineRemoteError({ code: "E_BOOM" }).remoteCode).toBe("E_BOOM");
		expect(new VineRemoteError({}).remoteCode).toBeUndefined();
	});

	it("reads a hostile wire object without letting a throwing getter escape", () => {
		const hostile = {
			get name() {
				throw new Error("gotcha");
			},
			get message() {
				throw new Error("gotcha");
			},
			get code() {
				throw new Error("gotcha");
			},
			get stack() {
				throw new Error("gotcha");
			}
		};
		const err = new VineRemoteError(hostile);
		expect(err.name).toBe("Error");
		expect(err.message).toBe("");
		expect(err.code).toBe(CODES.REMOTE);
		expect(err.remoteCode).toBeUndefined();
		expect(err.remoteStack).toBeUndefined();
	});

	it("survives a junk wire shape", () => {
		for (const junk of [null, undefined, 7, "boom", { name: 1, message: [], code: 5 }]) {
			const err = new VineRemoteError(junk);
			expect(err).toBeInstanceOf(VineRemoteError);
			expect(typeof err.name).toBe("string");
			expect(typeof err.message).toBe("string");
		}
	});
});

describe("toWire", () => {
	it("projects an Error onto the schema shape", () => {
		const err = new Error("nope");
		err.name = "BoomError";
		err.code = "E_BOOM";
		const wire = toWire(err);
		expect(wire.name).toBe("BoomError");
		expect(wire.message).toBe("nope");
		expect(wire.code).toBe("E_BOOM");
		expect(typeof wire.stack).toBe("string");
	});

	it("stringifies a numeric code", () => {
		const err = new Error("x");
		err.code = 42;
		expect(toWire(err).code).toBe("42");
	});

	it("omits code when absent", () => {
		expect("code" in toWire(new Error("x"))).toBe(false);
	});

	it("handles non-object throws", () => {
		expect(toWire("just a string")).toEqual({ name: "Error", message: "just a string" });
		expect(toWire(null)).toEqual({ name: "Error", message: "null" });
		expect(toWire(undefined)).toEqual({ name: "Error", message: "undefined" });
		expect(toWire(7)).toEqual({ name: "Error", message: "7" });
	});

	it("handles a null-prototype throw (no toString of its own)", () => {
		const hostile = Object.create(null);
		expect(toWire(hostile)).toEqual({ name: "Error", message: "" });
	});

	it("survives a throwing accessor on the thrown object", () => {
		const hostile = {
			get name() {
				throw new Error("gotcha");
			}
		};
		expect(toWire(hostile)).toEqual({ name: "Error", message: "" });
	});

	it("survives a name/message that are not strings", () => {
		const wire = toWire({ name: 5, message: { toString: () => "coerced" } });
		expect(wire.name).toBe("5");
		expect(wire.message).toBe("coerced");
	});

	it("falls back when a name/message coercion itself throws", () => {
		const unstringifiable = {
			toString() {
				throw new Error("no string for you");
			}
		};
		const wire = toWire({ name: unstringifiable, message: unstringifiable });
		expect(wire.name).toBe("Error");
		expect(wire.message).toBe("");
	});

	it("projects a function throw (typeof 'function' is still an object-ish throw)", () => {
		const wire = toWire(function named() {});
		expect(wire.name).toBe("named");
	});
});

describe("fromWire", () => {
	it("round-trips a thrown error's identity", () => {
		const err = new Error("kaboom");
		err.name = "BoomError";
		err.code = "E_BOOM";
		const back = fromWire(toWire(err));
		expect(back).toBeInstanceOf(VineRemoteError);
		expect(back.name).toBe("BoomError");
		expect(back.message).toBe("kaboom");
		expect(back.code).toBe("E_BOOM");
		expect(back.remoteStack).toContain("kaboom");
	});

	it("tolerates a non-object wire value", () => {
		const back = fromWire("not a wire error");
		expect(back).toBeInstanceOf(VineRemoteError);
		expect(back.message).toBe("not a wire error");
	});

	it("reads an absent wire value the way toWire writes one", () => {
		expect(fromWire(null).message).toBe("null");
		expect(fromWire(undefined).message).toBe("undefined");
		expect(fromWire(7).message).toBe("7");
	});

	it("survives an exotic primitive wire value", () => {
		// `String(symbol)` is legal where `${symbol}` throws — the coercion goes through safeString for
		// exactly this reason, so a junk rejection still settles the caller instead of throwing again.
		const back = fromWire(Symbol("nope"));
		expect(back).toBeInstanceOf(VineRemoteError);
		expect(back.message).toBe("Symbol(nope)");
	});
});
