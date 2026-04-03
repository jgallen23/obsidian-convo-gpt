import { describe, expect, it, vi } from "vitest";

vi.mock(
	"obsidian",
	() => {
		class TFile {}
		return { TFile };
	},
);

import { TFile } from "obsidian";
import {
	addReferencedFileReadSeeds,
	createReferencedFileReadState,
	executeReferencedFileReadToolCall,
} from "../core/referenced-file-service";

describe("referenced file read service", () => {
	it("reads an allowed markdown file by link alias", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const styleGuideFile = createFile("Agents/Style Guide.md");
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Style Guide" && currentPath === "Notes/Chat.md") {
						return styleGuideFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === styleGuideFile.path ? styleGuideFile : null),
				read: async () => "Use active voice.",
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"]);
		const missing = addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Follow [[Style Guide]]",
			},
		]);
		expect(missing).toEqual([]);

		const result = await executeReferencedFileReadToolCall(
			app as never,
			JSON.stringify({ reference: "Style Guide" }),
			state,
		);

		expect(result).toMatchObject({
			status: "success",
			path: "Agents/Style Guide.md",
			fileType: "md",
			content: "Use active voice.",
			truncated: false,
		});
	});

	it("rejects reads for files that were not referenced in the turn", async () => {
		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"]);
		const app = {
			vault: {
				getAbstractFileByPath: () => null,
			},
		};

		const result = await executeReferencedFileReadToolCall(
			app as never,
			JSON.stringify({ reference: "Secrets.md" }),
			state,
		);

		expect(result).toMatchObject({
			status: "validation_error",
			reference: "Secrets.md",
		});
		expect(result.message).toContain("not available");
	});

	it("reads allowed csv files and truncates oversized content", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const csvFile = createFile("Reports/data.csv");
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Reports/data.csv" && currentPath === "Notes/Chat.md") {
						return csvFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === csvFile.path ? csvFile : null),
				read: async () => "col1,col2\n".repeat(2000),
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"]);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Analyze [data](Reports/data.csv)",
			},
		]);

		const result = await executeReferencedFileReadToolCall(
			app as never,
			JSON.stringify({ reference: "Reports/data.csv" }),
			state,
		);

		expect(result.status).toBe("success");
		expect(result.fileType).toBe("csv");
		expect(result.path).toBe("Reports/data.csv");
		expect(result.truncated).toBe(true);
		expect(result.content?.endsWith("\n…")).toBe(true);
	});

	it("reads allowed txt files when configured by default", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const textFile = createFile("Docs/Notes.txt");
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Docs/Notes.txt" && currentPath === "Notes/Chat.md") {
						return textFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === textFile.path ? textFile : null),
				read: async () => "Plain text notes.",
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"]);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Read [notes](Docs/Notes.txt)",
			},
		]);

		const result = await executeReferencedFileReadToolCall(
			app as never,
			JSON.stringify({ reference: "Docs/Notes.txt" }),
			state,
		);

		expect(result).toMatchObject({
			status: "success",
			path: "Docs/Notes.txt",
			fileType: "txt",
			content: "Plain text notes.",
			truncated: false,
		});
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
