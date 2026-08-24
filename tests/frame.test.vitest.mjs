/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/frame.test.vitest.mjs
 *
 * Frame construction, the TOTAL frame validator, and the two guards it exists for: prototype-
 * polluting paths and function-valued arguments.
 *
 * The prototype-pollution case is not hypothetical. Probed against @cldmv/slothlet 3.14.0,
 * `api.slothlet.api.add("__proto__.x", fn)` is accepted and lands the function on
 * `Object.prototype` — so a `surface` frame is an untrusted input with a real exploit behind it.
 */
import { describe, it, expect } from "vitest";
import {
	FRAME_VERSION,
	UNSAFE_SEGMENTS,
	callFrame,
	errorFrame,
	findFunctionArg,
	isSafePath,
	isSafeSegment,
	parseFrame,
	resultFrame,
	surfaceFrame
} from "../src/lib/frame.mjs";

describe("frame constructors", () => {
	it("builds a surface frame with a copied leaf list", () => {
		const leaves = ["a.b", "c"];
		const frame = surfaceFrame(leaves);
		expect(frame).toEqual({ type: "surface", v: FRAME_VERSION, leaves: ["a.b", "c"] });
		leaves.push("mutated");
		expect(frame.leaves).toHaveLength(2);
	});

	it("builds call / result / error frames", () => {
		expect(callFrame("n#1", "a.b", [1, 2])).toEqual({ type: "call", callId: "n#1", path: "a.b", args: [1, 2] });
		expect(resultFrame("n#1", "v")).toEqual({ type: "result", callId: "n#1", value: "v" });
		expect(resultFrame("n#1", undefined)).toEqual({ type: "result", callId: "n#1", value: undefined });
		const err = errorFrame("n#1", new Error("bad"));
		expect(err.type).toBe("error");
		expect(err.error.message).toBe("bad");
	});
});

describe("path guards", () => {
	it("accepts ordinary dotted leaf paths", () => {
		for (const path of ["a", "a.b", "exts.pdfViewer.open", "_private", "$dollar", "a1.b2"]) {
			expect(isSafePath(path)).toBe(true);
		}
	});

	it("rejects every prototype-walking segment", () => {
		for (const path of ["__proto__", "__proto__.x", "a.__proto__.b", "constructor", "constructor.prototype.pwn", "a.prototype.b"]) {
			expect(isSafePath(path)).toBe(false);
		}
	});

	it("rejects the slothlet control plane and the instance teardown handles", () => {
		for (const path of ["slothlet", "slothlet.api.remove", "shutdown", "destroy", "a.slothlet"]) {
			expect(isSafePath(path)).toBe(false);
		}
		expect([...UNSAFE_SEGMENTS]).toEqual(expect.arrayContaining(["__proto__", "constructor", "prototype", "slothlet"]));
	});

	it("rejects malformed paths", () => {
		for (const path of ["", ".", "a.", ".a", "a..b", "a b", "a-b", "a/b", "a[0]", 7, null, undefined, {}]) {
			expect(isSafePath(path)).toBe(false);
		}
	});

	it("isSafeSegment mirrors the per-segment rule", () => {
		expect(isSafeSegment("ok")).toBe(true);
		expect(isSafeSegment("__proto__")).toBe(false);
		expect(isSafeSegment("a.b")).toBe(false);
		expect(isSafeSegment(5)).toBe(false);
	});

	it("accepts any JavaScript identifier name, not just the ASCII ones", () => {
		// A leaf's name is its EXPORT name, which slothlet does not sanitize: `export function café()`
		// is a real callable leaf, and an ASCII-only guard used to drop it from the surface in silence.
		for (const path of ["intl.café", "ünïcødé", "日本語.leaf", "Ω.α", "_ok.$ok"]) {
			expect(isSafePath(path)).toBe(true);
		}
	});

	it("still refuses a name that is not an identifier, however exotic", () => {
		for (const segment of ["1leaf", "a b", "a-b", "emoji😀", "with space", ""]) {
			expect(isSafeSegment(segment)).toBe(false);
		}
	});
});

