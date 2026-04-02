import { MarkdownView, Notice, Plugin } from "obsidian";
import { runChatCommand } from "./core/chat-command";
import { DEFAULT_SETTINGS, loadPluginSettings, savePluginSettings } from "./core/settings";
import { ConvoGptSettingTab } from "./core/settings-tab";
import type { PluginSettings } from "./core/types";

export default class ConvoGptPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

	override async onload(): Promise<void> {
		this.settings = await loadPluginSettings(this);
		this.addSettingTab(new ConvoGptSettingTab(this.app, this));

		this.addCommand({
			id: "chat",
			name: "Chat",
			icon: "message-circle",
			editorCallback: (editor, view) => {
				if (!(view instanceof MarkdownView)) {
					new Notice("Convo GPT can only run in markdown views.");
					return;
				}

				void runChatCommand({
					app: this.app,
					editor,
					view,
					settings: this.settings,
				});
			},
		});
	}

	override onunload(): void {
		// Registered resources are released by Obsidian.
	}

	async updateSettings(nextSettings: Partial<PluginSettings>): Promise<void> {
		this.settings = {
			...this.settings,
			...nextSettings,
		};
		await savePluginSettings(this, this.settings);
	}
}
