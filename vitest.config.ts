import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		alias: {
			obsidian: resolve(__dirname, "src/test/obsidian-stub.ts"),
		},
	},
});
