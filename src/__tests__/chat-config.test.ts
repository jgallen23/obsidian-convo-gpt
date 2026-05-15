import { describe, expect, it } from "vitest";
import { resolveChatConfig } from "../core/chat-config";
import type { McpServerConfig, NoteOverrides, PluginSettings } from "../core/types";

describe("resolveChatConfig", () => {
	it("does not attach MCP servers when neither note nor agent opts in", () => {
		const config = resolveChatConfig(buildSettings(), undefined, {});
		expect(config.enableMcpServers).toBe(false);
		expect(config.mcpServers).toEqual([]);
	});

	it("attaches only the note-selected MCP servers", () => {
		const config = resolveChatConfig(buildSettings(), undefined, {
			mcp_servers: ["weather"],
		});
		expect(config.enableMcpServers).toBe(true);
		expect(config.mcpServers.map((server) => server.id)).toEqual(["weather"]);
	});

	it("uses the agent MCP selection when the note does not specify one", () => {
		const config = resolveChatConfig(buildSettings(), {
			mcp_servers: ["docs"],
		}, {});
		expect(config.enableMcpServers).toBe(true);
		expect(config.mcpServers.map((server) => server.id)).toEqual(["docs"]);
	});

	it("lets the note override the agent MCP selection", () => {
		const config = resolveChatConfig(buildSettings(), {
			mcp_servers: ["docs"],
		}, {
			mcp_servers: ["weather"],
		});
		expect(config.enableMcpServers).toBe(true);
		expect(config.mcpServers.map((server) => server.id)).toEqual(["weather"]);
	});

	it("treats an explicitly empty note mcp_servers list as disabling MCP", () => {
		const config = resolveChatConfig(buildSettings(), {
			mcp_servers: ["weather"],
		}, {
			mcp_servers: [],
		});
		expect(config.enableMcpServers).toBe(false);
		expect(config.mcpServers).toEqual([]);
	});

	it("matches selected MCP servers by either id or server label", () => {
		const config = resolveChatConfig(buildSettings(), undefined, {
			mcp_servers: ["Weather Server", "docs"],
		});
		expect(config.enableMcpServers).toBe(true);
		expect(config.mcpServers.map((server) => server.id)).toEqual(["weather", "docs"]);
	});

	it("uses note, then agent, then settings for reasoning_effort", () => {
		expect(resolveChatConfig(buildSettings({ defaultReasoningEffort: "low" }), undefined, {}).reasoning_effort).toBe("low");
		expect(
			resolveChatConfig(buildSettings({ defaultReasoningEffort: "low" }), { reasoning_effort: "high" }, {}).reasoning_effort,
		).toBe("high");
		expect(
			resolveChatConfig(
				buildSettings({ defaultReasoningEffort: "low" }),
				{ reasoning_effort: "high" },
				{ reasoning_effort: "none" },
			).reasoning_effort,
		).toBe("none");
	});

	it("uses note ai_log before the agent ai_log", () => {
		expect(resolveChatConfig(buildSettings(), { ai_log: "Logs/agent.md" }, {}).ai_log).toBe("Logs/agent.md");
		expect(resolveChatConfig(buildSettings(), { ai_log: "Logs/agent.md" }, { ai_log: "Logs/note.md" }).ai_log).toBe("Logs/note.md");
	});

	it("treats null temperature in note or agent overrides as explicitly omitting temperature", () => {
		expect(resolveChatConfig(buildSettings({ defaultTemperature: 0.2 }), undefined, { temperature: null }).temperature).toBeUndefined();
		expect(
			resolveChatConfig(
				buildSettings({ defaultTemperature: 0.2 }),
				{ temperature: null },
				{},
			).temperature,
		).toBeUndefined();
		expect(
			resolveChatConfig(
				buildSettings({ defaultTemperature: 0.2 }),
				{ temperature: 0.4 },
				{ temperature: null },
			).temperature,
		).toBeUndefined();
	});
});

function buildSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		apiKey: "test-key",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "openai@gpt-5.4",
		defaultReasoningEffort: "none",
		defaultTemperature: 0.2,
		defaultMaxTokens: 4096,
		stream: true,
		agentFolder: "",
		chatsFolder: "chats/",
		defaultSystemPrompt: "Be concise.",
		enableOpenAINativeWebSearch: true,
		enableFetchTool: true,
		enableMarkdownFileTool: true,
		enableReferencedFileReadTool: true,
		enableDebugLogging: false,
		referencedFileExtensions: ["md", "txt", "csv", "json", "yaml"],
		referencedFileReadMaxChars: 12000,
		enableMcpServers: true,
		mcpServers: buildMcpServers(),
		...overrides,
	};
}

function buildMcpServers(): McpServerConfig[] {
	return [
		{
			id: "weather",
			enabled: true,
			serverLabel: "Weather Server",
			serverUrl: "https://example.com/weather",
			headers: {},
			allowedToolNames: [],
		},
		{
			id: "docs",
			enabled: true,
			serverLabel: "docs",
			serverUrl: "https://example.com/docs",
			headers: {},
			allowedToolNames: [],
		},
	];
}
