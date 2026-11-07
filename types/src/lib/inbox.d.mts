/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /src/lib/inbox.mjs
 *	@Date: 2026-09-28T03:15:48+00:00 (1790565348)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:12-07:00 (1790968812)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */
/**
 * Create a pre-handler inbox.
 * @returns {{ deliver: (frame: unknown) => void, setHandler: (fn: unknown) => void, close: () => void }}
 *   `deliver` — hand one inbound frame to the inbox; `setHandler` — register (or, with a non-function,
 *   clear) the single receive handler; `close` — discard the queue and stop delivering.
 */
export function createInbox(): {
    deliver: (frame: unknown) => void;
    setHandler: (fn: unknown) => void;
    close: () => void;
};
