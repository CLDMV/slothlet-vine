/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/serve-around-units.test.vitest.mjs
 *
 * Unit-level coverage of `serve()`'s per-call `around` wrapper (#51) with a FAKE slothlet instance and
 * hand-built frames: option validation, what `around` receives, how its return / throw becomes the
 * call's terminal frame, the data-only return check applied to it, a re-invocable `invoke()` that
 * always runs the gated call with a pristine copy of the arguments, and its place in the pipeline —
 * after `NO_LEAF`, after the principal gate (inside the principal's scope), and after the args
 * data-only check, so it never sees a frame the vine would have refused.
 *
 * The real-instance end-to-end lives in `e2e-loopback-around.test.vitest.mjs`.
 */
import { describe, it, expect } from "vitest";
import { serve } from "../src/serve.mjs";
import { CODES } from "../src/lib/errors.mjs";

/**
 * A Channel that records every outbound frame and lets a test push frames at the registered handler.
 * @returns {object} The fake channel plus test controls.
 */
function fakeChannel() {
	const sent = [];
	let handler = null;
	return {
		sent,
		send(frame) {
			sent.push(frame);
		},
		onMessage(fn) {
			handler = fn;
		},
		onClose() {},
		/**
		 * @param {unknown} frame - The frame to push at the handler.
		 * @returns {void}
		 */
		deliver(frame) {
			handler?.(frame);
		}
	};
}

/**
 * A minimal stand-in for a slothlet instance: `api.leaves`; a `math.add` leaf that records the
 * arguments it was called with; `math.mutate`, which records its argument, then mutates it and throws
 * (to prove each `invoke()` gets a fresh copy); `math.flaky`, which fails its first run only;
 * and — for the principal cases — `permissions.control.enabled`, `permissions.global.checkCall`,
 * `context.scope` / `context.run`, and `event.resolveLevel`. Every interaction is logged in order.
 * @param {object} [behaviour]
 * @param {Function} [behaviour.checkCall] - Gate answer; default allows.
 * @returns {object} The fake api.
 */
function fakeApi(behaviour = {}) {
	const log = [];
	const api = {
		log,
		calls: [],
		slothlet: {
			api: {
				async leaves() {
					return [
						{ path: "math.add", kind: "function" },
						{ path: "math.mutate", kind: "function" },
						{ path: "math.flaky", kind: "function" }
					];
				}
			},
			context: {
				async scope(options) {
					log.push("scope:enter");
					const value = await options.fn();
					log.push("scope:exit");
					return value;
				},
				async run(context, fn) {
					return fn();
				}
			},
			event: {
				resolveLevel: () => "deny",
				on: () => ({ off() {} })
			},
			permissions: {
				control: { enabled: true },
				global: {
					checkCall(caller, target) {
						log.push(`gate:${caller}->${target}`);
						return behaviour.checkCall ? behaviour.checkCall(caller, target) : true;
					}
				}
			}
		}
	};
	api.math = {
		add(a, b) {
			log.push("leaf");
			api.calls.push([a, b]);
			return a + b;
		},
		flaky() {
			log.push("leaf");
			api.flakyRuns = (api.flakyRuns ?? 0) + 1;
			if (api.flakyRuns === 1) throw new Error("conflict");
			return api.flakyRuns;
		},
		mutate(box) {
			log.push("leaf");
			api.calls.push(structuredClone(box));
			box.n += 1;
			throw new Error("conflict");
		}
	};
	return api;
}

/**
 * Serve a fake api and hand back the frame controls.
 * @param {object} options - `serve()` options.
 * @param {object} [apiBehaviour] - `fakeApi` behaviour.
 * @returns {Promise<{api: object, channel: object, serving: object}>} The serving fake.
 */
async function served(options, apiBehaviour) {
	const api = fakeApi(apiBehaviour);
	const channel = fakeChannel();
	const serving = await serve(api, channel, options);
	api.log.length = 0;
	return { api, channel, serving };
}

/**
 * Deliver one call frame and return the terminal frame it produced.
 * @param {object} channel - The fake channel.
 * @param {string} path - Leaf path.
 * @param {unknown[]} [args] - Arguments.
 * @returns {Promise<object>} The `result` / `error` frame.
 */
async function call(channel, path, args = [1, 2]) {
	const before = channel.sent.length;
	channel.deliver({ type: "call", callId: "c1", path, args });
	await tick();
	return channel.sent.slice(before).find((frame) => frame.type === "result" || frame.type === "error");
}

/**
 * Let queued microtasks and a short timer run.
 * @returns {Promise<void>} Resolves after a tick.
 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("around — option validation", () => {
	it("a non-function around is a TypeError at serve(), before anything is published", async () => {
		const channel = fakeChannel();
		await expect(serve(fakeApi(), channel, { around: "yes" })).rejects.toThrow(TypeError);
		await expect(serve(fakeApi(), channel, { around: {} })).rejects.toThrow(/around must be a function/);
		expect(channel.sent).toHaveLength(0);
	});

	it("null / undefined around is no wrapper", async () => {
		for (const around of [null, undefined]) {
			const { api, channel } = await served({ around });
			expect(await call(channel, "math.add")).toMatchObject({ type: "result", value: 3 });
			expect(api.log).toEqual(["leaf"]);
		}
	});
});

describe("around — what it receives and what is sent", () => {
	it("receives { callId, path, args, principal: null, invoke } on a serve without a principal", async () => {
		const seen = [];
		const { channel } = await served({
			around: async (call) => {
				seen.push(call);
				return call.invoke();
			}
		});
		expect(await call(channel, "math.add", [2, 5])).toMatchObject({ type: "result", callId: "c1", value: 7 });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ callId: "c1", path: "math.add", args: [2, 5], principal: null });
		expect(typeof seen[0].invoke).toBe("function");
	});

	it("the value sent is around's return value", async () => {
		const { channel } = await served({ around: async ({ invoke }) => ({ wrapped: await invoke() }) });
		expect(await call(channel, "math.add")).toMatchObject({ type: "result", value: { wrapped: 3 } });
	});

	it("around may answer without calling invoke() — the leaf never runs", async () => {
		const { api, channel } = await served({ around: async () => "cached" });
		expect(await call(channel, "math.add")).toMatchObject({ type: "result", value: "cached" });
		expect(api.log).toEqual([]);
	});

	it("a throw from around is the call's error, with its own name and message", async () => {
		const { channel } = await served({
			around: async () => {
				const err = new RangeError("deadline");
				err.code = "E_DEADLINE";
				throw err;
			}
		});
		const frame = await call(channel, "math.add");
		expect(frame.type).toBe("error");
		expect(frame.error).toMatchObject({ name: "RangeError", message: "deadline", code: "E_DEADLINE" });
	});

	it("a leaf error that around lets propagate is the call's error", async () => {
		const { channel } = await served({ around: ({ invoke }) => invoke() });
		const frame = await call(channel, "math.mutate", [{ n: 0 }]);
		expect(frame.type).toBe("error");
		expect(frame.error.message).toBe("conflict");
	});

	it("the data-only return check applies to around's return value", async () => {
		const { channel } = await served({ around: async () => ({ fn() {} }) });
		const frame = await call(channel, "math.add");
		expect(frame.type).toBe("error");
		expect(frame.error.code).toBe(CODES.DATA_ONLY);
		expect(frame.error.message).toMatch(/returned a function at value\.fn/);
	});

	it("an around that settles only after close() is not answered", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { channel, serving } = await served({
			around: async ({ invoke }) => {
				await gate;
				return invoke();
			}
		});
		const before = channel.sent.length;
		channel.deliver({ type: "call", callId: "c1", path: "math.add", args: [1, 2] });
		serving.close();
		release();
		await tick();
		expect(channel.sent.slice(before)).toHaveLength(0);
	});
});

describe("around — invoke() runs exactly the call that was accepted", () => {
	it("invoke() is re-invocable: each call runs the leaf again and the last return is sent", async () => {
		const { api, channel } = await served({
			around: async ({ invoke }) => {
				for (;;) {
					try {
						return await invoke();
					} catch (err) {
						if (err.message !== "conflict") throw err;
					}
				}
			}
		});
		const frame = await call(channel, "math.flaky", []);
		expect(frame).toMatchObject({ type: "result", value: 2 });
		expect(api.flakyRuns).toBe(2);
	});

	it("each invoke() gets a pristine copy — a leaf's mutation on one attempt does not leak into the next", async () => {
		const { api, channel } = await served({
			around: async ({ invoke }) => {
				await invoke().catch(() => {});
				return invoke().catch((err) => `second:${err.message}`);
			}
		});
		const frame = await call(channel, "math.mutate", [{ n: 0 }]);
		// Both attempts saw n = 0 (and both threw "conflict"), proving attempt two did not see attempt one's n = 1.
		expect(api.calls).toEqual([{ n: 0 }, { n: 0 }]);
		expect(frame).toMatchObject({ type: "result", value: "second:conflict" });
	});

	it("invoke() ignores any arguments passed to it", async () => {
		const { api, channel } = await served({ around: ({ invoke }) => invoke([100, 200]) });
		expect(await call(channel, "math.add", [1, 2])).toMatchObject({ type: "result", value: 3 });
		expect(api.calls).toEqual([[1, 2]]);
	});

	it("mutating around's own args view (top level or nested) changes nothing invoke() passes", async () => {
		const { api, channel } = await served({
			around: ({ args, invoke }) => {
				args[0] = 999;
				args.push("extra");
				return invoke();
			}
		});
		expect(await call(channel, "math.add", [1, 2])).toMatchObject({ type: "result", value: 3 });
		expect(api.calls).toEqual([[1, 2]]);

		const nested = await served({
			around: ({ args, invoke }) => {
				args[0].n = 41;
				return invoke();
			}
		});
		await call(nested.channel, "math.mutate", [{ n: 1 }]);
		expect(nested.api.calls).toEqual([{ n: 1 }]);
	});

	it("arguments structured clone refuses answer VINE_DATA_ONLY and around never runs", async () => {
		let ran = false;
		const { api, channel } = await served({
			around: () => {
				ran = true;
			}
		});
		const frame = await call(channel, "math.add", [Symbol("s"), 2]);
		expect(frame.type).toBe("error");
		expect(frame.error.code).toBe(CODES.DATA_ONLY);
		expect(frame.error.message).toMatch(/cannot be copied/);
		expect(ran).toBe(false);
		expect(api.log).toEqual([]);
	});
});

describe("around — its place in the pipeline", () => {
	it("a path outside the served surface answers VINE_NO_LEAF and never reaches around", async () => {
		let ran = false;
		const { channel } = await served({
			around: () => {
				ran = true;
			}
		});
		expect((await call(channel, "math.sub")).error.code).toBe(CODES.NO_LEAF);
		expect(ran).toBe(false);
	});

	it("a function in the arguments answers VINE_DATA_ONLY and never reaches around", async () => {
		let ran = false;
		const { channel } = await served({
			around: () => {
				ran = true;
			}
		});
		const frame = await call(channel, "math.add", [() => 1, 2]);
		expect(frame.error.code).toBe(CODES.DATA_ONLY);
		expect(frame.error.message).toMatch(/called with a function/);
		expect(ran).toBe(false);
	});

	it("with a principal: a denied call answers VINE_DENIED and never reaches around", async () => {
		let ran = false;
		const { api, channel } = await served(
			{
				principal: "remote.renderer",
				around: () => {
					ran = true;
				}
			},
			{ checkCall: () => false }
		);
		expect((await call(channel, "math.add")).error.code).toBe(CODES.DENIED);
		expect(ran).toBe(false);
		expect(api.log).toEqual(["scope:enter", "gate:remote.renderer->math.add", "scope:exit"]);
	});

	it("with a principal: around runs after the gate, inside the principal's scope, and receives the principal", async () => {
		const seen = [];
		const { api, channel } = await served({
			principal: { path: "remote.renderer", context: { actor: { id: "u1" } } },
			around: async (call) => {
				seen.push(call.principal);
				api.log.push("around:enter");
				const value = await call.invoke();
				api.log.push("around:exit");
				return value;
			}
		});
		expect(await call(channel, "math.add")).toMatchObject({ type: "result", value: 3 });
		expect(api.log).toEqual(["scope:enter", "gate:remote.renderer->math.add", "around:enter", "leaf", "around:exit", "scope:exit"]);
		expect(seen).toEqual([{ path: "remote.renderer", context: { actor: { id: "u1" } } }]);
		expect(Object.isFrozen(seen[0])).toBe(true);
	});

	it("with a function principal: around receives the principal resolved for THIS frame", async () => {
		const seen = [];
		let n = 0;
		const { channel } = await served({
			principal: () => `remote.r${++n}`,
			around: (call) => {
				seen.push(call.principal.path);
				return call.invoke();
			}
		});
		await call(channel, "math.add");
		await call(channel, "math.add");
		expect(seen).toEqual(["remote.r1", "remote.r2"]);
	});
});