describe("findFunctionArg", () => {
	it("passes a data-only argument graph", () => {
		expect(findFunctionArg([])).toBeNull();
		expect(findFunctionArg([1, "two", null, undefined, { a: [1, { b: 2 }] }, new Map([["k", 1]]), new Set([1, 2])])).toBeNull();
	});

	it("finds a top-level function", () => {
		expect(findFunctionArg([() => {}])).toBe("arg[0]");
	});

	it("finds a nested function and reports where", () => {
		expect(findFunctionArg([{ onDone: () => {} }])).toBe("arg[0].onDone");
		expect(findFunctionArg([[1, [2, () => {}]]])).toBe("arg[0][1][1]");
		expect(findFunctionArg([new Map([["cb", () => {}]])])).toBe("arg[0].get(cb)");
		expect(findFunctionArg([new Set([1, () => {}])])).toBe("arg[0].item[1]");
	});

	it("finds a function used as a Map KEY", () => {
		expect(findFunctionArg([new Map([[() => {}, 1]])])).toBe("arg[0].key");
	});

	it("finds a symbol-keyed function", () => {
		const key = Symbol("cb");
		expect(findFunctionArg([{ [key]: () => {} }])).toContain("Symbol(cb)");
	});

	it("is cycle-safe", () => {
		const cyclic = { name: "loop" };
		cyclic.self = cyclic;
		expect(findFunctionArg([cyclic])).toBeNull();
		cyclic.fn = () => {};
		expect(findFunctionArg([cyclic])).toBe("arg[0].fn");
	});

	it("never invokes a getter (a getter-returned function is not detected, by design)", () => {
		let invoked = false;
		const obj = {
			get sneaky() {
				invoked = true;
				return () => {};
			}
		};
		expect(findFunctionArg([obj])).toBeNull();
		expect(invoked).toBe(false);
	});

	it("treats a non-array args value as suspect", () => {
		expect(findFunctionArg("not an array")).toBe("arguments");
		expect(findFunctionArg(null)).toBe("arguments");
	});
});

describe("parseFrame", () => {
	it("parses a surface frame and filters unsafe leaves onto .unsafe", () => {
		const frame = parseFrame({ type: "surface", v: 1, leaves: ["a.b", "__proto__.x", "slothlet.api.remove", 7] });
		expect(frame.type).toBe("surface");
		expect(frame.leaves).toEqual(["a.b"]);
		expect(frame.unsafe).toEqual(["__proto__.x", "slothlet.api.remove", "7"]);
	});

	it("rejects a surface frame of the wrong version or shape", () => {
		expect(parseFrame({ type: "surface", v: 2, leaves: [] })).toBeNull();
		expect(parseFrame({ type: "surface", leaves: [] })).toBeNull();
		expect(parseFrame({ type: "surface", v: 1, leaves: "nope" })).toBeNull();
	});

	it("parses a call frame and copies its args", () => {
		const args = [1, { a: 2 }];
		const frame = parseFrame({ type: "call", callId: "n#1", path: "a.b", args });
		expect(frame).toEqual({ type: "call", callId: "n#1", path: "a.b", args: [1, { a: 2 }] });
		args.push("mutated");
		expect(frame.args).toHaveLength(2);
	});

	it("REJECTS a call frame whose path is unsafe — there is no partial reading of 'invoke this'", () => {
		expect(parseFrame({ type: "call", callId: "n#1", path: "__proto__.x", args: [] })).toBeNull();
		expect(parseFrame({ type: "call", callId: "n#1", path: "slothlet.api.remove", args: [] })).toBeNull();
		expect(parseFrame({ type: "call", callId: "n#1", path: "a.b", args: "nope" })).toBeNull();
	});

	it("parses result and error frames", () => {
		expect(parseFrame({ type: "result", callId: "n#1", value: 5 })).toEqual({ type: "result", callId: "n#1", value: 5 });
		expect(parseFrame({ type: "result", callId: "n#1" })).toEqual({ type: "result", callId: "n#1", value: undefined });
		const err = parseFrame({ type: "error", callId: "n#1", error: { name: "E", message: "m" } });
		expect(err.error.message).toBe("m");
		expect(parseFrame({ type: "error", callId: "n#1", error: "not an object" })).toBeNull();
	});

	it("requires a non-empty string callId on every correlated frame", () => {
		expect(parseFrame({ type: "call", callId: "", path: "a", args: [] })).toBeNull();
		expect(parseFrame({ type: "result", callId: 7, value: 1 })).toBeNull();
		expect(parseFrame({ type: "error", callId: null, error: {} })).toBeNull();
	});

	it("returns null for unknown frame types (forward compatibility)", () => {
		expect(parseFrame({ type: "stream", callId: "n#1" })).toBeNull();
		expect(parseFrame({ type: "surface2", v: 1, leaves: [] })).toBeNull();
	});

	it("never throws on junk", () => {
		const junk = [null, undefined, 0, 1, "", "frame", true, [], [1, 2], Symbol("s"), () => {}, new Date(), { type: 7 }, {}];
		for (const value of junk) expect(parseFrame(value)).toBeNull();
	});

	it("never throws on a hostile object with a throwing accessor", () => {
		const hostile = {
			get type() {
				throw new Error("gotcha");
			}
		};
		expect(parseFrame(hostile)).toBeNull();
	});

	it("does not let a __proto__ key in the frame itself pollute anything", () => {
		const polluted = JSON.parse('{"type":"result","callId":"n#1","value":1,"__proto__":{"pwned":true}}');
		expect(parseFrame(polluted)).toEqual({ type: "result", callId: "n#1", value: 1 });
		expect({}.pwned).toBeUndefined();
	});
});
