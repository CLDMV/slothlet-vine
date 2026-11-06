/**
 * Wrap a forked `ChildProcess` (parent side of the boundary). Send/receive ride the child's IPC
 * channel; `onClose` fires the first time the child dies or disconnects.
 *
 * @param {import("node:child_process").ChildProcess} child - The process returned by `fork(...)`.
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `child` is not a ChildProcess-shaped object (no `send`/`on`).
 *
 * @example
 * import { fork } from "node:child_process";
 * import { grow } from "@cldmv/slothlet-vine";
 * import { createChannel } from "@cldmv/slothlet-vine/transport/process";
 *
 * const child = fork("./serve-child.mjs", [], { serialization: "advanced" });
 * const link = await grow(hostApi, createChannel(child));
 * // …
 * await link.close();     // unmounts the stubs (does NOT close the channel)
 * child.kill();           // the parent owns the child's lifecycle
 */
export function createChannel(child: import("node:child_process").ChildProcess): object;
/**
 * Wrap the child's own `process` (child side of the boundary). Send/receive ride the process's IPC
 * channel to its parent; `onClose` fires when the parent disconnects (or the channel otherwise
 * closes). Named for what it connects TO — the parent — so a reader on the child side is not left
 * guessing which end this is.
 *
 * `proc` defaults to the live `process` and is the object a real child wraps; it is a parameter only
 * so the endpoint can be driven against a fake in tests without attaching to the real IPC channel.
 * Production code calls it with no arguments.
 *
 * @param {NodeJS.Process|object} [proc=process] - The process to wrap (defaults to the current one).
 * @returns {object} A Channel: `{ send, onMessage, close, onClose, capabilities }`.
 * @throws {TypeError} When `proc` has no `send` (not forked with an IPC channel).
 *
 * @example
 * // serve-child.mjs — the file passed to fork()
 * import slothlet from "@cldmv/slothlet";
 * import { serve } from "@cldmv/slothlet-vine";
 * import { createParentChannel } from "@cldmv/slothlet-vine/transport/process";
 *
 * const api = await slothlet({ base: "./api" });
 * await serve(api, createParentChannel());
 */
export function createParentChannel(proc?: NodeJS.Process | object): object;
