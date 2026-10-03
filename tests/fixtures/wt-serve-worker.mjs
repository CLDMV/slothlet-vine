/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/wt-serve-worker.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:21-07:00 (1790968821)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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
