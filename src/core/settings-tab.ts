import { Notice, PluginSettingTab, Setting } from "obsidian";
import type ConvoGptPlugin from "../main";

export class ConvoGptSettingTab extends PluginSettingTab {
	constructor(app: ConvoGptPlugin["app"], private readonly plugin: ConvoGptPlugin) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Convo GPT" });

		new Setting(containerEl)
			.setName("OpenAI API key")
			.setDesc("Stored in plugin settings. Obsidian does not expose a separate secure secret store for community plugins.")
			.addText((text) =>
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ apiKey: value.trim() });
					}),
			);

		const apiKeyInput = containerEl.querySelector('input[type="text"]');
		if (apiKeyInput instanceof HTMLInputElement) {
			apiKeyInput.type = "password";
			apiKeyInput.autocomplete = "off";
		}

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("Use the official OpenAI API URL unless you intentionally proxy requests.")
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						try {
							new URL(value);
							await this.plugin.updateSettings({ baseUrl: value.trim() });
						} catch {
							new Notice("Convo GPT base URL must be a valid URL.");
						}
					}),
			);

		new Setting(containerEl)
			.setName("Default model")
			.setDesc("Model ids are stored as openai@model-name.")
			.addText((text) =>
				text.setValue(this.plugin.settings.defaultModel).onChange(async (value) => {
					await this.plugin.updateSettings({ defaultModel: value.trim() || this.plugin.settings.defaultModel });
				}),
			);

		new Setting(containerEl)
			.setName("Default temperature")
			.setDesc("Used when a note or agent does not override temperature.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.defaultTemperature)).onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						await this.plugin.updateSettings({ defaultTemperature: parsed });
					}
				}),
			);

		new Setting(containerEl)
			.setName("Default max tokens")
			.setDesc("Mapped to max output tokens on the OpenAI Responses API.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.defaultMaxTokens)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isInteger(parsed) && parsed > 0) {
						await this.plugin.updateSettings({ defaultMaxTokens: parsed });
					}
				}),
			);

		new Setting(containerEl)
			.setName("Stream responses")
			.setDesc("Stream assistant output directly into the note.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stream).onChange(async (value) => {
					await this.plugin.updateSettings({ stream: value });
				}),
			);

		new Setting(containerEl)
			.setName("Agent folder")
			.setDesc("Optional folder used to resolve markdown-based agents by basename.")
			.addText((text) =>
				text.setValue(this.plugin.settings.agentFolder).onChange(async (value) => {
					await this.plugin.updateSettings({ agentFolder: value.trim() });
				}),
			);

		new Setting(containerEl)
			.setName("Default system prompt")
			.setDesc("Prepended ahead of agent prompts and note-specific system commands.")
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.defaultSystemPrompt).onChange(async (value) => {
					await this.plugin.updateSettings({ defaultSystemPrompt: value });
				}),
			);

		new Setting(containerEl)
			.setName("Enable OpenAI native web search")
			.setDesc("Used only for models that support OpenAI provider-native web search.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableOpenAINativeWebSearch).onChange(async (value) => {
					await this.plugin.updateSettings({ enableOpenAINativeWebSearch: value });
				}),
			);

		new Setting(containerEl)
			.setName("Enable markdown file save tool")
			.setDesc("Lets the model request approval to create or update other markdown files in the vault.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableMarkdownFileTool).onChange(async (value) => {
					await this.plugin.updateSettings({ enableMarkdownFileTool: value });
				}),
			);
	}
}
