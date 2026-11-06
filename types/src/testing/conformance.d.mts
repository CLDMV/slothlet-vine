/**
 * A frame as received over the channel under test: whichever shape the sender used, so the fields the
 * cases assert on are all optional.
 *
 * @typedef {import("../lib/frame.mjs").Frame & { callId?: string, path?: string, args?: unknown[], value?: unknown }} Received
 */
/**
 * Run the Channel conformance suite against a transport.
 *
 * The pair factory may be sync or async and may return either `[a, b]` or
 * `{ a, b, cleanup? }` — a transport that owns real resources (a worker, a socket, a server) returns
 * the object form so the suite can tear them down between cases.
 *
 * @param {string} name - Transport name, used in the suite title.
 * @param {() => ([import("../index.mjs").Channel, import("../index.mjs").Channel] | {a: import("../index.mjs").Channel, b: import("../index.mjs").Channel, cleanup?: () => unknown} | Promise<[import("../index.mjs").Channel, import("../index.mjs").Channel] | {a: import("../index.mjs").Channel, b: import("../index.mjs").Channel, cleanup?: () => unknown}>)} makePair
 *   Produces one connected channel pair per test.
 * @param {{ describe: Function, it: Function, expect: Function }} t - The injected test framework.
 * @returns {void}
 */
export function channelConformance(name: string, makePair: () => ([import("../index.mjs").Channel, import("../index.mjs").Channel] | {
    a: import("../index.mjs").Channel;
    b: import("../index.mjs").Channel;
    cleanup?: () => unknown;
} | Promise<[import("../index.mjs").Channel, import("../index.mjs").Channel] | {
    a: import("../index.mjs").Channel;
    b: import("../index.mjs").Channel;
    cleanup?: () => unknown;
}>), t: {
    describe: Function;
    it: Function;
    expect: Function;
}): void;
/**
 * A frame as received over the channel under test: whichever shape the sender used, so the fields the
 * cases assert on are all optional.
 */
export type Received = import("../lib/frame.mjs").Frame & {
    callId?: string;
    path?: string;
    args?: unknown[];
    value?: unknown;
};
