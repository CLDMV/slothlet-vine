/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/websocket-connect-ws-import.test.vitest.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:23-07:00 (1790968823)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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

	it("throws a clear error when the resolved module has neither a WebSocket nor a usable default export", async () => {
		vi.doMock("ws", () => ({ WebSocket: undefined, default: undefined })); // both explicit own keys — see the note above
		vi.resetModules();
		const { connect } = await import("../src/transport/websocket.mjs");

		let caught;
		try {
			await connect("ws://127.0.0.1:1");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught.message).toMatch(/could not find a WebSocket constructor/);
	});
});
