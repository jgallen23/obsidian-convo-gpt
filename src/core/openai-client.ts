import manifestJson from "../../manifest.json";
import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import type {
	ResponseCreateParamsNonStreaming,
	ResponseCreateParamsBase,
	ResponseFunctionToolCall,
	ResponseInputItem,
	ResponseCreateParamsStreaming,
	ToolChoiceFunction,
} from "openai/resources/responses/responses";
import {
	extractResponseSources,
	formatWebSearchSources,
	supportsOpenAINativeWebSearch,
} from "./openai-native-web-search";
import {
	getFetchToolDefinition,
} from "./fetch-tool";
import {
	getMarkdownFileToolDefinition,
} from "./markdown-file-tool";
import {
	extractFunctionToolCalls,
	getReferencedFileToolDefinition,
} from "./referenced-file-tool";
import { createOpenAIFetchAdapter } from "./openai-fetch";
import { logConvoDebug } from "./debug-log";
import type { ChatMessage, ResolvedChatConfig } from "./types";

const OPENAI_REQUEST_METADATA = {
	"obsidian-convo": manifestJson.version,
} as const;

export interface OpenAICompletion {
	text: string;
	sourcesAppendix: string;
	mcpNotices: string[];
}

export interface OpenAITurn {
	responseId: string;
	text: string;
	sourcesAppendix: string;
	toolCalls: ResponseFunctionToolCall[];
	mcpNotices: string[];
}

export interface CreateTurnParams {
	includeFetchTool?: boolean;
	includeMarkdownFileTool?: boolean;
	includeReferencedFileTool?: boolean;
	inputItems?: ResponseInputItem[];
	messages?: ChatMessage[];
	previousResponseId?: string;
	toolChoice?: ResponseCreateParamsBase["tool_choice"];
}

export interface StreamCallbacks {
	onSearchStart?: () => void;
	onToolUse?: (text: string) => void;
	onText: (delta: string) => void;
}

export class OpenAIClient {
	private readonly client: OpenAI;
	private readonly config: ResolvedChatConfig;

