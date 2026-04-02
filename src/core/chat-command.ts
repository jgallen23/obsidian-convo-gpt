import { Notice, type App, type Editor, type MarkdownView } from "obsidian";
import { resolveAgent } from "./agent-resolver";
import { injectReferencedNoteContext } from "./context-resolver";
import { parseNoteDocument, persistLastSavedMarkdownPath } from "./frontmatter";
import { executeMarkdownWriteToolCall } from "./markdown-file-service";
import {
	buildMarkdownFileToolPolicy,
	buildFunctionCallOutput,
	MAX_MARKDOWN_TOOL_ROUNDS,
	MARKDOWN_FILE_TOOL_NAME,
	shouldOfferMarkdownFileTool,
} from "./markdown-file-tool";
import { shouldShowTopOfAnswerLink } from "./response-length";
import { parseSections } from "./message-parser";
import { OpenAIClient, type OpenAICompletion } from "./openai-client";
import { buildAssistantPrefix, buildAssistantSuffix, getNextExchangeId } from "./response-anchors";
import type { ChatMessage, PluginSettings, ResolvedChatConfig } from "./types";

interface ChatCommandContext {
	app: App;
	editor: Editor;
	view: MarkdownView;
	settings: PluginSettings;
}

interface OffsetRange {
	start: number;
	end: number;
}

export async function runChatCommand(context: ChatCommandContext): Promise<void> {
	const { app, editor, settings, view } = context;
	const file = view.file;

	if (!file) {
		new Notice("Convo GPT requires an open note.");
		return;
	}

	const exchangeId = getNextExchangeId(editor.getValue());
	const document = parseNoteDocument(editor.getValue());
	const sections = parseSections(document.body);
	if (sections.length === 0) {
		new Notice("Convo GPT needs note content to send.");
		return;
	}

	const agent = await resolveAgent(app, settings, document.overrides.agent);
	const config = resolveChatConfig(settings, agent?.frontmatter, document.overrides);
	if (!config.apiKey) {
		new Notice("Convo GPT is missing an OpenAI API key.");
		return;
	}

	const messages = await buildMessages(
		app,
		file,
		sections.map((section) => ({
			role: section.role,
			content: section.content,
		})),
		config,
		agent?.body ?? "",
	);

	const lastMessage = messages[messages.length - 1];
	if (!lastMessage || lastMessage.role !== "user" || !lastMessage.content.trim()) {
		new Notice("Convo GPT expects the last message in the note to be a non-empty user message.");
		return;
	}

	const assistantPrefix = buildAssistantPrefix(config.model, exchangeId);
	let writeOffset = editor.getValue().length;
	editor.replaceRange(assistantPrefix, editor.offsetToPos(writeOffset));
	writeOffset += assistantPrefix.length;

	const client = new OpenAIClient(config);
	let noticeRange: OffsetRange | null = null;
	let completionText = "";
	let sourcesAppendix = "";
	const shouldUseMarkdownFileTool = shouldOfferMarkdownFileTool(
		lastMessage.content,
		config.enableMarkdownFileTool,
		document.lastSavedMarkdownPath,
	);

	try {
		if (shouldUseMarkdownFileTool) {
			const completion = await runMarkdownFileToolConversation(
				app,
				client,
				withMarkdownFileToolPolicy(messages, document.lastSavedMarkdownPath),
			);
			completionText = completion.text;
			sourcesAppendix = completion.sourcesAppendix;
			editor.replaceRange(completionText, editor.offsetToPos(writeOffset));
			writeOffset += completionText.length;
			if (completion.lastSavedMarkdownPath) {
				const currentValue = editor.getValue();
				const nextValue = persistLastSavedMarkdownPath(currentValue, completion.lastSavedMarkdownPath);
				if (nextValue !== currentValue) {
					editor.setValue(nextValue);
					writeOffset += nextValue.length - currentValue.length;
				}
			}
		} else if (config.stream) {
			const completion = await client.stream(messages, {
				onSearchStart: () => {
					if (!noticeRange) {
						const searchNotice = "_[Using web search...]_\n\n";
						editor.replaceRange(searchNotice, editor.offsetToPos(writeOffset));
						noticeRange = { start: writeOffset, end: writeOffset + searchNotice.length };
						writeOffset += searchNotice.length;
					}
				},
				onText: (delta) => {
					if (noticeRange) {
						editor.replaceRange("", editor.offsetToPos(noticeRange.start), editor.offsetToPos(noticeRange.end));
						writeOffset -= noticeRange.end - noticeRange.start;
						noticeRange = null;
					}

					editor.replaceRange(delta, editor.offsetToPos(writeOffset));
					writeOffset += delta.length;
					completionText += delta;
				},
			});

			sourcesAppendix = completion.sourcesAppendix;
		} else {
			const completion = await client.create(messages);
			completionText = completion.text;
			sourcesAppendix = completion.sourcesAppendix;
			editor.replaceRange(completionText, editor.offsetToPos(writeOffset));
			writeOffset += completionText.length;
		}

		const pendingNoticeRange = noticeRange;
		if (pendingNoticeRange) {
			writeOffset -= clearRange(editor, pendingNoticeRange);
			noticeRange = null;
		}

		if (sourcesAppendix) {
			editor.replaceRange(sourcesAppendix, editor.offsetToPos(writeOffset));
			writeOffset += sourcesAppendix.length;
		}
	} catch (error) {
		const pendingNoticeRange = noticeRange;
		if (pendingNoticeRange) {
			writeOffset -= clearRange(editor, pendingNoticeRange);
		}

		const message = error instanceof Error ? error.message : String(error);
		editor.replaceRange(`\n\n_Error: ${message}_`, editor.offsetToPos(writeOffset));
		writeOffset += `\n\n_Error: ${message}_`.length;
		new Notice(`Convo GPT request failed: ${message}`);
	}

	const assistantSuffix = buildAssistantSuffix(exchangeId, shouldShowTopOfAnswerLink(completionText));
	editor.replaceRange(assistantSuffix, editor.offsetToPos(writeOffset));
	editor.setCursor(editor.offsetToPos(writeOffset + assistantSuffix.length));
}

