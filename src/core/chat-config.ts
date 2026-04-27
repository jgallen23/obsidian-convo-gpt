import type { McpServerConfig, NoteOverrides, PluginSettings, ResolvedChatConfig } from "./types";

export function resolveChatConfig(
	settings: PluginSettings,
	agentOverrides: NoteOverrides | undefined,
	noteOverrides: NoteOverrides,
): ResolvedChatConfig {
	const systemCommands = [
		...(Array.isArray(agentOverrides?.system_commands) ? agentOverrides.system_commands : []),
		...(Array.isArray(noteOverrides.system_commands) ? noteOverrides.system_commands : []),
	];
	const selectedMcpServers = resolveSelectedMcpServers(
		settings.enableMcpServers ? settings.mcpServers : [],
		noteOverrides.mcp_servers ?? agentOverrides?.mcp_servers,
	);

	return {
		apiKey: settings.apiKey,
		baseUrl: noteOverrides.baseUrl || agentOverrides?.baseUrl || settings.baseUrl,
		model: noteOverrides.model || agentOverrides?.model || settings.defaultModel,
		temperature: noteOverrides.temperature ?? agentOverrides?.temperature ?? settings.defaultTemperature,
		max_tokens: noteOverrides.max_tokens ?? agentOverrides?.max_tokens ?? settings.defaultMaxTokens,
		stream: noteOverrides.stream ?? agentOverrides?.stream ?? settings.stream,
		agent: noteOverrides.agent || agentOverrides?.agent,
		system_commands: systemCommands,
		openai_native_web_search:
			noteOverrides.openai_native_web_search ??
			agentOverrides?.openai_native_web_search ??
			settings.enableOpenAINativeWebSearch,
		defaultSystemPrompt: settings.defaultSystemPrompt,
		enableFetchTool: settings.enableFetchTool,
		enableMarkdownFileTool: settings.enableMarkdownFileTool,
		enableReferencedFileReadTool: settings.enableReferencedFileReadTool,
		referencedFileExtensions: settings.referencedFileExtensions,
		enableMcpServers: settings.enableMcpServers && selectedMcpServers.length > 0,
		mcpServers: selectedMcpServers,
	};
}

function resolveSelectedMcpServers(availableServers: McpServerConfig[], selectedNames: string[] | undefined): McpServerConfig[] {
	if (!selectedNames || selectedNames.length === 0) {
		return [];
	}

	const requested = new Set(selectedNames.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0));
	if (requested.size === 0) {
		return [];
	}

	return availableServers.filter((server) => {
		const serverId = server.id.trim().toLowerCase();
		const serverLabel = server.serverLabel.trim().toLowerCase();
		return requested.has(serverId) || requested.has(serverLabel);
	});
}
