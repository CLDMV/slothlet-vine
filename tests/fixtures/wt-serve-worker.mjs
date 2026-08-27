/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/wt-serve-worker.mjs
 *
 * The SERVE side of the worker-threads e2e, running inside a real `worker_threads.Worker`. It boots a
 * genuine slothlet instance from a fixture api (sync/async/throwing/slow leaves) and serves it over
 * the child-side channel wrapping `parentPort`. The grow side lives on the main thread; together they
 * exercise the transport across a real thread boundary.
 *
 * `workerData.base` picks the served api directory (default: the shared `serve-api` fixtures);
 * `workerData.serveOptions` is forwarded to `serve()` so a test can filter the surface. `serve()`
 * publishes the surface frame immediately — the readiness signal the grow side awaits — after which
 * the worker stays alive answering calls until the parent terminates it or closes the link.
 */
import { workerData } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slothlet from "@cldmv/slothlet";

import { serve } from "../../src/index.mjs";
import { createParentChannel } from "../../src/transport/worker-threads.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = workerData?.base ? path.resolve(here, workerData.base) : path.join(here, "serve-api");

const api = await slothlet({ base, silent: true });
await serve(api, createParentChannel(), workerData?.serveOptions);
