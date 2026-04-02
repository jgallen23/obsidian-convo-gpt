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
	system_commands?: string[];
	baseUrl?: string;
	openai_native_web_search?: boolean;
}

export interface PluginSettings {
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	defaultTemperature: number;
	defaultMaxTokens: number;
	stream: boolean;
	agentFolder: string;
	defaultSystemPrompt: string;
	enableOpenAINativeWebSearch: boolean;
	enableMarkdownFileTool: boolean;
}

export interface ResolvedChatConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature: number;
	max_tokens: number;
	stream: boolean;
	agent?: string;
	system_commands: string[];
	openai_native_web_search: boolean;
	defaultSystemPrompt: string;
	enableMarkdownFileTool: boolean;
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
	lastSavedMarkdownPath?: string;
}
