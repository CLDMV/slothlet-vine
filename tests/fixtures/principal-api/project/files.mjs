/**
 *	@Project: @cldmv/slothlet-vine
 *	@Filename: /tests/fixtures/principal-api/project/files.mjs
 *
 * Serve-side fixture for the channel-principal e2e (#33): the resource-scoped `project.**` surface a
 * remote principal reaches only through rules — one leaf a condition scopes by its argument, one that
 * counts its own executions (proves a denied call never ran), one that READS the bound context, and
 * one that tries to WRITE it (proves the serve's `protect` holds inside the leaf).
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
