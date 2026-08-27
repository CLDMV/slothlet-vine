import js from "@eslint/js";
import globals from "globals";
import json from "@eslint/json";
import jsonvPlugin from "@cldmv/eslint-plugin-jsonv";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: [
			"tmp/**",
			"trash/**",
			"node_modules/**",
			"dist/**",
			"build/**",
			".git/**",
			".configs/**",
			".vscode/**",
			"coverage/**",
			"reference/**",
			"*.min.*",
			"**/package-lock.json",
			// Copy file patterns
			"*copy/",
			"*copy (*)/",
			"*copy */",
			"*copy.*",
			"*copy (*).*",
			"*copy *.*",
			"**/*copy/",
			"**/*copy (*)/",
			"**/*copy */",
			"**/*copy.*",
			"**/*copy (*).*",
			"**/*copy *.*"
		]
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		plugins: { js },
		extends: ["js/recommended"],
		rules: {
			"no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^(_|___.*)$",
					caughtErrorsIgnorePattern: "^(_|___.*)$",
					destructuredArrayIgnorePattern: "^(_|___.*)$",
					varsIgnorePattern: "^(_|___.*)$"
				}
			]
		}
	},
	{ files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
	{ files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
	{
		files: ["tests/**/*.test.vitest.mjs"],
		languageOptions: {
			globals: {
				beforeAll: true,
				beforeEach: true,
				afterAll: true,
				afterEach: true,
				describe: true,
				it: true,
				expect: true,
				test: true,
				vi: true
			}
		}
	},
	{ files: ["**/*.json"], plugins: { json }, language: "json/json", extends: ["json/recommended"] },
	{ files: ["**/*.jsonc"], plugins: { json }, language: "json/jsonc", extends: ["json/recommended"] },
	{ files: ["**/*.json5"], plugins: { json }, language: "json/json5", extends: ["json/recommended"] },
	{ files: ["**/*.jsonv"], plugins: { jsonv: jsonvPlugin }, language: "jsonv/jsonv", ...jsonvPlugin.configs.recommended },
	{
		files: ["**/*.md"],
		plugins: { markdown },
		language: "markdown/gfm",
		extends: ["markdown/recommended"],
		rules: {
			// GitHub alerts like [!NOTE]/[!WARNING] are valid but trip this rule.
			"markdown/no-missing-label-refs": "off"
		}
	},
	{ files: ["**/*.css"], plugins: { css }, language: "css/css", extends: ["css/recommended"] }
]);
