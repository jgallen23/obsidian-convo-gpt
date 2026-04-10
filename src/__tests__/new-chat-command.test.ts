import { describe, expect, it, vi } from "vitest";
import { TFolder } from "obsidian";
import { buildNewChatNoteTemplate, ensureChatsFolder, getNextChatNotePath, runNewChatCommand } from "../core/new-chat-command";

describe("new chat command", () => {
	it("builds the expected starting note template", () => {
		expect(buildNewChatNoteTemplate()).toBe("---\nagent:\ndocument:\n---\n");
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
		expect(app.openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "chats/2026-04-10-1.md" }));
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
	const openFile = vi.fn().mockResolvedValue(undefined);
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
		openFile,
		vault: {
			getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
			create,
			createFolder,
		},
		workspace: {
			getLeaf: vi.fn(() => ({
				openFile,
			})),
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

function createFolderEntry(path: string): TFolder {
	const folder = Object.create(TFolder.prototype) as TFolder;
	Object.assign(folder, {
		path,
		name: path.split("/").at(-1) ?? path,
		children: [],
	});
	return folder;
}
