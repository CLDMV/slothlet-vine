/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/e2e-loopback.test.vitest.mjs
 *
 * The full e2e bar from `docs/DESIGN.md` over the loopback transport, with a REAL slothlet instance
 * on each side: value round-trips, remote-error re-throw, permission gating on a mounted stub,
 * budget expiry, far-side death, and link teardown.
 *
 * This is the reference e2e every other transport's test file mirrors against its own real boundary.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { grow, serve } from "../src/index.mjs";
import { CODES, VineError, VineRemoteError } from "../src/lib/errors.mjs";
import { createPair } from "../src/transport/loopback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(here, "fixtures", "serve-api");
const GROW_DIR = path.join(here, "fixtures", "grow-api");

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
 * Stand up a full vine over loopback: a serving instance from the serve fixtures, a growing instance
 * from the grow fixtures, and a link between them.
 * @param {object} [options]
 * @param {object} [options.permissions] - Permission config for the GROW-side instance.
 * @param {object} [options.growOptions] - Options forwarded to `grow()`.
 * @param {object} [options.serveOptions] - Options forwarded to `serve()`.
 * @returns {Promise<{serveApi: object, growApi: object, link: object, serving: object, near: object, far: object}>} The wired pair.
 */
async function wire({ permissions, growOptions, serveOptions } = {}) {
	const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
	const growApi = await slothlet({ base: GROW_DIR, silent: true, ...(permissions ? { permissions } : {}) });
	teardown.push(async () => {
		await serveApi.slothlet?.shutdown?.();
	});
	teardown.push(async () => {
		await growApi.slothlet?.shutdown?.();
	});

	const [near, far] = createPair();
	const serving = await serve(serveApi, far, serveOptions);
	const link = await grow(growApi, near, { budgetMs: 5000, ...growOptions });
	teardown.push(async () => {
		await link.close();
		serving.close();
	});
	return { serveApi, growApi, link, serving, near, far };
}

describe("e2e over loopback — the served surface", () => {
	it("publishes only CALLABLE leaves, never data leaves or the control plane", async () => {
		const { serving, link } = await wire();
		expect(serving.leaves).toEqual(["math.add", "tools.boom", "tools.echo", "tools.secret", "tools.secretCallCount", "tools.slow"]);
		expect(serving.leaves).not.toContain("math.answer");
		expect(serving.leaves.some((leaf) => leaf.startsWith("slothlet"))).toBe(false);
		expect(link.leaves).toEqual(serving.leaves);
		expect(link.skipped).toEqual([]);
		expect(link.collisions).toEqual([]);
		expect(link.id).toMatch(/^vine-/);
		expect(link.id).not.toContain(":");
	});

	it("honours a paths prefix filter", async () => {
		const { serving, link } = await wire({ serveOptions: { paths: ["tools"] } });
		expect(serving.leaves.every((leaf) => leaf.startsWith("tools."))).toBe(true);
		expect(link.leaves).not.toContain("math.add");
	});

	it("mounts the stubs at the identical dotted paths", async () => {
		const { growApi } = await wire();
		expect(typeof growApi.math.add).toBe("function");
		expect(typeof growApi.tools.echo).toBe("function");
	});
});

describe("e2e over loopback — point 1: sync + async round-trips", () => {
	it("returns the right value for a sync far leaf", async () => {
		const { growApi } = await wire();
		expect(await growApi.math.add(2, 3)).toBe(5);
	});

	it("returns the right value for an async far leaf", async () => {
		const { growApi } = await wire();
		expect(await growApi.tools.echo("hi")).toBe("echo:hi");
	});

	it("round-trips through a real MODULE caller, not just the host handle", async () => {
		const { growApi } = await wire();
		expect(await growApi.caller.echo("via-self")).toBe("echo:via-self");
	});

	it("keeps concurrent calls correlated", async () => {
		const { growApi } = await wire();
		const results = await Promise.all([growApi.math.add(1, 1), growApi.tools.echo("a"), growApi.math.add(10, 5), growApi.tools.echo("b")]);
		expect(results).toEqual([2, "echo:a", 15, "echo:b"]);
	});

	it("refuses a function argument at the edge, before anything is sent (VINE_DATA_ONLY)", async () => {
		const { growApi } = await wire();
		await expect(growApi.tools.echo({ onDone: () => {} })).rejects.toMatchObject({
			code: CODES.DATA_ONLY,
			path: "tools.echo",
			location: "arg[0].onDone"
		});
	});
});

