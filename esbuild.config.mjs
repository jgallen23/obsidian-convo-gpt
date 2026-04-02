import esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const production = process.argv.includes("production");
const shared = {
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
	],
	format: "cjs",
	logLevel: "info",
	platform: "browser",
	sourcemap: production ? false : "inline",
	target: "es2022",
};

if (production) {
	await rm("dist", { force: true, recursive: true });
	await mkdir("dist", { recursive: true });
	await esbuild.build({
		...shared,
		outfile: "dist/main.js",
	});
	await cp("manifest.json", "dist/manifest.json");
	await cp("styles.css", "dist/styles.css");
} else {
	const context = await esbuild.context({
		...shared,
		outfile: "main.js",
	});
	await context.watch();
}
