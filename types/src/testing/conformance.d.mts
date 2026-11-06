/**
 * Run the Channel conformance suite against a transport.
 *
 * The pair factory may be sync or async and may return either `[a, b]` or
 * `{ a, b, cleanup? }` — a transport that owns real resources (a worker, a socket, a server) returns
 * the object form so the suite can tear them down between cases.
 *
 * @param {string} name - Transport name, used in the suite title.
 * @param {() => ([object, object] | {a: object, b: object, cleanup?: () => unknown} | Promise<[object, object] | {a: object, b: object, cleanup?: () => unknown}>)} makePair
 *   Produces one connected channel pair per test.
 * @param {{ describe: Function, it: Function, expect: Function }} t - The injected test framework.
 * @returns {void}
 */
export function channelConformance(name: string, makePair: () => ([object, object] | {
    a: object;
    b: object;
    cleanup?: () => unknown;
} | Promise<[object, object] | {
    a: object;
    b: object;
    cleanup?: () => unknown;
}>), t: {
    describe: Function;
    it: Function;
    expect: Function;
}): void;