	constructor(config: ResolvedChatConfig) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
			fetch: createOpenAIFetchAdapter(),
			dangerouslyAllowBrowser: true,
		});
	}

	async create(messages: ChatMessage[]): Promise<OpenAICompletion> {
		const response = await this.client.responses.create(this.buildNonStreamingRequest(messages));
		return this.parseCompletion(response);
	}

	async stream(messages: ChatMessage[], callbacks: StreamCallbacks): Promise<OpenAICompletion> {
		const stream = this.client.responses.stream(this.buildStreamingRequest(messages));
		let fullText = "";
		const emittedMcpNoticeKeys = new Set<string>();

		for await (const event of stream) {
			if (event.type === "response.web_search_call.searching") {
				callbacks.onSearchStart?.();
			}

			if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
				emitMcpActivitiesFromItem(event.item, emittedMcpNoticeKeys, callbacks);
			}

			if (event.type === "response.output_text.delta") {
				fullText += event.delta;
				callbacks.onText(event.delta);
			}
		}

		const finalResponse = await stream.finalResponse();
		const parsed = this.parseCompletion(finalResponse, fullText, emittedMcpNoticeKeys);
		return parsed;
	}

	async streamTurn(params: CreateTurnParams, callbacks: StreamCallbacks): Promise<OpenAITurn> {
		const stream = this.client.responses.stream(this.buildStreamingTurnRequest(params));
		let fullText = "";
		const emittedMcpNoticeKeys = new Set<string>();

		for await (const event of stream) {
			if (event.type === "response.web_search_call.searching") {
				callbacks.onSearchStart?.();
			}

			if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
				emitMcpActivitiesFromItem(event.item, emittedMcpNoticeKeys, callbacks);
			}

			if (event.type === "response.output_text.delta") {
				fullText += event.delta;
				callbacks.onText(event.delta);
			}
		}

		const finalResponse = await stream.finalResponse();
		const toolCalls = extractFunctionToolCalls(finalResponse);
		const mcpActivities = extractMcpActivities(finalResponse).filter((activity) => !emittedMcpNoticeKeys.has(activity.key));
		if (mcpActivities.length > 0) {
			logConvoDebug("openai.streamTurn.response.mcp", {
				responseId: finalResponse.id,
				activities: mcpActivities.map((activity) => activity.details),
			});
		}
		return {
			responseId: finalResponse.id,
			text: fullText || extractText(finalResponse),
			sourcesAppendix: formatWebSearchSources(extractResponseSources(finalResponse)),
			toolCalls,
			mcpNotices: mcpActivities.map((activity) => activity.text),
		};
	}

	async createTurn(params: CreateTurnParams): Promise<OpenAITurn> {
		const request = this.buildNonStreamingTurnRequest(params);
		logConvoDebug("openai.createTurn.request", {
			model: request.model,
			toolChoice: params.toolChoice ?? null,
			toolNames: request.tools?.map((tool) => ("name" in tool ? tool.name : tool.type)) ?? [],
			messageCount: params.messages?.length ?? null,
			inputItemCount: params.inputItems?.length ?? 0,
			hasPreviousResponseId: Boolean(params.previousResponseId),
		});
		const response = await this.client.responses.create(request);
		const toolCalls = extractFunctionToolCalls(response);
		const mcpActivities = extractMcpActivities(response);
		logConvoDebug("openai.createTurn.response", {
			responseId: response.id,
			toolCallNames: toolCalls.map((toolCall) => toolCall.name),
			textLength: extractText(response).length,
			mcpActivityCount: mcpActivities.length,
		});
		if (mcpActivities.length > 0) {
			logConvoDebug("openai.createTurn.response.mcp", {
				responseId: response.id,
				activities: mcpActivities.map((activity) => activity.details),
			});
		}
		return {
			responseId: response.id,
			text: extractText(response),
			sourcesAppendix: formatWebSearchSources(extractResponseSources(response)),
			toolCalls,
			mcpNotices: mcpActivities.map((activity) => activity.text),
		};
	}

	private buildBaseRequest(messages: ChatMessage[]): ResponseCreateParamsBase {
		const normalizedModel = normalizeModelId(this.config.model);
		const systemMessages = messages.filter((message) => message.role === "system");
		const history: Responses.EasyInputMessage[] = messages
			.filter((message) => message.role !== "system")
			.map((message) => ({
				role: message.role,
				content: message.content,
			}));

		const request: ResponseCreateParamsBase = {
			model: normalizedModel,
			input: history,
			instructions: systemMessages.map((message) => message.content).join("\n\n") || undefined,
			metadata: OPENAI_REQUEST_METADATA,
			max_output_tokens: this.config.max_tokens,
			...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
		};

		const providerTools = this.buildProviderTools(normalizedModel);
		if (providerTools.length > 0) {
			request.tools = providerTools;
		}

		return request;
	}

	private buildTurnRequestBase(params: CreateTurnParams): ResponseCreateParamsBase {
		const normalizedModel = normalizeModelId(this.config.model);
		const tools: NonNullable<ResponseCreateParamsBase["tools"]> = [...this.buildProviderTools(normalizedModel)];

		if (params.includeFetchTool) {
			tools.push(getFetchToolDefinition());
		}

		if (params.includeMarkdownFileTool) {
			tools.push(getMarkdownFileToolDefinition());
		}

		if (params.includeReferencedFileTool) {
			tools.push(getReferencedFileToolDefinition());
		}

		if (params.messages) {
			const systemMessages = params.messages.filter((message) => message.role === "system");
			const history: Responses.EasyInputMessage[] = params.messages
				.filter((message) => message.role !== "system")
				.map((message) => ({
					role: message.role,
					content: message.content,
				}));

			return {
				model: normalizedModel,
				input: history,
				instructions: systemMessages.map((message) => message.content).join("\n\n") || undefined,
				metadata: OPENAI_REQUEST_METADATA,
				max_output_tokens: this.config.max_tokens,
				tools: tools.length > 0 ? tools : undefined,
				tool_choice: params.toolChoice,
				parallel_tool_calls: false,
				...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
			};
		}

		return {
			model: normalizedModel,
			input: params.inputItems ?? [],
			metadata: OPENAI_REQUEST_METADATA,
			previous_response_id: params.previousResponseId,
			max_output_tokens: this.config.max_tokens,
			tools: tools.length > 0 ? tools : undefined,
			tool_choice: params.toolChoice,
			parallel_tool_calls: false,
			...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
		};
	}

	private buildProviderTools(normalizedModel: string): NonNullable<ResponseCreateParamsBase["tools"]> {
		const tools: NonNullable<ResponseCreateParamsBase["tools"]> = [];

		if (this.config.openai_native_web_search && supportsOpenAINativeWebSearch(normalizedModel)) {
			tools.push({
				type: "web_search_preview",
				search_context_size: "medium",
			});
		}

		if (this.config.enableMcpServers) {
			for (const server of this.config.mcpServers) {
				if (!server.enabled || !server.serverLabel || !isValidUrl(server.serverUrl)) {
					continue;
				}

				tools.push({
					type: "mcp",
					server_label: server.serverLabel,
					server_url: server.serverUrl,
					headers: Object.keys(server.headers).length > 0 ? server.headers : undefined,
					allowed_tools: server.allowedToolNames.length > 0 ? server.allowedToolNames : undefined,
					require_approval: "never",
				});
			}
		}

		return tools;
	}

	private buildNonStreamingTurnRequest(params: CreateTurnParams): ResponseCreateParamsNonStreaming {
		return {
			...this.buildTurnRequestBase(params),
			stream: false,
		};
	}

	private buildStreamingTurnRequest(params: CreateTurnParams): ResponseCreateParamsStreaming {
		return {
			...this.buildTurnRequestBase(params),
			stream: true,
		};
	}

	private buildStreamingRequest(messages: ChatMessage[]): ResponseCreateParamsStreaming {
		return {
			...this.buildBaseRequest(messages),
			stream: true,
		};
	}

	private buildNonStreamingRequest(messages: ChatMessage[]): ResponseCreateParamsNonStreaming {
		return {
			...this.buildBaseRequest(messages),
			stream: false,
		};
	}

	private parseCompletion(response: unknown, streamedText = "", emittedMcpNoticeKeys?: Set<string>): OpenAICompletion {
		const text = streamedText || extractText(response);
		const sourcesAppendix = formatWebSearchSources(extractResponseSources(response));
		const mcpActivities = extractMcpActivities(response).filter((activity) => !emittedMcpNoticeKeys?.has(activity.key));
		if (mcpActivities.length > 0) {
			logConvoDebug("openai.response.mcp", {
				activities: mcpActivities.map((activity) => activity.details),
			});
		}

		return {
			text,
			sourcesAppendix,
			mcpNotices: mcpActivities.map((activity) => activity.text),
		};
	}
}

