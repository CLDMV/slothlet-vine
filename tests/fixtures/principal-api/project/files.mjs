/**
 *
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/principal-api/project/files.mjs
 *	@Date: 2026-09-28T12:47:12-07:00 (1790624832)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:20:18-07:00 (1790968818)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { context } from "@cldmv/slothlet/runtime";

/** How many times {@link remove} actually executed. @type {number} */
let removals = 0;

/**
 * @param {string} project - Project id; a rule condition compares it to `context.actor.project`.
 * @returns {string[]} The project's files.
 */
export function list(project) {
	return [`${project}/readme.md`];
}

/**
 * A destructive leaf a renderer principal must never reach. Counts its executions.
 * @param {string} project - Project id.
 * @returns {string} A confirmation the caller must never see when denied.
 */
export function remove(project) {
	removals++;
	return `removed:${project}`;
}

/**
 * @returns {number} How many times {@link remove} ran.
 */
export function removeCount() {
	return removals;
}

/**
 * @returns {object|null} The actor the serve bound into the call's context scope — proves the leaf runs
 *   under the principal's context.
 */
export function actor() {
	return context.actor ?? null;
}

/**
 * Tries to reassign the bound actor. Under the serve's `protect` this throws `CONTEXT_KEY_PROTECTED`;
 * the return value is what a caller would see if the guard were missing.
 * @returns {string} Only when the write went through.
 */
export function tamper() {
	context.actor = { id: "mallory", roles: ["admin"] };
	return "tampered";
}
