/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/context-api/work.mjs
 *	@Date: 2026-10-06T12:00:00-07:00 (1791313200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-06T12:00:00-07:00 (1791313200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { context } from "@cldmv/slothlet/runtime";

let runs = 0;

/**
 * What the per-call context scope holds for the keys the requested-context tests use (#79).
 * @returns {{ project: unknown, actor: unknown, extra: unknown }} The scope's view.
 */
export function read() {
	runs++;
	return { project: context.project ?? null, actor: context.actor ?? null, extra: context.extra ?? null };
}

/**
 * Wait, then read — so two concurrent calls overlap on the serving side.
 * @param {number} ms - Delay.
 * @returns {Promise<unknown>} The scope's `project` after the delay.
 */
export async function slow(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return context.project ?? null;
}

/**
 * Try to rewrite an accepted requested-context key, then a nested field of it.
 * @returns {string} Never returns normally when the key is protected.
 */
export function tamper() {
	context.project = "hijacked";
	return "tampered";
}

/**
 * Try to rewrite a NESTED field of an accepted requested-context key.
 * @returns {string} Never returns normally when the key is protected.
 */
export function deep() {
	context.extra.depth = "hijacked";
	return "tampered";
}

/**
 * How many times `read` ran — a refused call must never reach it.
 * @returns {number} The count.
 */
export function count() {
	return runs;
}
