import { describe, expect, it, vi } from "vitest";

vi.mock(
	"obsidian",
	() => {
		class TFile {}
		class Modal {
			contentEl = {
				empty() {},
				createEl() {
					return {};
				},
			};

			constructor(_app?: unknown) {}
			open() {}
			close() {}
		}
		class Setting {
			constructor(_containerEl?: unknown) {}
			addButton(callback: (button: { onClick: (handler: () => void) => unknown; setButtonText: (text: string) => unknown; setCta: () => unknown }) => unknown) {
				callback({
					onClick: () => undefined,
					setButtonText: () => ({
						setCta: () => ({
							onClick: () => undefined,
						}),
						onClick: () => undefined,
					}),
					setCta: () => ({
						onClick: () => undefined,
					}),
				});
				return this;
			}
			addExtraButton(callback: (button: { onClick: (handler: () => void) => unknown; setIcon: (icon: string) => unknown; setTooltip: (text: string) => unknown }) => unknown) {
				callback({
					onClick: () => undefined,
					setIcon: () => ({
						setTooltip: () => ({
							onClick: () => undefined,
						}),
					}),
					setTooltip: () => ({
						onClick: () => undefined,
					}),
				});
				return this;
			}
		}
		return { Modal, Setting, TFile };
	},
);

import { TFile } from "obsidian";
import {
	addReferencedFileReadSeeds,
	createReferencedFileReadState,
	executeReferencedFileReadToolCall,
	executeReferencedFileSearchToolCall,
	executeReferencedFileSectionToolCall,
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

	it("reads allowed csv files in full after oversized-file approval", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const csvFile = createFile("Reports/data.csv");
		const rawContent = "col1,col2\n".repeat(2000);
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
				read: async () => rawContent,
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
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
			async () => "full",
		);

		expect(result.status).toBe("success");
		expect(result.fileType).toBe("csv");
		expect(result.path).toBe("Reports/data.csv");
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(rawContent);
		expect(result.message).toContain("after approval");
	});

	it("can send the full oversized referenced file after approval", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const csvFile = createFile("Reports/data.csv");
		const rawContent = "col1,col2\n".repeat(2000);
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
				read: async () => rawContent,
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
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
			async () => "full",
		);

		expect(result.status).toBe("success");
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(rawContent);
		expect(result.message).toContain("after approval");
	});

	it("can deny an oversized referenced file read", async () => {
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

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
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
			async () => "cancel",
		);

		expect(result.status).toBe("denied");
		expect(result.message).toContain("declined");
	});

	it("can defer an oversized referenced file read to search", async () => {
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

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
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
			async () => "search",
		);

		expect(result.status).toBe("deferred_to_search");
		expect(result.message).toContain("Call search_referenced_file");
		expect(state.oversizedReadDecisions.get("Reports/data.csv")).toBe("search");
	});

	it("reuses the search decision later in the same turn", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const csvFile = createFile("Reports/data.csv");
		const approver = vi.fn(async () => "search" as const);
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

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Analyze [data](Reports/data.csv)",
			},
		]);

		const firstResult = await executeReferencedFileReadToolCall(
			app as never,
			JSON.stringify({ reference: "Reports/data.csv" }),
			state,
			approver,
		);
		const secondResult = await executeReferencedFileReadToolCall(
			app as never,
			JSON.stringify({ reference: "Reports/data.csv" }),
			state,
			approver,
		);

		expect(firstResult.status).toBe("deferred_to_search");
		expect(secondResult.status).toBe("deferred_to_search");
		expect(approver).toHaveBeenCalledTimes(1);
	});

	it("reuses the oversized file read decision later in the same turn", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const csvFile = createFile("Reports/data.csv");
		const approver = vi.fn(async () => "full" as const);
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

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Analyze [data](Reports/data.csv)",
			},
		]);

		await executeReferencedFileReadToolCall(app as never, JSON.stringify({ reference: "Reports/data.csv" }), state, approver);
		await executeReferencedFileReadToolCall(app as never, JSON.stringify({ reference: "Reports/data.csv" }), state, approver);

		expect(approver).toHaveBeenCalledTimes(1);
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

	it("searches an allowed referenced file and returns snippets with line ranges", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md", { size: 30000 });
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Brief" && currentPath === "Notes/Chat.md") {
						return briefFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === briefFile.path ? briefFile : null),
				read: async () => ["alpha", "beta keyword", "gamma", "delta KEYWORD again", "omega"].join("\n"),
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Check [[Brief]]",
			},
		]);

		const result = await executeReferencedFileSearchToolCall(
			app as never,
			JSON.stringify({ reference: "Brief", query: "keyword" }),
			state,
		);

		expect(result).toMatchObject({
			status: "success",
			path: "Docs/Brief.md",
			query: "keyword",
			truncated: false,
		});
		expect(result.matches).toEqual([
			{
				lineStart: 1,
				lineEnd: 3,
				snippet: "alpha\nbeta keyword\ngamma",
			},
			{
				lineStart: 3,
				lineEnd: 5,
				snippet: "gamma\ndelta KEYWORD again\nomega",
			},
		]);
	});

	it("truncates search results when a referenced file has many matches", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Brief" && currentPath === "Notes/Chat.md") {
						return briefFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === briefFile.path ? briefFile : null),
				read: async () =>
					Array.from({ length: 8 }, (_, index) => `keyword line ${index + 1}`).join("\n"),
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Check [[Brief]]",
			},
		]);

		const result = await executeReferencedFileSearchToolCall(
			app as never,
			JSON.stringify({ reference: "Brief", query: "keyword" }),
			state,
		);

		expect(result.status).toBe("success");
		expect(result.matches).toHaveLength(5);
		expect(result.truncated).toBe(true);
		expect(result.message).toContain("truncated");
	});

	it("reads the enclosing markdown section for a matching body line", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Brief" && currentPath === "Notes/Chat.md") {
						return briefFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === briefFile.path ? briefFile : null),
				read: async () =>
					[
						"# Intro",
						"Top notes.",
						"",
						"## Ideal Client Profile",
						"- Clients are growth-oriented companies.",
						"- Typical buyer is a VP of Marketing or Creative Director.",
						"",
						"## Core Problems",
						"- The site is rigid.",
					].join("\n"),
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Check [[Brief]]",
			},
		]);

		const result = await executeReferencedFileSectionToolCall(
			app as never,
			JSON.stringify({ reference: "Brief", line: 5 }),
			state,
		);

		expect(result).toMatchObject({
			status: "success",
			path: "Docs/Brief.md",
			lineStart: 4,
			lineEnd: 7,
			sectionHeading: "Ideal Client Profile",
		});
		expect(result.content).toContain("## Ideal Client Profile");
		expect(result.content).toContain("Typical buyer is a VP of Marketing");
		expect(result.content).not.toContain("## Core Problems");
	});

	it("reads a preamble block when a markdown file has no preceding heading", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Brief" && currentPath === "Notes/Chat.md") {
						return briefFile;
					}
					return null;
				},
			},
			vault: {
				getAbstractFileByPath: (path: string) => (path === briefFile.path ? briefFile : null),
				read: async () =>
					[
						"Opening sentence.",
						"Second preamble line.",
						"",
						"## Heading",
						"Section body.",
					].join("\n"),
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Check [[Brief]]",
			},
		]);

		const result = await executeReferencedFileSectionToolCall(
			app as never,
			JSON.stringify({ reference: "Brief", line: 2 }),
			state,
		);

		expect(result).toMatchObject({
			status: "success",
			lineStart: 1,
			lineEnd: 2,
		});
		expect(result.sectionHeading).toBeUndefined();
		expect(result.content).toBe("Opening sentence.\nSecond preamble line.");
	});

	it("reads a bounded line window for non-markdown files", async () => {
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
				read: async () => Array.from({ length: 60 }, (_, index) => `row-${index + 1}`).join("\n"),
			},
		};

		const state = createReferencedFileReadState(["md", "txt", "csv", "json", "yaml"], 12000);
		addReferencedFileReadSeeds(app as never, state, [
			{
				currentFile: noteFile,
				content: "Analyze [data](Reports/data.csv)",
			},
		]);

		const result = await executeReferencedFileSectionToolCall(
			app as never,
			JSON.stringify({ reference: "Reports/data.csv", line: 30 }),
			state,
		);

		expect(result).toMatchObject({
			status: "success",
			lineStart: 10,
			lineEnd: 50,
			path: "Reports/data.csv",
		});
		expect(result.content).toContain("row-30");
		expect(result.sectionHeading).toBeUndefined();
	});
});

function createFile(path: string, options: { size?: number } = {}): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	Object.assign(file, {
		path,
		name: path.split("/").at(-1) ?? path,
		basename: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""),
		extension: path.split(".").at(-1) ?? "",
		stat: {
			size: options.size ?? 0,
		},
	});
	return file;
}
