/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/frame.test.vitest.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:21-07:00 (1790968821)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { describe, it, expect } from "vitest";
import {
	FRAME_VERSION,
	UNSAFE_SEGMENTS,
	callFrame,
	errorFrame,
	findContextFault,
	findFunctionArg,
	isPlainObject,
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

	it("labels an object Map key generically rather than stringifying it", () => {
		expect(findFunctionArg([new Map([[{}, () => {}]])])).toBe("arg[0].get(<object>)");
	});

	it("labels a null Map key as the literal 'null', not the generic object placeholder", () => {
		// typeof null === "object", but null has no methods to guard against — spell it out plainly.
		expect(findFunctionArg([new Map([[null, () => {}]])])).toBe("arg[0].get(null)");
	});

	it("never runs a Map key's toString — not even a hostile one, not even when the value is ordinary data", () => {
		let called = false;
		// toString lives on the PROTOTYPE, not as an own property, so this exercises only the label
		// construction — Reflect.ownKeys(hostileKey) finds nothing, so the walk of the key itself
		// (which legitimately inspects a key's own function-valued properties) is not what's on trial.
		class HostileKey {
			toString() {
				called = true;
				return "should never run";
			}
		}
		const hostileKey = new HostileKey();
		expect(() => findFunctionArg([new Map([[hostileKey, "just data"]])])).not.toThrow();
		expect(findFunctionArg([new Map([[hostileKey, "just data"]])])).toBeNull();
		expect(called).toBe(false);
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

describe("requested context (#79) — frames and the data-only rules", () => {
	it("a surface frame advertises `context: true` only when asked, and is the v1 frame otherwise", () => {
		expect(surfaceFrame(["a"])).not.toHaveProperty("context");
		expect(surfaceFrame(["a"], { context: false })).not.toHaveProperty("context");
		expect(surfaceFrame(["a"], { context: true })).toEqual({ type: "surface", v: FRAME_VERSION, leaves: ["a"], context: true });
	});

	it("a call frame carries `context` only when one is given", () => {
		expect(callFrame("n#1", "a.b", [])).not.toHaveProperty("context");
		expect(callFrame("n#1", "a.b", [], null)).not.toHaveProperty("context");
		expect(callFrame("n#1", "a.b", [], { project: "A" })).toEqual({
			type: "call",
			callId: "n#1",
			path: "a.b",
			args: [],
			context: { project: "A" }
		});
	});

	it("parseFrame keeps a surface's `context` only when it is literally true", () => {
		expect(parseFrame({ type: "surface", v: 1, leaves: [], context: true }).context).toBe(true);
		expect(parseFrame({ type: "surface", v: 1, leaves: [], context: "yes" })).not.toHaveProperty("context");
		expect(parseFrame({ type: "surface", v: 1, leaves: [] })).not.toHaveProperty("context");
	});

	it("parseFrame carries a call's `context` through raw (validated by the serve); null / undefined mean none", () => {
		expect(parseFrame({ type: "call", callId: "c", path: "a.b", args: [], context: { p: 1 } }).context).toEqual({ p: 1 });
		expect(parseFrame({ type: "call", callId: "c", path: "a.b", args: [], context: "junk" }).context).toBe("junk");
		expect(parseFrame({ type: "call", callId: "c", path: "a.b", args: [], context: null })).not.toHaveProperty("context");
		expect(parseFrame({ type: "call", callId: "c", path: "a.b", args: [] })).not.toHaveProperty("context");
	});

	it("isPlainObject accepts {} and null-prototype objects only", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject(Object.create(null))).toBe(true);
		for (const value of [null, undefined, [], "s", 1, new Date(), new Map(), new (class X {})()]) expect(isPlainObject(value)).toBe(false);
	});

	it("findContextFault: plain data passes; a non-plain value, a function anywhere, or an un-cloneable value is named", () => {
		expect(findContextFault({ project: "A", when: new Date(0), tags: new Set(["x"]), nested: { list: [1, 2] } })).toBeNull();
		expect(findContextFault([1])).toBe("context");
		expect(findContextFault("A")).toBe("context");
		expect(findContextFault(null)).toBe("context");
		expect(findContextFault({ a: { b: [0, () => 1] } })).toBe("context.a.b[1]");
		expect(findContextFault({ s: Symbol("x") })).toBe("context");
		expect(findContextFault({ w: new WeakMap() })).toBe("context");
	});

	it("findContextFault never throws on a hostile value", () => {
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("boom");
				}
			}
		);
		expect(findContextFault(hostile)).toBe("context");
	});
});