describe("e2e over loopback — point 2: remote errors re-throw as VineRemoteError", () => {
	it("preserves the far error's name, message and code", async () => {
		const { growApi } = await wire();
		let caught;
		try {
			await growApi.tools.boom();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineRemoteError);
		expect(caught.name).toBe("BoomError");
		expect(caught.message).toBe("kaboom from the far side");
		expect(caught.code).toBe("E_BOOM");
		expect(caught.remoteStack).toContain("kaboom from the far side");
	});
});

describe("e2e over loopback — point 3: slothlet's permission gate covers mounted stubs", () => {
	it("denies a module's call to a denied stub, and the call never reaches the far side", async () => {
		const { growApi } = await wire({
			permissions: { defaultPolicy: "allow", rules: [{ caller: "caller.**", target: "tools.secret", effect: "deny" }] }
		});

		let caught;
		try {
			await growApi.caller.secret();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(caught.code).toBe("PERMISSION_DENIED");
		expect(caught).not.toBeInstanceOf(VineError);

		// The gate fires BEFORE the stub body runs, so nothing crossed the boundary: the far side's
		// own counter is the proof, read back over the same vine.
		expect(await growApi.tools.secretCallCount()).toBe(0);

		// A leaf the same caller IS permitted to reach still works — the deny is targeted, not a
		// blanket failure of the grown surface.
		expect(await growApi.caller.echo("ok")).toBe("echo:ok");
		expect(await growApi.tools.secretCallCount()).toBe(0);
	});

	it("lets the same call through when no rule denies it", async () => {
		const { growApi } = await wire({ permissions: { defaultPolicy: "allow", rules: [] } });
		expect(await growApi.caller.secret()).toBe("top-secret");
		expect(await growApi.tools.secretCallCount()).toBe(1);
	});
});

describe("e2e over loopback — point 4: VINE_BUDGET", () => {
	it("settles a slow call with VINE_BUDGET and ignores the late result", async () => {
		const { growApi, link } = await wire({ growOptions: { budgetMs: 50 } });
		let caught;
		try {
			await growApi.tools.slow(400);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VineError);
		expect(caught.code).toBe(CODES.BUDGET);
		expect(caught.path).toBe("tools.slow");
		expect(caught.budgetMs).toBe(50);

		// The far side answers later; settle-once means the frame is dropped and the link stays sane.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(await growApi.math.add(1, 1)).toBe(2);
		expect(link.leaves).toContain("tools.slow");
	});

	it("does not fire the budget for a call that answers in time", async () => {
		const { growApi } = await wire({ growOptions: { budgetMs: 2000 } });
		expect(await growApi.tools.slow(20)).toBe("slow:20");
	});
});

describe("e2e over loopback — point 5: far-side death settles in-flight calls with VINE_GONE", () => {
	it("settles pending calls and resolves link.closed", async () => {
		const { growApi, link, far } = await wire({ growOptions: { budgetMs: 10_000 } });
		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 20));

		far.close(); // the far side dies mid-call

		await expect(inFlight).rejects.toMatchObject({ code: CODES.GONE });
		await expect(link.closed).resolves.toMatchObject({ reason: "gone" });
	});

	it("fails a call made after the far side died, without waiting for a budget", async () => {
		const { growApi, far } = await wire({ growOptions: { budgetMs: 10_000 } });
		far.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const started = Date.now();
		await expect(growApi.math.add(1, 1)).rejects.toMatchObject({ code: CODES.GONE });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("e2e over loopback — point 6: link.close() unmounts and settles VINE_CLOSED", () => {
	it("removes the stubs from the api and settles in-flight calls", async () => {
		const { growApi, link } = await wire({ growOptions: { budgetMs: 10_000 } });
		expect(typeof growApi.tools.echo).toBe("function");

		const inFlight = growApi.tools.slow(2000);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await link.close();

		await expect(inFlight).rejects.toMatchObject({ code: CODES.CLOSED });
		expect(growApi.tools).toBeUndefined();
		expect(growApi.math).toBeUndefined();
		await expect(link.closed).resolves.toMatchObject({ reason: "closed" });
	});

	it("is idempotent, and the grow instance's OWN leaves survive", async () => {
		const { growApi, link } = await wire();
		await link.close();
		await link.close();
		expect(typeof growApi.caller.echo).toBe("function");
	});
});

describe("e2e over loopback — serve-side re-validation and misuse", () => {
	it("answers VINE_NO_LEAF for a path outside the served surface, however the frame was forged", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(async () => {
			await serveApi.slothlet?.shutdown?.();
		});
		const [near, far] = createPair();
		const serving = await serve(serveApi, far, { paths: ["math"] });
		teardown.push(async () => serving.close());

		const answers = [];
		near.onMessage((frame) => answers.push(frame));
		near.send({ type: "call", callId: "forged", path: "tools.secret", args: [] });
		await waitFor(() => answers.some((frame) => frame.callId === "forged"));

		const answer = answers.find((frame) => frame.callId === "forged");
		expect(answer.type).toBe("error");
		expect(answer.error.code).toBe(CODES.NO_LEAF);
	});

	it("ignores junk frames and unknown frame types entirely", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(async () => {
			await serveApi.slothlet?.shutdown?.();
		});
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		teardown.push(async () => serving.close());

		const answers = [];
		near.onMessage((frame) => answers.push(frame));
		for (const junk of [null, 7, "hello", { type: "nonsense" }, { type: "call", callId: "x", path: "__proto__.x", args: [] }]) {
			near.send(junk);
		}
		near.send({ type: "call", callId: "real", path: "math.add", args: [1, 2] });
		await waitFor(() => answers.some((frame) => frame.callId === "real"));
		expect(answers.filter((frame) => frame.type !== "surface" && frame.callId !== "real")).toEqual([]);
		expect(answers.find((frame) => frame.callId === "real").value).toBe(3);
	});

	it("stops answering after serving.close()", async () => {
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(async () => {
			await serveApi.slothlet?.shutdown?.();
		});
		const [near, far] = createPair();
		const serving = await serve(serveApi, far);
		serving.close();

		const answers = [];
		near.onMessage((frame) => answers.push(frame));
		near.send({ type: "call", callId: "after-close", path: "math.add", args: [1, 2] });
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The surface went out before close(); what must NOT arrive is an answer to the call.
		expect(answers.filter((frame) => frame.type !== "surface")).toEqual([]);
	});

	it("rejects a non-slothlet api and a non-Channel channel with a TypeError", async () => {
		const [near] = createPair();
		await expect(serve({}, near)).rejects.toBeInstanceOf(TypeError);
		await expect(grow({}, near)).rejects.toBeInstanceOf(TypeError);
		const serveApi = await slothlet({ base: SERVE_DIR, silent: true });
		teardown.push(async () => {
			await serveApi.slothlet?.shutdown?.();
		});
		await expect(serve(serveApi, {})).rejects.toBeInstanceOf(TypeError);
		await expect(grow(serveApi, { send() {} })).rejects.toBeInstanceOf(TypeError);
	});
});

describe("e2e over loopback — grow-side handshake", () => {
	it("gives up on the handshake budget when the far side never publishes a surface", async () => {
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => {
			await growApi.slothlet?.shutdown?.();
		});
		const [near] = createPair();
		await expect(grow(growApi, near, { handshakeMs: 30 })).rejects.toMatchObject({ code: CODES.BUDGET });
	});

	it("fails the handshake with VINE_GONE when the far side closes first", async () => {
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => {
			await growApi.slothlet?.shutdown?.();
		});
		const [near, far] = createPair();
		const growing = grow(growApi, near, { handshakeMs: 5000 });
		far.close();
		await expect(growing).rejects.toMatchObject({ code: CODES.GONE });
	});

	it("reports far leaves it refuses to mount on link.skipped", async () => {
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => {
			await growApi.slothlet?.shutdown?.();
		});
		const [near, far] = createPair();
		far.send({ type: "surface", v: 1, leaves: ["ok.leaf", "__proto__.pwn", "outside.leaf"] });
		const link = await grow(growApi, near, { paths: ["ok"] });
		teardown.push(async () => link.close());

		expect(link.leaves).toEqual(["ok.leaf"]);
		expect(link.skipped).toEqual(expect.arrayContaining(["__proto__.pwn", "outside.leaf"]));
		expect({}.pwn).toBeUndefined();
	});

	it("reports a path the grow instance already occupies on link.collisions, without clobbering it", async () => {
		const growApi = await slothlet({ base: GROW_DIR, silent: true });
		teardown.push(async () => {
			await growApi.slothlet?.shutdown?.();
		});
		const [near, far] = createPair();
		far.send({ type: "surface", v: 1, leaves: ["caller.echo"] });
		const link = await grow(growApi, near, { handshakeMs: 5000 });
		teardown.push(async () => link.close());
		expect(link.collisions).toEqual(["caller.echo"]);
	});
});

/**
 * Poll until a predicate holds, failing loudly rather than hanging the suite.
 * @param {() => boolean} predicate - The condition to wait for.
 * @returns {Promise<void>} Resolves once true.
 */
async function waitFor(predicate) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the far side");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
