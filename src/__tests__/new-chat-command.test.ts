import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import {
	buildNewChatNoteTemplate,
	ensureChatsFolder,
	formatDeterministicDocumentReference,
	getNextChatNotePath,
	runChatWithDocumentCommand,
	runNewChatCommand,
	runNewChatRightCommand,
} from "../core/new-chat-command";

describe("new chat command", () => {
	it("builds the expected starting note template", () => {
		expect(buildNewChatNoteTemplate()).toBe("---\nagent:\ndocument:\n---\n");
	});

	it("builds a starting note template bound to a linked document", () => {
		expect(buildNewChatNoteTemplate("[[Docs/Proposal.md]]")).toContain('document: "[[Docs/Proposal.md]]"');
	});

	it("formats deterministic document references from vault-relative paths", () => {
		expect(formatDeterministicDocumentReference("Docs/Proposal.md")).toBe("[[Docs/Proposal.md]]");
		expect(formatDeterministicDocumentReference("story.md")).toBe("[[story.md]]");
	});

	it("finds the next daily sequence path", () => {
		const app = buildApp({
			"chats/2026-04-10-1.md": createFile("chats/2026-04-10-1.md"),
		});

		expect(getNextChatNotePath(app as never, "chats", "2026-04-10")).toBe("chats/2026-04-10-2.md");
	});

	it("creates missing folders, creates the note, and opens it", async () => {
		const app = buildApp();

		await runNewChatCommand(app as never, { chatsFolder: "chats/" } as never, new Date("2026-04-10T12:00:00.000Z"));

		expect(app.vault.createFolder).toHaveBeenCalledWith("chats");
		expect(app.vault.create).toHaveBeenCalledWith("chats/2026-04-10-1.md", "---\nagent:\ndocument:\n---\n");
		expect(app.workspace.getLeaf).toHaveBeenCalledWith(true);
		expect(app.openNewTabFile).toHaveBeenCalledWith(expect.objectContaining({ path: "chats/2026-04-10-1.md" }));
	});

	it("creates the note and opens it in a right split", async () => {
		const app = buildApp();

		await runNewChatRightCommand(app as never, { chatsFolder: "chats/" } as never, new Date("2026-04-10T12:00:00.000Z"));

		expect(app.vault.create).toHaveBeenCalledWith("chats/2026-04-10-1.md", "---\nagent:\ndocument:\n---\n");
		expect(app.workspace.getLeaf).toHaveBeenCalledWith("split", "vertical");
		expect(app.openRightSplitFile).toHaveBeenCalledWith(expect.objectContaining({ path: "chats/2026-04-10-1.md" }));
	});

	it("creates a right-split chat bound to the active document", async () => {
		const app = buildApp();
		const sourceFile = createMarkdownFile("Docs/Proposal.md");

		await runChatWithDocumentCommand(
			app as never,
			{ chatsFolder: "chats/" } as never,
			sourceFile,
			new Date("2026-04-10T12:00:00.000Z"),
		);

		expect(app.vault.create).toHaveBeenCalledWith(
			"chats/2026-04-10-1.md",
			expect.stringContaining('document: "[[Docs/Proposal.md]]"'),
		);
		expect(app.workspace.getLeaf).toHaveBeenCalledWith("split", "vertical");
		expect(app.openRightSplitFile).toHaveBeenCalledWith(expect.objectContaining({ path: "chats/2026-04-10-1.md" }));
	});

	it("uses an exact wiki-link path for root-level documents", async () => {
		const app = buildApp();
		const sourceFile = createMarkdownFile("story.md");

		await runChatWithDocumentCommand(
			app as never,
			{ chatsFolder: "chats/" } as never,
			sourceFile,
			new Date("2026-04-10T12:00:00.000Z"),
		);

		expect(app.vault.create).toHaveBeenCalledWith(
			"chats/2026-04-10-1.md",
			expect.stringContaining('document: "[[story.md]]"'),
		);
	});

	it("does not create a chat when no active document is available", async () => {
		const app = buildApp();

		await runChatWithDocumentCommand(app as never, { chatsFolder: "chats/" } as never, null, new Date("2026-04-10T12:00:00.000Z"));

		expect(app.vault.create).not.toHaveBeenCalled();
	});

	it("rejects folder creation when a file blocks the path", async () => {
		const app = buildApp({
			chats: createFile("chats"),
		});

		await expect(ensureChatsFolder(app as never, "chats")).rejects.toThrow(
			'Cannot create folder "chats" because a file already exists at that path.',
		);
	});
});

function buildApp(initialEntries: Record<string, unknown> = {}) {
	const entries = new Map(Object.entries(initialEntries));
	const openNewTabFile = vi.fn().mockResolvedValue(undefined);
	const openRightSplitFile = vi.fn().mockResolvedValue(undefined);
	const createFolder = vi.fn(async (path: string) => {
		const folder = createFolderEntry(path);
		entries.set(path, folder);
		return folder;
	});
	const create = vi.fn(async (path: string, data: string) => {
		const file = createFile(path);
		entries.set(path, file);
		entries.set(`${path}::content`, data);
		return file;
	});

	return {
		openNewTabFile,
		openRightSplitFile,
		vault: {
			getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
			create,
			createFolder,
		},
		workspace: {
			getLeaf: vi.fn((mode?: boolean | "split", direction?: "vertical" | "horizontal") => {
				if (mode === "split" && direction === "vertical") {
					return {
						openFile: openRightSplitFile,
					};
				}

				return {
					openFile: openNewTabFile,
				};
			}),
		},
	};
}

function createFile(path: string) {
	return {
		path,
		basename: path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
		extension: "md",
	};
}

function createMarkdownFile(path: string): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	Object.assign(file, {
		path,
		name: path.split("/").at(-1) ?? path,
		basename: path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
		extension: "md",
	});
	return file;
}

function createFolderEntry(path: string): TFolder {
	const folder = Object.create(TFolder.prototype) as TFolder;
	Object.assign(folder, {
		path,
		name: path.split("/").at(-1) ?? path,
		children: [],
	});
	return folder;
}