async function buildMessages(
	app: App,
	file: MarkdownView["file"],
	baseMessages: ChatMessage[],
	config: ResolvedChatConfig,
	agentBody: string,
): Promise<ChatMessage[]> {
	const messages: ChatMessage[] = [];

	if (config.defaultSystemPrompt.trim()) {
		messages.push({
			role: "system",
			content: config.defaultSystemPrompt.trim(),
		});
	}

	if (agentBody.trim()) {
		messages.push({
			role: "system",
			content: agentBody.trim(),
		});
	}

	for (const command of config.system_commands) {
		if (command.trim()) {
			messages.push({
				role: "system",
				content: command.trim(),
			});
		}
	}

	for (const message of baseMessages) {
		if (message.role !== "user") {
			messages.push(message);
			continue;
		}

		const enriched = await injectReferencedNoteContext(app, file ?? null, message.content);
		if (enriched.missingReferences.length > 0) {
			new Notice(`Convo GPT could not resolve: ${enriched.missingReferences.join(", ")}`);
		}

		messages.push({
			...message,
			content: enriched.content,
		});
	}

	return messages;
}

function resolveChatConfig(
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
	};
}

function clearRange(editor: Editor, range: OffsetRange): number {
	editor.replaceRange("", editor.offsetToPos(range.start), editor.offsetToPos(range.end));
	return range.end - range.start;
}

async function runMarkdownFileToolConversation(
	app: App,
	client: OpenAIClient,
	messages: ChatMessage[],
): Promise<OpenAICompletion & { lastSavedMarkdownPath?: string }> {
	let response = await client.createTurn({
		messages,
		includeMarkdownFileTool: true,
	});
	let lastSavedMarkdownPath: string | undefined;

	for (let round = 0; round < MAX_MARKDOWN_TOOL_ROUNDS; round += 1) {
		if (response.toolCalls.length === 0) {
			return {
				text: response.text,
				sourcesAppendix: response.sourcesAppendix,
				lastSavedMarkdownPath,
			};
		}

		const toolOutputs = [];
		for (const toolCall of response.toolCalls) {
			if (toolCall.name !== MARKDOWN_FILE_TOOL_NAME) {
				toolOutputs.push(
					buildFunctionCallOutput(toolCall.call_id, {
						status: "validation_error",
						message: `Unsupported tool call: ${toolCall.name}`,
					}),
				);
				continue;
			}

			const result = await executeMarkdownWriteToolCall(app, toolCall.arguments);
			if (result.status === "success" && result.path) {
				lastSavedMarkdownPath = result.path;
			}
			toolOutputs.push(buildFunctionCallOutput(toolCall.call_id, result));
		}

		response = await client.createTurn({
			includeMarkdownFileTool: true,
			inputItems: toolOutputs,
			previousResponseId: response.responseId,
		});
	}

	throw new Error("Convo GPT exceeded the markdown file tool round limit.");
}

function withMarkdownFileToolPolicy(messages: ChatMessage[], rememberedPath?: string): ChatMessage[] {
	return [
		...messages,
		{
			role: "system",
			content: buildMarkdownFileToolPolicy(rememberedPath),
		},
	];
}
