import { Notice, PluginSettingTab, Setting } from "obsidian";
import type ConvoGptPlugin from "../main";
import type { McpServerConfig } from "./types";

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
			.setDesc("Used when a note or agent does not override temperature. Leave blank to omit temperature entirely.")
			.addText((text) =>
				text.setValue(this.plugin.settings.defaultTemperature === undefined ? "" : String(this.plugin.settings.defaultTemperature)).onChange(async (value) => {
					const trimmed = value.trim();
					if (!trimmed) {
						await this.plugin.updateSettings({ defaultTemperature: undefined });
						return;
					}

					const parsed = Number(trimmed);
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
			.setName("Chats folder")
			.setDesc("Folder used by the New Chat command. Leave blank to create chats in the vault root.")
			.addText((text) =>
				text.setValue(this.plugin.settings.chatsFolder).onChange(async (value) => {
					await this.plugin.updateSettings({ chatsFolder: value.trim() });
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
			.setName("Enable fetch tool")
			.setDesc("Lets the model make outbound HTTP and HTTPS requests with custom headers.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableFetchTool).onChange(async (value) => {
					await this.plugin.updateSettings({ enableFetchTool: value });
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

		new Setting(containerEl)
			.setName("Enable referenced file read tool")
			.setDesc("Lets the model read linked supported files on demand instead of preloading them into the prompt.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableReferencedFileReadTool).onChange(async (value) => {
					await this.plugin.updateSettings({ enableReferencedFileReadTool: value });
				}),
			);

		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc("Writes Convo GPT diagnostic messages to the developer console. Leave off unless you are debugging plugin behavior.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableDebugLogging).onChange(async (value) => {
					await this.plugin.updateSettings({ enableDebugLogging: value });
				}),
			);

		new Setting(containerEl)
			.setName("Referenced file extensions")
			.setDesc("Comma-separated list of file extensions the read tool may open, for example md, txt, csv, json, yaml.")
			.addText((text) =>
				text
					.setPlaceholder("md, txt, csv, json, yaml")
					.setValue(this.plugin.settings.referencedFileExtensions.join(", "))
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							referencedFileExtensions: value
								.split(",")
								.map((extension) => extension.trim())
								.filter((extension) => extension.length > 0),
						});
					}),
			);

		containerEl.createEl("h3", { text: "MCP servers" });

		new Setting(containerEl)
			.setName("Enable MCP servers")
			.setDesc("Registers enabled remote MCP servers for chat notes or agents that opt into them with mcp_servers. Headers are stored in plaintext plugin data.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableMcpServers).onChange(async (value) => {
					await this.plugin.updateSettings({ enableMcpServers: value });
				}),
			);

		const mcpServersContainer = containerEl.createDiv();
		const renderMcpServers = () => {
			mcpServersContainer.empty();

			if (this.plugin.settings.mcpServers.length === 0) {
				mcpServersContainer.createEl("p", {
					text: "No MCP servers configured. Add a server to make it available to chats or agents that opt in with mcp_servers.",
				});
				return;
			}

			this.plugin.settings.mcpServers.forEach((server) => {
				const card = mcpServersContainer.createDiv({ cls: "convo-gpt-mcp-server-card" });
				const titleEl = card.createEl("h4", { text: server.serverLabel || "New MCP server" });

				new Setting(card)
					.setName("Enabled")
					.setDesc("Only enabled servers are sent to the OpenAI Responses API.")
					.addToggle((toggle) =>
						toggle.setValue(server.enabled).onChange(async (value) => {
							await this.updateMcpServer(server.id, { enabled: value });
						}),
					)
					.addExtraButton((button) =>
						button.setIcon("trash").setTooltip("Remove MCP server").onClick(async () => {
							await this.removeMcpServer(server.id);
							renderMcpServers();
						}),
					);

				new Setting(card)
					.setName("Server label")
					.setDesc("Used by OpenAI to identify this MCP server in tool calls.")
					.addText((text) =>
						text.setPlaceholder("docs").setValue(server.serverLabel).onChange(async (value) => {
							await this.updateMcpServer(server.id, { serverLabel: value });
							titleEl.setText(value.trim() || "New MCP server");
						}),
					);

				new Setting(card)
					.setName("Server URL")
					.setDesc("Remote MCP endpoint URL.")
					.addText((text) =>
						text
							.setPlaceholder("https://example.com/mcp")
							.setValue(server.serverUrl)
							.onChange(async (value) => {
								await this.updateMcpServer(server.id, { serverUrl: value });
							}),
					);

				new Setting(card)
					.setName("Headers")
					.setDesc("Optional HTTP headers, one per line as Header-Name: value. Stored in plaintext plugin data.")
					.addTextArea((text) =>
						text
							.setPlaceholder("Authorization: Bearer ...")
							.setValue(this.formatHeaderLines(server.headers))
							.onChange(async (value) => {
								await this.updateMcpServer(server.id, {
									headers: this.parseHeaderLines(value),
								});
							}),
					);

				new Setting(card)
					.setName("Allowed tool names")
					.setDesc("Optional comma-separated allowlist. Leave blank to allow all tools exposed by the server.")
					.addText((text) =>
						text
							.setPlaceholder("search_docs, get_page")
							.setValue(server.allowedToolNames.join(", "))
							.onChange(async (value) => {
								await this.updateMcpServer(server.id, {
									allowedToolNames: value
										.split(",")
										.map((entry) => entry.trim())
										.filter((entry) => entry.length > 0),
								});
							}),
					);
			});
		};

		new Setting(containerEl)
			.setName("Add MCP server")
			.setDesc("Creates a new disabled MCP server entry.")
			.addButton((button) =>
				button.setButtonText("Add server").setCta().onClick(async () => {
					await this.plugin.updateSettings({
						mcpServers: [
							...this.plugin.settings.mcpServers,
							{
								id: this.createMcpServerId(),
								enabled: false,
								serverLabel: "",
								serverUrl: "",
								headers: {},
								allowedToolNames: [],
							},
						],
					});
					renderMcpServers();
				}),
			);

		renderMcpServers();
	}

	private async updateMcpServer(id: string, patch: Partial<McpServerConfig>): Promise<void> {
		await this.plugin.updateSettings({
			mcpServers: this.plugin.settings.mcpServers.map((server) => (server.id === id ? { ...server, ...patch } : server)),
		});
	}

	private async removeMcpServer(id: string): Promise<void> {
		await this.plugin.updateSettings({
			mcpServers: this.plugin.settings.mcpServers.filter((server) => server.id !== id),
		});
	}

	private createMcpServerId(): string {
		return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	private parseHeaderLines(text: string): Record<string, string> {
		const headers: Record<string, string> = {};
		for (const line of text.split("\n")) {
			const separatorIndex = line.indexOf(":");
			if (separatorIndex === -1) {
				continue;
			}

			const name = line.slice(0, separatorIndex).trim();
			const value = line.slice(separatorIndex + 1).trim();
			if (!name) {
				continue;
			}

			headers[name] = value;
		}

		return headers;
	}

	private formatHeaderLines(headers: Record<string, string>): string {
		return Object.entries(headers)
			.map(([name, value]) => `${name}: ${value}`)
			.join("\n");
	}
}
