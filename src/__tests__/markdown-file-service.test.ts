import { describe, expect, it, vi } from "vitest";

vi.mock(
	"obsidian",
	() => {
		class TFile {}
		class TFolder {}
		class Modal {}
		class Setting {}
		return { Modal, Setting, TFile, TFolder };
	},
);

import { TFile } from "obsidian";
import { executeMarkdownWriteRequest } from "../core/markdown-file-service";

describe("markdown file service", () => {
	it("resolves wiki-link write targets to existing markdown files", async () => {
		const targetFile = createFile("test/silly.md");
		const process = vi.fn(async (_file: TFile, updater: (content: string) => string) => updater("hello"));

		const result = await executeMarkdownWriteRequest(
			{
				metadataCache: {
					getFirstLinkpathDest: (path: string, currentPath: string) => {
						if (path === "silly" && currentPath === "") {
							return targetFile;
						}
						return null;
					},
				},
				vault: {
					getAbstractFileByPath: (path: string) => (path === targetFile.path ? targetFile : null),
					process,
				},
			} as never,
			{
				path: "[[silly]]",
				operation: "append",
				content: "\nworld",
			},
			async () => true,
		);

		expect(result).toMatchObject({
			status: "success",
			path: "test/silly.md",
			operation: "append",
		});
		expect(process).toHaveBeenCalledWith(targetFile, expect.any(Function));
	});

	it("skips approval for trusted markdown paths", async () => {
		const targetFile = createFile("Docs/proposal.md");
		const modify = vi.fn(async () => undefined);
		const approver = vi.fn(async () => false);

		const result = await executeMarkdownWriteRequest(
			{
				metadataCache: {
					getFirstLinkpathDest: () => null,
				},
				vault: {
					getAbstractFileByPath: (path: string) => (path === targetFile.path ? targetFile : null),
					modify,
				},
			} as never,
			{
				path: "Docs/proposal.md",
				operation: "replace",
				content: "# Updated",
			},
			approver,
			{
				trustedPaths: new Set(["Docs/proposal.md"]),
			},
		);

		expect(result).toMatchObject({
			status: "success",
			path: "Docs/proposal.md",
			operation: "replace",
		});
		expect(approver).not.toHaveBeenCalled();
		expect(modify).toHaveBeenCalledWith(targetFile, "# Updated");
	});
});

function createFile(path: string): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	Object.assign(file, {
		path,
		name: path.split("/").at(-1) ?? path,
		basename: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""),
		extension: path.split(".").at(-1) ?? "",
	});
	return file;
}
