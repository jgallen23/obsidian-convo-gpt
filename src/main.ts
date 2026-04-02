import { MarkdownView, Notice, Platform, Plugin } from "obsidian";
import { runChatCommand } from "./core/chat-command";
import { PluginRequestStatusManager } from "./core/request-status";
import { DEFAULT_SETTINGS, loadPluginSettings, savePluginSettings } from "./core/settings";
import { ConvoGptSettingTab } from "./core/settings-tab";
import type { PluginSettings } from "./core/types";

export default class ConvoGptPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private requestStatusManager!: PluginRequestStatusManager;

	override async onload(): Promise<void> {
		this.requestStatusManager = new PluginRequestStatusManager(
			this.addStatusBarItem(),
			Platform.isMobile,
			(text) => {
				new Notice(text);
			},
		);
		this.settings = await loadPluginSettings(this);
		this.requestStatusManager.clear();
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
					requestStatus: this.requestStatusManager,
				});
			},
		});
	}

	override onunload(): void {
		this.requestStatusManager.clear();
	}

	async updateSettings(nextSettings: Partial<PluginSettings>): Promise<void> {
		this.settings = {
			...this.settings,
			...nextSettings,
		};
		await savePluginSettings(this, this.settings);
	}
}
