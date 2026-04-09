import { Buffer } from "buffer";
import { MarkdownView, Notice, Platform, Plugin } from "obsidian";
import { runChatCommand } from "./core/chat-command";
import { runRetitleNoteCommand } from "./core/retitle-note-command";
import { sanitizeSettings } from "./core/frontmatter";
import { requestRetitleApproval } from "./core/retitle-note-approval";
import { PluginRequestStatusManager } from "./core/request-status";
import { DEFAULT_SETTINGS, loadPluginSettings, savePluginSettings } from "./core/settings";
import { ConvoGptSettingTab } from "./core/settings-tab";
import type { PluginSettings } from "./core/types";

if (typeof globalThis.Buffer === "undefined") {
	globalThis.Buffer = Buffer;
}

export default class ConvoGptPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private requestStatusManager!: PluginRequestStatusManager;

	override async onload(): Promise<void> {
		this.requestStatusManager = new PluginRequestStatusManager(
			this.addStatusBarItem(),
			Platform.isMobile,
			(text, duration) => {
				return new Notice(text, duration);
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

		this.addCommand({
			id: "summarize-and-retitle-note",
			name: "Summarize And Retitle Note",
			icon: "whole-word",
			editorCallback: (editor, view) => {
				if (!(view instanceof MarkdownView)) {
					new Notice("Convo GPT can only run in markdown views.");
					return;
				}

				void runRetitleNoteCommand({
					app: this.app,
					approver: (request) => requestRetitleApproval(this.app, request),
					editor,
					notify: (message) => {
						new Notice(message);
					},
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
		this.settings = sanitizeSettings({
			...this.settings,
			...nextSettings,
		});
		await savePluginSettings(this, this.settings);
	}
}
