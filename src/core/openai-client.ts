import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import type {
	ResponseCreateParamsNonStreaming,
	ResponseCreateParamsBase,
	ResponseFunctionToolCall,
	ResponseInputItem,
	ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import {
	extractResponseSources,
	formatWebSearchSources,
	supportsOpenAINativeWebSearch,
} from "./openai-native-web-search";
import {
	extractFunctionToolCalls,
	getMarkdownFileToolDefinition,
} from "./markdown-file-tool";
import { createOpenAIFetchAdapter } from "./openai-fetch";
import type { ChatMessage, ResolvedChatConfig } from "./types";

export interface OpenAICompletion {
	text: string;
	sourcesAppendix: string;
}

export interface OpenAITurn {
	responseId: string;
	text: string;
	sourcesAppendix: string;
	toolCalls: ResponseFunctionToolCall[];
}

export interface CreateTurnParams {
	includeMarkdownFileTool?: boolean;
	inputItems?: ResponseInputItem[];
	messages?: ChatMessage[];
	previousResponseId?: string;
}

export interface StreamCallbacks {
	onSearchStart?: () => void;
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

		for await (const event of stream) {
			if (event.type === "response.web_search_call.searching") {
				callbacks.onSearchStart?.();
			}

			if (event.type === "response.output_text.delta") {
				fullText += event.delta;
				callbacks.onText(event.delta);
			}
		}

		const finalResponse = await stream.finalResponse();
		const parsed = this.parseCompletion(finalResponse, fullText);
		return parsed;
	}

	async createTurn(params: CreateTurnParams): Promise<OpenAITurn> {
		const response = await this.client.responses.create(this.buildTurnRequest(params));
		return {
			responseId: response.id,
			text: extractText(response),
			sourcesAppendix: formatWebSearchSources(extractResponseSources(response)),
			toolCalls: extractFunctionToolCalls(response),
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
			temperature: this.config.temperature,
			max_output_tokens: this.config.max_tokens,
		};

		if (this.config.openai_native_web_search && supportsOpenAINativeWebSearch(normalizedModel)) {
			request.tools = [
				{
					type: "web_search_preview",
					search_context_size: "medium",
				},
			];
		}

		return request;
	}

	private buildTurnRequest(params: CreateTurnParams): ResponseCreateParamsNonStreaming {
		const normalizedModel = normalizeModelId(this.config.model);
		const tools: NonNullable<ResponseCreateParamsBase["tools"]> = [];

		if (this.config.openai_native_web_search && supportsOpenAINativeWebSearch(normalizedModel)) {
			tools.push({
				type: "web_search_preview",
				search_context_size: "medium",
			});
		}

		if (params.includeMarkdownFileTool) {
			tools.push(getMarkdownFileToolDefinition());
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
				temperature: this.config.temperature,
				max_output_tokens: this.config.max_tokens,
				tools: tools.length > 0 ? tools : undefined,
				parallel_tool_calls: false,
				stream: false,
			};
		}

		return {
			model: normalizedModel,
			input: params.inputItems ?? [],
			previous_response_id: params.previousResponseId,
			temperature: this.config.temperature,
			max_output_tokens: this.config.max_tokens,
			tools: tools.length > 0 ? tools : undefined,
			parallel_tool_calls: false,
			stream: false,
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

	private parseCompletion(response: unknown, streamedText = ""): OpenAICompletion {
		const text = streamedText || extractText(response);
		const sourcesAppendix = formatWebSearchSources(extractResponseSources(response));

		return {
			text,
			sourcesAppendix,
		};
	}
}

export function normalizeModelId(model: string): string {
	return model.startsWith("openai@") ? model.slice("openai@".length) : model;
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

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
