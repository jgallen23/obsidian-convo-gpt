import type { TFile } from "obsidian";

export type ChatRole = "assistant" | "system" | "user";

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface ParsedSection extends ChatMessage {
	raw: string;
	startOffset: number;
	endOffset: number;
}

export interface NoteOverrides {
	model?: string;
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	agent?: string;
	document?: string;
	system_commands?: string[];
	mcp_servers?: string[];
	baseUrl?: string;
	openai_native_web_search?: boolean;
}

export interface McpServerConfig {
	id: string;
	enabled: boolean;
	serverLabel: string;
	serverUrl: string;
	headers: Record<string, string>;
	allowedToolNames: string[];
}

export interface PluginSettings {
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	defaultTemperature?: number;
	defaultMaxTokens: number;
	stream: boolean;
	agentFolder: string;
	chatsFolder: string;
	defaultSystemPrompt: string;
	enableOpenAINativeWebSearch: boolean;
	enableFetchTool: boolean;
	enableMarkdownFileTool: boolean;
	enableReferencedFileReadTool: boolean;
	enableDebugLogging: boolean;
	referencedFileExtensions: string[];
	enableMcpServers: boolean;
	mcpServers: McpServerConfig[];
}

export interface ResolvedChatConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature?: number;
	max_tokens: number;
	stream: boolean;
	agent?: string;
	system_commands: string[];
	openai_native_web_search: boolean;
	defaultSystemPrompt: string;
	enableFetchTool: boolean;
	enableMarkdownFileTool: boolean;
	enableReferencedFileReadTool: boolean;
	referencedFileExtensions: string[];
	enableMcpServers: boolean;
	mcpServers: McpServerConfig[];
}

export interface AgentDefinition {
	frontmatter: NoteOverrides;
	body: string;
	path: string;
	file: TFile;
}

export interface ParsedNoteDocument {
	body: string;
	bodyStartOffset: number;
	overrides: NoteOverrides;
}
