/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/websocket-connect-ws-import.test.vitest.mjs
 *
 * `transport/websocket`'s `connect()` is the ONE place in the package that imports the optional peer
 * dependency `ws` (see the module header) — and the one place that must degrade cleanly when it is
 * missing, or fall back correctly when the resolved module is shaped unexpectedly. Both scenarios need
 * `import("ws")` to resolve differently per test, which the file-wide, hoisted `vi.mock` used by every
 * other test file cannot do (one factory, fixed for the whole file). This file uses `vi.doMock` +
 * `vi.resetModules()` + a fresh dynamic import of the module under test per case instead.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
	vi.doUnmock("ws");
	vi.resetModules();
});

describe("websocket connect() and the optional 'ws' peer dependency", () => {
	it("throws a clear install-me error when 'ws' cannot be imported, wrapping the original failure", async () => {
		vi.doMock("ws", () => {
			throw new Error("Cannot find package 'ws'");
		});
		vi.resetModules();
		const { connect } = await import("../src/transport/websocket.mjs");

		let caught;
		try {
			await connect("ws://127.0.0.1:1");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught.message).toMatch(/requires the optional peer dependency 'ws'/);
		expect(caught.cause).toBeInstanceOf(Error);
	});

	it("falls back to ws.default when the resolved module has no named WebSocket export", async () => {
		vi.doMock("ws", () => {
			class FakeWebSocket {
				readyState = 0; // CONNECTING — matches a real client socket immediately after construction
				send() {}
				on() {}
				close() {}
			}
			// No named `WebSocket` export — `WebSocket: undefined` must be an explicit own key: vitest's
			// mocked-module guard throws on access to a key the factory didn't return at all, which would
			// mask the branch under test (`ws.WebSocket ?? ws.default`) behind an unrelated mock error.
			return { default: FakeWebSocket, WebSocket: undefined };
		});
		vi.resetModules();
		const { connect } = await import("../src/transport/websocket.mjs");

		const channel = await connect("ws://127.0.0.1:1");
		expect(typeof channel.send).toBe("function");
		expect(typeof channel.onMessage).toBe("function");
	});
});
