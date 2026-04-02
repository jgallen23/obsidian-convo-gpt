import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_DIST_FILES = ["main.js", "manifest.json", "styles.css"];

async function main() {
	const vaultArg = process.argv[2];
	if (!vaultArg) {
		fail("Usage: npm run install:vault -- /path/to/your/vault");
	}

	const repoRoot = process.cwd();
	const vaultRoot = resolve(repoRoot, vaultArg);
	const obsidianDir = join(vaultRoot, ".obsidian");

	await assertDirectoryExists(obsidianDir, "Vault path must contain a .obsidian directory.");

	const manifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8"));
	const pluginId = manifest.id;
	if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
		fail("manifest.json must contain a non-empty plugin id.");
	}

	runBuild(repoRoot);

	const pluginDir = join(obsidianDir, "plugins", pluginId);
	await mkdir(pluginDir, { recursive: true });

	for (const fileName of REQUIRED_DIST_FILES) {
		const source = join(repoRoot, "dist", fileName);
		const destination = join(pluginDir, fileName);
		await assertFileExists(source, `Missing build artifact: ${source}`);
		await copyFile(source, destination);
	}

	console.log(`Installed ${pluginId} into ${pluginDir}`);
}

function runBuild(repoRoot) {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmCommand, ["run", "build"], {
		cwd: repoRoot,
		stdio: "inherit",
	});

	if (result.status !== 0) {
		fail("Build failed. Installation was aborted.");
	}
}

async function assertDirectoryExists(path, message) {
	try {
		const stats = await stat(path);
		if (!stats.isDirectory()) {
			fail(message);
		}
	} catch {
		fail(message);
	}
}

async function assertFileExists(path, message) {
	try {
		const stats = await stat(path);
		if (!stats.isFile()) {
			fail(message);
		}
	} catch {
		fail(message);
	}
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

main().catch((error) => {
	console.error("Plugin install failed.", error);
	process.exit(1);
});
