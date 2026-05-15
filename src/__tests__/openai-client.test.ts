import { afterEach, describe, expect, it, vi } from "vitest";
import { AITraceCollector } from "../core/ai-trace";
import { setConvoDebugLoggingEnabled } from "../core/debug-log";
import { getOpenAIRequestMetadata, OpenAIClient } from "../core/openai-client";
import type { ResolvedChatConfig } from "../core/types";

vi.mock("obsidian", async () => {
	return await import("../test/obsidian-stub");
});

describe("OpenAI client request metadata", () => {
	afterEach(() => {
		setConvoDebugLoggingEnabled(false);
		vi.restoreAllMocks();
	});

	it("includes the plugin version in request metadata", () => {
		expect(getOpenAIRequestMetadata()).toEqual({
			"obsidian-convo": "0.1.0",
		});
	});

	it("applies metadata to non-streaming response requests", () => {
		const client = new OpenAIClient(buildConfig());
		const request = (client as unknown as { buildNonStreamingRequest: (messages: Array<{ role: string; content: string }>) => { metadata?: Record<string, string> } }).buildNonStreamingRequest([
			{ role: "system", content: "Be concise." },
			{ role: "user", content: "Hello" },
		]);

		expect(request.metadata).toEqual({
			"obsidian-convo": "0.1.0",
		});
	});

	it("maps max_tokens to max_output_tokens in requests", () => {
		const client = new OpenAIClient(buildConfig({ max_tokens: 10000 }));
		const request = (
			client as unknown as {
				buildNonStreamingRequest: (messages: Array<{ role: string; content: string }>) => { max_output_tokens?: number };
			}
		).buildNonStreamingRequest([
			{ role: "user", content: "Hello" },
		]);

		expect(request.max_output_tokens).toBe(10000);
	});

	it("detects when a response stops at max_output_tokens", () => {
		const client = new OpenAIClient(buildConfig());
		const completion = (
			client as unknown as {
				parseCompletion: (response: unknown, streamedText?: string, emittedMcpNoticeKeys?: Set<string>) => { hitMaxOutputTokens: boolean };
			}
		).parseCompletion({
			incomplete_details: {
				reason: "max_output_tokens",
			},
		});

		expect(completion.hitMaxOutputTokens).toBe(true);
	});

	it("omits temperature from requests when it is unset", () => {
		const client = new OpenAIClient(buildConfig({ temperature: undefined }));
		const request = (
			client as unknown as {
				buildNonStreamingRequest: (messages: Array<{ role: string; content: string }>) => Record<string, unknown>;
			}
		).buildNonStreamingRequest([
			{ role: "user", content: "Hello" },
		]);

		expect(request).not.toHaveProperty("temperature");
	});

	it("omits reasoning from requests when reasoning_effort is none", () => {
		const client = new OpenAIClient(buildConfig({ reasoning_effort: "none" }));
		const request = (
			client as unknown as {
				buildNonStreamingRequest: (messages: Array<{ role: string; content: string }>) => Record<string, unknown>;
			}
		).buildNonStreamingRequest([{ role: "user", content: "Hello" }]);

		expect(request).not.toHaveProperty("reasoning");
	});

	it("includes reasoning in requests when reasoning_effort is set", () => {
		const client = new OpenAIClient(buildConfig({ reasoning_effort: "high" }));
		const request = (
			client as unknown as {
				buildNonStreamingTurnRequest: (params: { includeFetchTool?: boolean }) => Record<string, unknown>;
			}
		).buildNonStreamingTurnRequest({});

		expect(request).toHaveProperty("reasoning");
		expect(request.reasoning).toEqual({ effort: "high" });
	});

	it("can include reasoning while omitting temperature", () => {
		const client = new OpenAIClient(buildConfig({ reasoning_effort: "high", temperature: undefined }));
		const request = (
			client as unknown as {
				buildNonStreamingRequest: (messages: Array<{ role: string; content: string }>) => Record<string, unknown>;
			}
		).buildNonStreamingRequest([{ role: "user", content: "Hello" }]);

		expect(request.reasoning).toEqual({ effort: "high" });
		expect(request).not.toHaveProperty("temperature");
	});

	it("includes explicit instructions in continuation turn requests", () => {
		const client = new OpenAIClient(buildConfig());
		const request = (
			client as unknown as {
				buildNonStreamingTurnRequest: (params: {
					inputItems: Array<{ type: string; call_id: string; output: string }>;
					instructions: string;
					previousResponseId: string;
				}) => Record<string, unknown>;
			}
		).buildNonStreamingTurnRequest({
			inputItems: [
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "{\"status\":\"success\"}",
				},
			],
			instructions: "Keep asking discovery questions before drafting a brief.",
			previousResponseId: "resp_prev",
		});

		expect(request.instructions).toBe("Keep asking discovery questions before drafting a brief.");
		expect(request.previous_response_id).toBe("resp_prev");
	});

	it("passes an abort signal to non-streaming requests", async () => {
		const client = new OpenAIClient(buildConfig());
		const signal = new AbortController().signal;
		const create = vi.fn(async () => ({
			id: "resp_1",
			output_text: "Hello",
		}));
		(client as unknown as { client: { responses: { create: typeof create } } }).client.responses.create = create;

		await client.create([{ role: "user", content: "Hello" }], { signal });

		expect(create).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal }));
	});

	it("records raw request and response payloads in the trace collector", async () => {
		const client = new OpenAIClient(buildConfig());
		const trace = new AITraceCollector({
			aiLogPath: "Logs/ai-log.md",
			maxTokens: 4096,
			model: "openai@gpt-5.4",
			notePath: "Notes/Chat.md",
			operation: "chat",
			reasoningEffort: "none",
			stream: true,
			temperature: 0.2,
		});
		(client as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }).client.responses.create = vi.fn(async () => ({
			id: "resp_1",
			output_text: "Hello",
			output: [],
		}));

		await client.create([{ role: "user", content: "Hello" }], {
			traceCollector: trace,
			traceLabel: "OpenAI test create",
		});
		trace.setOutcome("success");

		const markdown = trace.renderMarkdown();
		expect(markdown).toContain("OpenAI test create");
		expect(markdown).toContain("\"model\": \"gpt-5.4\"");
		expect(markdown).toContain("\"output_text\": \"Hello\"");
	});

	it("logs request debug details for non-streaming requests", async () => {
		const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
		setConvoDebugLoggingEnabled(true);
		const client = new OpenAIClient(buildConfig({ reasoning_effort: "high", temperature: 0.3, max_tokens: 9000 }));
		(client as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }).client.responses.create = vi.fn(async () => ({
			id: "resp_1",
			output_text: "Hello",
		}));

		await client.create([{ role: "user", content: "Hello" }]);

		expect(consoleInfo).toHaveBeenCalledWith(
			"[Convo GPT debug]",
			"openai.create.request",
			expect.objectContaining({
				requestKeys: expect.arrayContaining(["input", "max_output_tokens", "metadata", "model", "reasoning", "stream", "temperature"]),
				model: "gpt-5.4",
				baseUrl: "https://api.openai.com/v1",
				stream: false,
				temperature: 0.3,
				reasoningEffort: "high",
				maxOutputTokens: 9000,
				messageCount: 1,
				inputMode: "messages",
				metadata: {
					"obsidian-convo": "0.1.0",
				},
			}),
		);
	});

	it("includes enabled MCP servers in base requests", () => {
		const client = new OpenAIClient(
			buildConfig({
				enableMcpServers: true,
				mcpServers: [
					{
						id: "docs",
						enabled: true,
						serverLabel: "docs",
						serverUrl: "https://example.com/mcp",
						headers: { Authorization: "Bearer token" },
						allowedToolNames: ["search_docs"],
					},
					{
						id: "draft",
						enabled: true,
						serverLabel: "",
						serverUrl: "",
						headers: {},
						allowedToolNames: [],
					},
				],
			}),
		);
		const request = (
			client as unknown as {
				buildNonStreamingRequest: (messages: Array<{ role: string; content: string }>) => { tools?: Array<Record<string, unknown>> };
			}
		).buildNonStreamingRequest([
			{ role: "user", content: "Hello" },
		]);

		expect(request.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "web_search_preview",
				}),
				expect.objectContaining({
					type: "mcp",
					server_label: "docs",
					server_url: "https://example.com/mcp",
					headers: { Authorization: "Bearer token" },
					allowed_tools: ["search_docs"],
					require_approval: "never",
				}),
			]),
		);
		expect(request.tools).toHaveLength(2);
	});

	it("omits MCP tools when globally disabled", () => {
		const client = new OpenAIClient(
			buildConfig({
				enableMcpServers: false,
				mcpServers: [
					{
						id: "docs",
						enabled: true,
						serverLabel: "docs",
						serverUrl: "https://example.com/mcp",
						headers: {},
						allowedToolNames: [],
					},
				],
			}),
		);
		const request = (
			client as unknown as {
				buildNonStreamingTurnRequest: (params: { includeFetchTool?: boolean }) => { tools?: Array<Record<string, unknown>> };
			}
		).buildNonStreamingTurnRequest({});

		expect(request.tools).toEqual([
			expect.objectContaining({
				type: "web_search_preview",
			}),
		]);
	});

	it("includes referenced file read and search tools in turn requests", () => {
		const client = new OpenAIClient(buildConfig());
		const request = (
			client as unknown as {
				buildNonStreamingTurnRequest: (params: { includeReferencedFileTool?: boolean }) => { tools?: Array<Record<string, unknown>> };
			}
		).buildNonStreamingTurnRequest({
			includeReferencedFileTool: true,
		});

		expect(request.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "read_referenced_file",
					type: "function",
				}),
				expect.objectContaining({
					name: "search_referenced_file",
					type: "function",
				}),
				expect.objectContaining({
					name: "read_referenced_file_section",
					type: "function",
				}),
			]),
		);
	});

	it("extracts MCP notices from response output items", () => {
		const client = new OpenAIClient(buildConfig());
		const completion = (
			client as unknown as {
				parseCompletion: (response: unknown, streamedText?: string, emittedMcpNoticeKeys?: Set<string>) => { mcpNotices: string[] };
			}
		).parseCompletion({
			output: [
				{
					type: "mcp_list_tools",
					id: "list_1",
					server_label: "docs",
				},
				{
					type: "mcp_call",
					id: "call_1",
					server_label: "docs",
					name: "search_docs",
				},
			],
		});

		expect(completion.mcpNotices).toEqual(["Using MCP server: docs", "Using MCP tool: docs.search_docs"]);
	});

	it("extracts MCP notices when the MCP call item has no id", () => {
		const client = new OpenAIClient(buildConfig());
		const completion = (
			client as unknown as {
				parseCompletion: (response: unknown, streamedText?: string, emittedMcpNoticeKeys?: Set<string>) => { mcpNotices: string[] };
			}
		).parseCompletion({
			output: [
				{
					type: "mcp_list_tools",
					server_label: "weather",
				},
				{
					type: "mcp_call",
					server_label: "weather",
					name: "get_forecast",
				},
			],
		});

		expect(completion.mcpNotices).toEqual(["Using MCP server: weather", "Using MCP tool: weather.get_forecast"]);
	});

	it("logs MCP debug events when MCP output items are parsed", () => {
		const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
		setConvoDebugLoggingEnabled(true);
		const client = new OpenAIClient(buildConfig());

		(
			client as unknown as {
				parseCompletion: (response: unknown, streamedText?: string, emittedMcpNoticeKeys?: Set<string>) => { mcpNotices: string[] };
			}
		).parseCompletion({
			output: [
				{
					type: "mcp_list_tools",
					id: "list_1",
					server_label: "docs",
				},
				{
					type: "mcp_call",
					id: "call_1",
					server_label: "docs",
					name: "search_docs",
				},
			],
		});

		expect(consoleInfo).toHaveBeenCalledWith("[Convo GPT debug]", "openai.response.mcp", {
			activities: [
				{
					itemId: "list_1",
					serverLabel: "docs",
					error: null,
				},
				{
					itemId: "call_1",
					serverLabel: "docs",
					toolName: "search_docs",
					error: null,
				},
			],
		});
	});

	it("logs request debug details for streamed tool turns", async () => {
		const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
		setConvoDebugLoggingEnabled(true);
		const client = new OpenAIClient(
			buildConfig({
				reasoning_effort: "medium",
				temperature: undefined,
				enableMcpServers: true,
				mcpServers: [
					{
						id: "weather",
						enabled: true,
						serverLabel: "weather",
						serverUrl: "https://example.com/mcp",
						headers: { Authorization: "Bearer token" },
						allowedToolNames: ["get_forecast"],
					},
				],
			}),
		);
		const fakeStream = {
			async *[Symbol.asyncIterator]() {},
			finalResponse: async () => ({
				id: "resp_2",
				output: [],
			}),
		};
		(client as unknown as { client: { responses: { stream: ReturnType<typeof vi.fn> } } }).client.responses.stream = vi.fn(() => fakeStream);

		await client.streamTurn(
			{
				inputItems: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }] as never,
				previousResponseId: "resp_prev",
				includeReferencedFileTool: true,
			},
			{
				onText: vi.fn(),
			},
		);

		expect(consoleInfo).toHaveBeenCalledWith(
			"[Convo GPT debug]",
			"openai.streamTurn.request",
			expect.objectContaining({
				requestKeys: expect.arrayContaining([
					"input",
					"max_output_tokens",
					"metadata",
					"model",
					"parallel_tool_calls",
					"previous_response_id",
					"reasoning",
					"stream",
					"tool_choice",
					"tools",
				]),
				model: "gpt-5.4",
				baseUrl: "https://api.openai.com/v1",
				stream: true,
				temperature: null,
				reasoningEffort: "medium",
				previousResponseId: "resp_prev",
				inputMode: "input_items",
				inputItemCount: 1,
				toolTypes: expect.arrayContaining(["web_search_preview", "mcp", "function", "function", "function"]),
				toolNames: expect.arrayContaining([
					"web_search_preview",
					"mcp:weather",
					"read_referenced_file",
					"search_referenced_file",
					"read_referenced_file_section",
				]),
				mcpServerLabels: ["weather"],
			}),
		);
	});

	it("passes an abort signal to streamed turn requests", async () => {
		const client = new OpenAIClient(buildConfig());
		const signal = new AbortController().signal;
		const fakeStream = {
			async *[Symbol.asyncIterator]() {},
			finalResponse: async () => ({
				id: "resp_2",
				output: [],
			}),
		};
		const stream = vi.fn(() => fakeStream);
		(client as unknown as { client: { responses: { stream: typeof stream } } }).client.responses.stream = stream;

		await client.streamTurn(
			{
				inputItems: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }] as never,
				previousResponseId: "resp_prev",
			},
			{
				onText: vi.fn(),
			},
			{ signal },
		);

		expect(stream).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal }));
	});

	it("records streamed MCP activities in the trace collector", async () => {
		const client = new OpenAIClient(buildConfig());
		const trace = new AITraceCollector({
			aiLogPath: "Logs/ai-log.md",
			maxTokens: 4096,
			model: "openai@gpt-5.4",
			notePath: "Notes/Chat.md",
			operation: "chat",
			reasoningEffort: "none",
			stream: true,
			temperature: 0.2,
		});
		const fakeStream = {
			async *[Symbol.asyncIterator]() {
				yield {
					type: "response.output_item.added",
					item: {
						type: "mcp_list_tools",
						id: "list_1",
						server_label: "weather",
					},
				};
			},
			finalResponse: async () => ({
				id: "resp_1",
				output: [],
			}),
		};
		(client as unknown as { client: { responses: { stream: ReturnType<typeof vi.fn> } } }).client.responses.stream = vi.fn(() => fakeStream);

		await client.stream([{ role: "user", content: "Weather?" }], {
			onText: vi.fn(),
		}, {
			traceCollector: trace,
			traceLabel: "OpenAI traced stream",
		});
		trace.setOutcome("success");

		const markdown = trace.renderMarkdown();
		expect(markdown).toContain("Using MCP server: weather");
		expect(markdown).toContain("\"serverLabel\": \"weather\"");
	});

	it("captures MCP tool usage from output_item.done stream events", async () => {
		const client = new OpenAIClient(buildConfig());
		const onToolUse = vi.fn();
		const onText = vi.fn();
		const fakeStream = {
			async *[Symbol.asyncIterator]() {
				yield {
					type: "response.output_item.added",
					item: {
						type: "mcp_list_tools",
						id: "list_1",
						server_label: "weather",
					},
				};
				yield {
					type: "response.output_text.delta",
					delta: "Weekly weather answer.",
				};
				yield {
					type: "response.output_item.done",
					item: {
						type: "mcp_call",
						id: "call_1",
						server_label: "weather",
						name: "get_forecast",
					},
				};
			},
			finalResponse: async () => ({
				id: "resp_1",
				output: [],
			}),
		};
		(client as unknown as { client: { responses: { stream: ReturnType<typeof vi.fn> } } }).client.responses.stream = vi.fn(() => fakeStream);

		const completion = await client.stream([{ role: "user", content: "What is the weather?" }], {
			onToolUse,
			onText,
		});

		expect(onToolUse).toHaveBeenCalledWith("Using MCP server: weather");
		expect(onToolUse).toHaveBeenCalledWith("Using MCP tool: weather.get_forecast");
		expect(onText).toHaveBeenCalledWith("Weekly weather answer.");
		expect(completion.mcpNotices).toEqual([]);
	});
});

function buildConfig(overrides: Partial<ResolvedChatConfig> = {}): ResolvedChatConfig {
	return {
		apiKey: "test-key",
		baseUrl: "https://api.openai.com/v1",
		model: "openai@gpt-5.4",
		reasoning_effort: "none",
		temperature: 0.2,
		max_tokens: 4096,
		stream: true,
		system_commands: [],
		openai_native_web_search: true,
		defaultSystemPrompt: "Be concise.",
		enableFetchTool: true,
		enableMarkdownFileTool: true,
		enableReferencedFileReadTool: true,
		referencedFileExtensions: ["md", "txt", "csv", "json", "yaml"],
		referencedFileReadMaxChars: 12000,
		enableMcpServers: false,
		mcpServers: [],
		...overrides,
	};
}
