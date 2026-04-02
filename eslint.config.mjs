import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"**/coverage/**",
			"**/dist/**",
			"**/main.js",
			"**/main.js.map",
			"**/node_modules/**",
		],
		languageOptions: {
			ecmaVersion: 2022,
			globals: {
				...globals.node,
			},
			sourceType: "module",
		},
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"@typescript-eslint/consistent-type-imports": "error",
		},
	},
);
