import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Manifest = {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
};

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8")) as Manifest;
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version: string };
const versions = JSON.parse(readFileSync(resolve(process.cwd(), "versions.json"), "utf8")) as Record<string, string>;

describe("plugin metadata", () => {
	it("keeps manifest and package versions aligned", () => {
		expect(manifest.version).toBe(packageJson.version);
	});

	it("maps the current plugin version to the minimum supported app version", () => {
		expect(versions[manifest.version]).toBe(manifest.minAppVersion);
	});

	it("does not leave unresolved manifest placeholders", () => {
		expect(manifest.id).not.toContain("__");
		expect(manifest.name).not.toContain("__");
		expect(manifest.minAppVersion).not.toContain("__");
	});
});
