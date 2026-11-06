/**
 * Build the event-forwarding half of one vine end.
 * @param {object} params
 * @param {import("../index.mjs").SlothletApi} params.api - The local slothlet instance.
 * @param {import("../index.mjs").Channel} params.channel - The transport seam (used for `send`).
 * @param {number} params.budgetMs - Per-subscribe-handshake settle budget (a `sub-ack` that never
 *   arrives settles `VINE_BUDGET`).
 * @param {() => ("gone"|"closed"|null)} params.ended - The end's terminal state, so a subscribe made
 *   after teardown fails loudly and a forward after teardown is dropped. `serve` has no `gone`.
 * @param {import("./principal.mjs").BoundPrincipal|null} [params.principal] - The channel principal this
 *   end bound (see the file header), or `null` / absent for the v1 trusted-transport behaviour.
 * @returns {{ subscribe: (eventName: string, listener: Function, once: boolean) => Promise<import("../index.mjs").Subscription>, handleFrame: (frame: import("./frame.mjs").Frame) => void, teardown: (opts: {sendUnsubs: boolean}) => void }}
 */
export function createEventForwarder({ api, channel, budgetMs, ended, principal }: {
    api: import("../index.mjs").SlothletApi;
    channel: import("../index.mjs").Channel;
    budgetMs: number;
    ended: () => ("gone" | "closed" | null);
    principal?: import("./principal.mjs").BoundPrincipal | null | undefined;
}): {
    subscribe: (eventName: string, listener: Function, once: boolean) => Promise<import("../index.mjs").Subscription>;
    handleFrame: (frame: import("./frame.mjs").Frame) => void;
    teardown: (opts: {
        sendUnsubs: boolean;
    }) => void;
};
