/**
 * The slice of a `ws` WebSocket this transport uses; a `ws` instance (client or server-accepted)
 * satisfies it.
 *
 * @typedef {{
 *   send(data: string): void,
 *   on(event: string, listener: Function): unknown,
 *   removeListener(event: string, listener: Function): unknown,
 *   close(): void,
 *   readyState: number
 * }} SocketLike
 */
/**
 * Wrap an existing `ws` WebSocket in a {@link Channel}. Accepts either a client socket
 * (`new WebSocket(url)`) or a socket handed to a `WebSocketServer` `'connection'` handler — they
 * share the same instance surface (`send`, `on`, `close`, `readyState`).
 *
 * @param {SocketLike} socket - A `ws` WebSocket instance (client or server-accepted).
 * @param {object} [options] - Reserved for forward compatibility (none in v1).
 * @returns {import("../index.mjs").Channel} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `socket` does not expose the `ws` instance surface.
 *
 * @example
 * import { WebSocketServer } from "ws";
 * import { createChannel } from "@cldmv/slothlet-vine/transport/websocket";
 * import { serve } from "@cldmv/slothlet-vine";
 *
 * const wss = new WebSocketServer({ port: 0 });
 * wss.on("connection", async (socket) => {
 *   const channel = createChannel(socket); // wrap first — before any await
 *   await serve(api, channel, { paths: ["exts"] });
 * });
 */
export function createChannel(socket: SocketLike, options?: object): import("../index.mjs").Channel;
/**
 * Construct a client channel to a `ws://` / `wss://` URL. This is the one place the transport imports
 * the optional `ws` peer dependency — and the one that throws a clear, install-me error when `ws` is
 * absent. Sends before the socket finishes connecting are buffered by the channel, so the returned
 * channel is usable immediately without awaiting `open`.
 *
 * @param {string} url - The websocket URL to connect to.
 * @param {object} [options] - Options forwarded to the `ws` WebSocket constructor.
 * @returns {Promise<import("../index.mjs").Channel>} A Channel over the freshly-created client socket.
 * @throws {Error} When the optional peer dependency `ws` is not installed.
 * @throws {Error} When the resolved `ws` module exposes neither a `WebSocket` nor a `default` export
 *   that is a constructor — an unexpected module shape, rather than a confusing native
 *   `TypeError: WebSocket is not a constructor` at the `new` site.
 *
 * @example
 * import { connect } from "@cldmv/slothlet-vine/transport/websocket";
 * import { grow } from "@cldmv/slothlet-vine";
 *
 * const channel = await connect("ws://127.0.0.1:8710");
 * const link = await grow(hostApi, channel, { budgetMs: 5000 });
 */
export function connect(url: string, options?: object): Promise<import("../index.mjs").Channel>;
/**
 * The slice of a `ws` WebSocket this transport uses; a `ws` instance (client or server-accepted)
 * satisfies it.
 */
export type SocketLike = {
    send(data: string): void;
    on(event: string, listener: Function): unknown;
    removeListener(event: string, listener: Function): unknown;
    close(): void;
    readyState: number;
};
