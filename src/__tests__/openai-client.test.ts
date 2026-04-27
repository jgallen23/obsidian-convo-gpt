import { afterEach, describe, expect, it, vi } from "vitest";
import { setConvoDebugLoggingEnabled } from "../core/debug-log";
import { getOpenAIRequestMetadata, OpenAIClient } from "../core/openai-client";
import type { ResolvedChatConfig } from "../core/types";

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
		enableMcpServers: false,
		mcpServers: [],
		...overrides,
	};
}
