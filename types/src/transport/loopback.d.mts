/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/transport/loopback.mjs
 *	@Date: 2026-08-23T21:30:12-07:00 (1787545812)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:14-07:00 (1790968814)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
/**
 * Create a connected pair of loopback Channels. This is the primary surface: a loopback endpoint is
 * meaningless without its peer, so the pair — not a single channel — is the unit.
 * @returns {[Endpoint, Endpoint]} Two Channels; anything `a.send()`s arrives at `b`'s handler and vice versa.
 *
 * @example
 * const [a, b] = createPair();
 * b.onMessage((m) => console.log("b got", m));
 * a.send({ type: "ping" });
 */
export function createPair(): [Endpoint, Endpoint];
/**
 * Create ONE loopback channel, with its peer reachable as `.peer`. Provided so every built-in
 * transport module exports `createChannel(...)` as the design requires; {@link createPair} is the
 * natural surface for loopback and the one to prefer.
 * @returns {Endpoint} A Channel whose `.peer` is the other end.
 *
 * @example
 * const channel = createChannel();
 * const serving = await serve(api, channel.peer);
 * const link = await grow(otherApi, channel);
 */
export function createChannel(): Endpoint;
/**
 * One end of a loopback pair: the Channel surface plus the private state and hooks the pair needs.
 */
export type Endpoint = {
    /**
     * - The other end, filled in by {@link createPair}.
     */
    _peer: Endpoint | null;
    /**
     * - The other end, as exposed by {@link createChannel}.
     */
    peer?: Endpoint | null | undefined;
    /**
     * - Whether this end was closed locally.
     */
    closed: boolean;
    /**
     * - The single receive handler.
     */
    handler: Function | null;
    /**
     * - The single far-side-closure handler.
     */
    onCloseHandler: Function | null;
    /**
     * - Frames that arrived before a handler existed.
     */
    buffer: unknown[];
    /**
     * - The Channel capability declaration.
     */
    capabilities: object;
    /**
     * - Deliver one frame to the peer.
     */
    send: (message: object) => void;
    /**
     * - Register the receive handler.
     */
    onMessage: (handler: (message: object) => void) => void;
    /**
     * - Register the far-side-closure handler.
     */
    onClose: (handler: (info?: object) => void) => void;
    /**
     * - Tear this end down.
     */
    close: () => void;
    /**
     * - Accept an inbound frame.
     */
    _deliver: (message: unknown) => void;
    /**
     * - Run the handler insulated from throws.
     */
    _invoke: (message: unknown) => void;
};
