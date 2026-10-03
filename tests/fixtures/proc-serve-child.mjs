/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/proc-serve-child.mjs
 *	@Date: 2026-08-27T08:03:34-07:00 (1787843014)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:18-07:00 (1790968818)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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
