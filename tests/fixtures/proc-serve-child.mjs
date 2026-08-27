/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/proc-serve-child.mjs
 *
 * The serve side of the process-transport e2e, running in a REAL forked child. Boots a slothlet
 * instance from the shared serve-api fixtures (sync `math.add`, async `tools.echo`/`tools.slow`,
 * throwing `tools.boom`, instrumented `tools.secret`/`tools.secretCallCount`) and serves it over the
 * child-side channel — `createParentChannel()` wrapping this process's IPC channel to its parent.
 *
 * The parent forks this file with `{ serialization: "advanced" }` and grows the far surface. After
 * `serve()` the open IPC channel keeps the child alive; it exits when the parent kills or disconnects
 * it (point 5 of the e2e bar kills it mid-call to prove real death detection).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { serve } from "../../src/index.mjs";
import { createParentChannel } from "../../src/transport/process.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(here, "serve-api");

const api = await slothlet({ base: SERVE_DIR, silent: true });
const channel = createParentChannel();

// Register a close handler so the child learns when the parent disconnects. There is nothing to do
// once the far side is gone — the process exits on its own when the IPC channel closes — but wiring it
// exercises the child endpoint's onClose registration under a real fork.
channel.onClose(() => {});

await serve(api, channel);
