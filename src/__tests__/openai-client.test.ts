import { describe, expect, it } from "vitest";
import { getOpenAIRequestMetadata, OpenAIClient } from "../core/openai-client";
import type { ResolvedChatConfig } from "../core/types";

describe("OpenAI client request metadata", () => {
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
});

function buildConfig(): ResolvedChatConfig {
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
	};
}