export function normalizeModelId(model: string): string {
	return model.startsWith("openai@") ? model.slice("openai@".length) : model;
}

export function getOpenAIRequestMetadata(): Record<string, string> {
	return { ...OPENAI_REQUEST_METADATA };
}

export function createForcedFunctionToolChoice(name: string): ToolChoiceFunction {
	return {
		type: "function",
		name,
	};
}

function extractText(response: unknown): string {
	const record = toRecord(response);

	if (typeof record.output_text === "string") {
		return record.output_text;
	}

	const output = Array.isArray(record.output) ? record.output : [];
	const chunks: string[] = [];

	for (const item of output) {
		const itemRecord = toRecord(item);
		const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
		for (const contentItem of content) {
			const contentRecord = toRecord(contentItem);
			if (contentRecord.type === "output_text" && typeof contentRecord.text === "string") {
				chunks.push(contentRecord.text);
			}
		}
	}

	return chunks.join("");
}

interface McpActivityEntry {
	key: string;
	text: string;
	event: string;
	details: Record<string, unknown>;
}

function emitMcpActivitiesFromItem(item: unknown, emittedKeys: Set<string>, callbacks: StreamCallbacks): void {
	for (const activity of extractMcpActivitiesFromItem(item)) {
		if (emittedKeys.has(activity.key)) {
			continue;
		}

		emittedKeys.add(activity.key);
		logConvoDebug(activity.event, activity.details);
		callbacks.onToolUse?.(activity.text);
	}
}

function extractMcpActivities(response: unknown): McpActivityEntry[] {
	const record = toRecord(response);
	const output = Array.isArray(record.output) ? record.output : [];
	return output.flatMap((item) => extractMcpActivitiesFromItem(item));
}

function extractMcpActivitiesFromItem(item: unknown): McpActivityEntry[] {
	const itemRecord = toRecord(item);
	const fallbackActivityKey = buildFallbackMcpActivityKey(itemRecord);

	if (itemRecord.type === "mcp_list_tools" && typeof itemRecord.server_label === "string") {
		return [
			{
				key: typeof itemRecord.id === "string" ? `mcp_list_tools:${itemRecord.id}` : `mcp_list_tools:${fallbackActivityKey}`,
				text: `Using MCP server: ${itemRecord.server_label}`,
				event: "openai.mcp.listTools",
				details: {
					itemId: typeof itemRecord.id === "string" ? itemRecord.id : null,
					serverLabel: itemRecord.server_label,
					error: typeof itemRecord.error === "string" ? itemRecord.error : null,
				},
			},
		];
	}

	if (itemRecord.type === "mcp_call" && typeof itemRecord.server_label === "string" && typeof itemRecord.name === "string") {
		return [
			{
				key: typeof itemRecord.id === "string" ? `mcp_call:${itemRecord.id}` : `mcp_call:${fallbackActivityKey}`,
				text: `Using MCP tool: ${itemRecord.server_label}.${itemRecord.name}`,
				event: "openai.mcp.call",
				details: {
					itemId: typeof itemRecord.id === "string" ? itemRecord.id : null,
					serverLabel: itemRecord.server_label,
					toolName: itemRecord.name,
					error: typeof itemRecord.error === "string" ? itemRecord.error : null,
				},
			},
		];
	}

	return [];
}

function buildFallbackMcpActivityKey(itemRecord: Record<string, unknown>): string {
	const type = typeof itemRecord.type === "string" ? itemRecord.type : "unknown";
	const serverLabel = typeof itemRecord.server_label === "string" ? itemRecord.server_label : "unknown-server";
	const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "unknown-tool";
	return `${type}:${serverLabel}:${toolName}`;
}

function isValidUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
