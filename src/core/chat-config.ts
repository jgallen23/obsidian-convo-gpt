import type { PluginSettings, ResolvedChatConfig } from "./types";

export function resolveChatConfig(
	settings: PluginSettings,
	agentOverrides: Partial<ResolvedChatConfig> | undefined,
	noteOverrides: Partial<ResolvedChatConfig>,
): ResolvedChatConfig {
	const systemCommands = [
		...(Array.isArray(agentOverrides?.system_commands) ? agentOverrides.system_commands : []),
		...(Array.isArray(noteOverrides.system_commands) ? noteOverrides.system_commands : []),
	];

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
		enableMarkdownFileTool: settings.enableMarkdownFileTool,
		enableReferencedFileReadTool: settings.enableReferencedFileReadTool,
		referencedFileExtensions: settings.referencedFileExtensions,
	};
}
