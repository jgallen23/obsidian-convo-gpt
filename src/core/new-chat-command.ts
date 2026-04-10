import { Notice, TFolder, type App } from "obsidian";
import { buildGeneratedChatBasename, buildGeneratedChatPath, formatChatDate, normalizeChatsFolder } from "./note-title";
import type { PluginSettings } from "./types";

const NEW_CHAT_NOTE_TEMPLATE = "---\nagent:\ndocument:\n---\n";
type NewChatOpenMode = "new-tab" | "right-split";

export async function runNewChatCommand(app: App, settings: PluginSettings, now = new Date()): Promise<void> {
	return runNewChatCommandWithMode(app, settings, "new-tab", now);
}

export async function runNewChatRightCommand(app: App, settings: PluginSettings, now = new Date()): Promise<void> {
	return runNewChatCommandWithMode(app, settings, "right-split", now);
}

async function runNewChatCommandWithMode(
	app: App,
	settings: PluginSettings,
	openMode: NewChatOpenMode,
	now = new Date(),
): Promise<void> {
	try {
		const folder = normalizeChatsFolder(settings.chatsFolder);
		await ensureChatsFolder(app, folder);

		const path = getNextChatNotePath(app, folder, formatChatDate(now));
		const file = await app.vault.create(path, NEW_CHAT_NOTE_TEMPLATE);
		await openNewChatFile(app, file, openMode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`Convo GPT could not create a new chat: ${message}`);
	}
}

export function getNextChatNotePath(app: App, folder: string, dateText: string): string {
	for (let sequence = 1; sequence < Number.MAX_SAFE_INTEGER; sequence += 1) {
		const path = buildGeneratedChatPath(folder, buildGeneratedChatBasename(dateText, sequence));
		if (!app.vault.getAbstractFileByPath(path)) {
			return path;
		}
	}

	throw new Error(`Convo GPT could not find an available chat filename for ${dateText}.`);
}

export async function ensureChatsFolder(app: App, folder: string): Promise<void> {
	if (!folder) {
		return;
	}

	const segments = folder.split("/");
	let currentPath = "";

	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const existing = app.vault.getAbstractFileByPath(currentPath);
		if (!existing) {
			await app.vault.createFolder(currentPath);
			continue;
		}

		if (!(existing instanceof TFolder)) {
			throw new Error(`Cannot create folder "${currentPath}" because a file already exists at that path.`);
		}
	}
}

export function buildNewChatNoteTemplate(): string {
	return NEW_CHAT_NOTE_TEMPLATE;
}

async function openNewChatFile(app: App, file: Awaited<ReturnType<App["vault"]["create"]>>, openMode: NewChatOpenMode): Promise<void> {
	if (openMode === "right-split") {
		await app.workspace.getLeaf("split", "vertical").openFile(file);
		return;
	}

	await app.workspace.getLeaf(true).openFile(file);
}
