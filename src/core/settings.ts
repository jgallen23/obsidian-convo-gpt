import type { Plugin } from "obsidian";
import { DEFAULT_MODEL, DEFAULT_REFERENCED_FILE_EXTENSIONS, DEFAULT_SYSTEM_PROMPT } from "./constants";
import { sanitizeSettings } from "./frontmatter";
import type { PluginSettings } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
	apiKey: "",
	baseUrl: "https://api.openai.com/v1",
	defaultModel: DEFAULT_MODEL,
	defaultTemperature: 0.2,
	defaultMaxTokens: 4096,
	stream: true,
	agentFolder: "",
	chatsFolder: "chats/",
	defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
	enableOpenAINativeWebSearch: true,
	enableFetchTool: true,
	enableMarkdownFileTool: true,
	enableReferencedFileReadTool: true,
	enableDebugLogging: false,
	referencedFileExtensions: [...DEFAULT_REFERENCED_FILE_EXTENSIONS],
};

export async function loadPluginSettings(plugin: Plugin): Promise<PluginSettings> {
	const data = await plugin.loadData();
	return {
		...DEFAULT_SETTINGS,
		...sanitizeSettings(data),
	};
}

export async function savePluginSettings(plugin: Plugin, settings: PluginSettings): Promise<void> {
	await plugin.saveData(settings);
}
