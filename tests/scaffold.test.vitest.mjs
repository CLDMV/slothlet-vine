/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/scaffold.test.vitest.mjs
 *
 * Characterization tests for the pre-implementation scaffold: the public surface
 * exists at the documented paths, and every stub fails LOUDLY with a message that
 * names itself and says it is not implemented — never a silent no-op a consumer
 * could mistake for working forwarding. These tests are replaced/extended as the
 * real implementation lands with the browser spike.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { grow, serve } from "../src/index.mjs";

const TRANSPORTS = ["loopback", "post-message", "worker-threads", "process", "websocket"];

describe("package surface", () => {
	it("root export exposes grow + serve as functions", () => {
		expect(typeof grow).toBe("function");
		expect(typeof serve).toBe("function");
	});

	it.each(TRANSPORTS)("transport subpath '%s' resolves and exposes createChannel", async (name) => {
		const mod = await import(`../src/transport/${name}.mjs`);
		expect(typeof mod.createChannel).toBe("function");
	});

	it("package.json exports map lists every transport subpath", () => {
		const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
		for (const name of TRANSPORTS) expect(pkg.exports[`./transport/${name}`]).toBe(`./src/transport/${name}.mjs`);
		expect(pkg.exports["."]).toBe("./src/index.mjs");
		expect(pkg.peerDependencies["@cldmv/slothlet"]).toBeTruthy();
	});
});

describe("stubs fail loudly (pre-release contract)", () => {
	it("grow throws a not-implemented error naming itself", () => {
		expect(() => grow({}, { send() {}, onMessage() {} })).toThrowError(/grow/);
		expect(() => grow()).toThrowError(/not implemented/i);
	});

	it("serve throws a not-implemented error naming itself", () => {
		expect(() => serve({}, { send() {}, onMessage() {} })).toThrowError(/serve/);
		expect(() => serve()).toThrowError(/not implemented/i);
	});

	it.each(TRANSPORTS)("transport '%s' createChannel throws a not-implemented error naming its transport", async (name) => {
		const { createChannel } = await import(`../src/transport/${name}.mjs`);
		expect(() => createChannel()).toThrowError(new RegExp(`transport/${name}`));
		expect(() => createChannel()).toThrowError(/not implemented/i);
	});
});

describe("frame schema (draft)", () => {
	const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/frame.schema.json", import.meta.url)), "utf8"));

	it("is a 2020-12 JSON Schema with the two frame shapes", () => {
		expect(schema.$schema).toContain("2020-12");
		expect(Array.isArray(schema.oneOf)).toBe(true);
		expect(schema.oneOf).toHaveLength(2);
	});

	it("call frames require type/callId/path/args; result|error frames require type/callId", () => {
		const [call, settle] = schema.oneOf;
		expect(call.required).toEqual(["type", "callId", "path", "args"]);
		expect(call.properties.type.const).toBe("call");
		expect(settle.required).toEqual(["type", "callId"]);
		expect(settle.properties.type.enum).toEqual(["result", "error"]);
	});
});
