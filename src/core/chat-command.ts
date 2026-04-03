import { Notice, TFile, type App, type Editor, type EditorPosition, type MarkdownView } from "obsidian";
import { resolveAgent } from "./agent-resolver";
import { resolveChatConfig } from "./chat-config";
import { injectReferencedNoteContext } from "./context-resolver";
import { parseNoteDocument, persistLastSavedMarkdownPath } from "./frontmatter";
import { executeFetchToolCall } from "./fetch-service";
import {
	buildFetchToolPolicy,
	FETCH_TOOL_NAME,
	formatFetchAppendix,
	shouldOfferFetchTool,
	type FetchSummary,
} from "./fetch-tool";
import { executeMarkdownWriteToolCall } from "./markdown-file-service";
import {
	addReferencedFileReadSeeds,
	createReferencedFileReadState,
	executeReferencedFileReadToolCall,
	type ReferencedFileReadState,
} from "./referenced-file-service";
import {
	buildMarkdownFileToolPolicy,
	MAX_MARKDOWN_TOOL_ROUNDS,
	MARKDOWN_FILE_TOOL_NAME,
	shouldOfferMarkdownFileTool,
} from "./markdown-file-tool";
import {
	buildFunctionCallOutput,
	formatReferencedFileAppendix,
	buildReferencedFileToolPolicy,
	REFERENCED_FILE_TOOL_NAME,
	type ReferencedFileSummary,
	type ReferencedFileReadToolResult,
} from "./referenced-file-tool";
import { shouldShowTopOfAnswerLink } from "./response-length";
import { parseSections } from "./message-parser";
import { OpenAIClient, type OpenAICompletion } from "./openai-client";
import type { RequestStatusManager } from "./request-status";
import { buildAssistantPrefix, buildAssistantSuffix, getNextExchangeId } from "./response-anchors";
import { StreamingWriter } from "./streaming-writer";
import type { ChatMessage, PluginSettings, ResolvedChatConfig } from "./types";

interface ChatCommandContext {
	app: App;
	editor: Editor;
	requestStatus: RequestStatusManager;
	view: MarkdownView;
	settings: PluginSettings;
}

interface OffsetRange {
	start: EditorPosition;
	end: EditorPosition;
}

export async function runChatCommand(context: ChatCommandContext): Promise<void> {
	const { app, editor, requestStatus, settings, view } = context;
	const file = view.file;

	if (!file) {
		new Notice("Convo GPT requires an open note.");
		return;
	}

	let exchangeId: string;
	let document: ReturnType<typeof parseNoteDocument>;
	let config: ResolvedChatConfig;
	let messages: ChatMessage[];
	let referencedFileReadState: ReferencedFileReadState | undefined;

	try {
		exchangeId = getNextExchangeId(editor.getValue());
		document = parseNoteDocument(editor.getValue());
		const sections = parseSections(document.body);
		if (sections.length === 0) {
			new Notice("Convo GPT needs note content to send.");
			return;
		}

		const agent = await resolveAgent(app, settings, document.overrides.agent);
		config = resolveChatConfig(settings, agent?.frontmatter, document.overrides);
		if (!config.apiKey) {
			new Notice("Convo GPT is missing an OpenAI API key.");
			return;
		}

		let agentBody = agent?.body ?? "";
		if (config.enableReferencedFileReadTool) {
			referencedFileReadState = createReferencedFileReadState(config.referencedFileExtensions);

			if (agent && agentBody.trim()) {
				const missingReferences = addReferencedFileReadSeeds(app, referencedFileReadState, [
					{
						currentFile: agent.file,
						content: agentBody,
					},
				]);
				if (missingReferences.length > 0) {
					new Notice(`Convo GPT could not resolve agent references: ${missingReferences.join(", ")}`);
				}
			}

			const missingReferences = addReferencedFileReadSeeds(app, referencedFileReadState, [
				{
					currentFile: file,
					content: document.body,
				},
			]);
			if (missingReferences.length > 0) {
				new Notice(`Convo GPT could not resolve: ${missingReferences.join(", ")}`);
			}
		} else if (agent && agentBody.trim()) {
			const enrichedAgent = await injectReferencedNoteContext(app, agent.file, agentBody);
			if (enrichedAgent.missingReferences.length > 0) {
				new Notice(`Convo GPT could not resolve agent references: ${enrichedAgent.missingReferences.join(", ")}`);
			}
			agentBody = enrichedAgent.content;
		}

		messages = await buildMessages(
			app,
			file,
			sections.map((section) => ({
				role: section.role,
				content: section.content,
			})),
			config,
			agentBody,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`Convo GPT request failed: ${message}`);
		return;
	}

	const lastMessage = messages[messages.length - 1];
	if (!lastMessage || lastMessage.role !== "user" || !lastMessage.content.trim()) {
		new Notice("Convo GPT expects the last message in the note to be a non-empty user message.");
		return;
	}

	const assistantPrefix = buildAssistantPrefix(config.model, exchangeId);
	let writeOffset = editor.getValue().length;
	editor.replaceRange(assistantPrefix, editor.offsetToPos(writeOffset));
	writeOffset += assistantPrefix.length;

	let noticeRange: OffsetRange | null = null;
	let completionText = "";
	let sourcesAppendix = "";
	let shouldPlaceFinalCursor = true;
	const shouldUseFetchTool = shouldOfferFetchTool(lastMessage.content, config.enableFetchTool);
	const shouldUseMarkdownFileTool = shouldOfferMarkdownFileTool(
		lastMessage.content,
		config.enableMarkdownFileTool,
		document.lastSavedMarkdownPath,
	);
	const shouldUseReferencedFileTool = Boolean(
		config.enableReferencedFileReadTool && referencedFileReadState && referencedFileReadState.allowedPaths.size > 0,
	);

	try {
		const client = new OpenAIClient(config);
		requestStatus.notifyRequestStart(`Calling ${config.model}`);
		requestStatus.setCalling(config.model);

		if (shouldUseFetchTool || shouldUseMarkdownFileTool || shouldUseReferencedFileTool) {
			const completion = await runToolConversation(
				app,
				client,
				withToolPolicies(messages, {
					includeFetchTool: shouldUseFetchTool,
					includeMarkdownFileTool: shouldUseMarkdownFileTool,
					includeReferencedFileTool: shouldUseReferencedFileTool,
					rememberedPath: document.lastSavedMarkdownPath,
				}),
				config.model,
				requestStatus,
				{
					includeFetchTool: shouldUseFetchTool,
					includeMarkdownFileTool: shouldUseMarkdownFileTool,
					includeReferencedFileTool: shouldUseReferencedFileTool,
					referencedFileReadState,
				},
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
			const writer = new StreamingWriter(editor, editor.offsetToPos(writeOffset));
			writer.start();
			let didSetStreamingStatus = false;
			const completion = await client.stream(messages, {
				onSearchStart: () => {
					writer.forceFlush();
					if (!noticeRange) {
						const searchNotice = "_[Using web search...]_\n\n";
						const start = writer.getCursor();
						editor.replaceRange(searchNotice, start);
						const end = editor.offsetToPos(editor.posToOffset(start) + searchNotice.length);
						writer.setCursor(end);
						noticeRange = {
							start,
							end,
						};
					}
					requestStatus.setWebSearch();
				},
				onText: (delta) => {
					if (noticeRange) {
						const pendingNoticeRange = noticeRange;
						editor.replaceRange("", pendingNoticeRange.start, pendingNoticeRange.end);
						writer.setCursor(pendingNoticeRange.start);
						noticeRange = null;
					}

					if (!didSetStreamingStatus) {
						requestStatus.setStreaming(config.model);
						didSetStreamingStatus = true;
					}

					writer.append(delta);
					completionText += delta;
				},
			});
			writer.stop();
			if (noticeRange) {
				const pendingNoticeRange: OffsetRange = noticeRange;
				editor.replaceRange("", pendingNoticeRange.start, pendingNoticeRange.end);
				writer.setCursor(pendingNoticeRange.start);
				noticeRange = null;
			}
			writeOffset = editor.posToOffset(writer.getCursor());
			shouldPlaceFinalCursor = writer.isAutoFollowEnabled();

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
			clearRange(editor, pendingNoticeRange);
			noticeRange = null;
		}

		if (sourcesAppendix) {
			editor.replaceRange(sourcesAppendix, editor.offsetToPos(writeOffset));
			writeOffset += sourcesAppendix.length;
		}
	} catch (error) {
		const pendingNoticeRange = noticeRange;
		if (pendingNoticeRange) {
			clearRange(editor, pendingNoticeRange);
		}

		const message = error instanceof Error ? error.message : String(error);
		editor.replaceRange(`\n\n_Error: ${message}_`, editor.offsetToPos(writeOffset));
		writeOffset += `\n\n_Error: ${message}_`.length;
		new Notice(`Convo GPT request failed: ${message}`);
	} finally {
		requestStatus.clear();
	}

	const assistantSuffix = buildAssistantSuffix(exchangeId, shouldShowTopOfAnswerLink(completionText));
	editor.replaceRange(assistantSuffix, editor.offsetToPos(writeOffset));
	if (shouldPlaceFinalCursor) {
		editor.setCursor(editor.offsetToPos(writeOffset + assistantSuffix.length));
	}
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

		if (config.enableReferencedFileReadTool) {
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

function clearRange(editor: Editor, range: OffsetRange): number {
	const removedLength = editor.posToOffset(range.end) - editor.posToOffset(range.start);
	editor.replaceRange("", range.start, range.end);
	return removedLength;
}

interface ToolConversationOptions {
	includeFetchTool: boolean;
	includeMarkdownFileTool: boolean;
	includeReferencedFileTool: boolean;
	referencedFileReadState?: ReferencedFileReadState;
}

async function runToolConversation(
	app: App,
	client: OpenAIClient,
	messages: ChatMessage[],
	model: string,
	requestStatus: RequestStatusManager,
	options: ToolConversationOptions,
): Promise<OpenAICompletion & { lastSavedMarkdownPath?: string }> {
	let response = await client.createTurn({
		messages,
		includeFetchTool: options.includeFetchTool,
		includeMarkdownFileTool: options.includeMarkdownFileTool,
		includeReferencedFileTool: options.includeReferencedFileTool,
	});
	const fetchCalls: FetchSummary[] = [];
	let lastSavedMarkdownPath: string | undefined;
	const referencedFilesRead: ReferencedFileSummary[] = [];

	for (let round = 0; round < MAX_MARKDOWN_TOOL_ROUNDS; round += 1) {
		if (response.toolCalls.length === 0) {
			return {
				text: response.text,
				sourcesAppendix: `${response.sourcesAppendix}${formatReferencedFileAppendix(referencedFilesRead)}${formatFetchAppendix(fetchCalls)}`,
				lastSavedMarkdownPath,
			};
		}

		const toolOutputs = [];
		for (const toolCall of response.toolCalls) {
			if (toolCall.name === FETCH_TOOL_NAME && options.includeFetchTool) {
				const result = await executeFetchToolCall(toolCall.arguments);
				if (result.status === "success" && result.method && result.statusCode && (result.finalUrl || result.url)) {
					fetchCalls.push({
						method: result.method,
						statusCode: result.statusCode,
						truncated: Boolean(result.truncated),
						url: result.finalUrl || result.url!,
					});
				}
				toolOutputs.push(buildFunctionCallOutput(toolCall.call_id, result));
				continue;
			}

			if (toolCall.name === MARKDOWN_FILE_TOOL_NAME && options.includeMarkdownFileTool) {
				const result = await executeMarkdownWriteToolCall(app, toolCall.arguments, undefined, {
					onSaving: (path) => {
						requestStatus.setSaving(path);
					},
					onWaitingForApproval: () => {
						requestStatus.setWaitingForFileApproval();
					},
				});
				if (result.status === "success" && result.path) {
					lastSavedMarkdownPath = result.path;
				}
				toolOutputs.push(buildFunctionCallOutput(toolCall.call_id, result));
				continue;
			}

			if (toolCall.name === REFERENCED_FILE_TOOL_NAME && options.includeReferencedFileTool && options.referencedFileReadState) {
				const result = await executeReferencedFileReadToolCall(app, toolCall.arguments, options.referencedFileReadState);
				registerReferencedFileResult(app, options.referencedFileReadState, result);
				if (result.status === "success" && result.path) {
					referencedFilesRead.push({
						path: result.path,
						truncated: Boolean(result.truncated),
					});
				}
				toolOutputs.push(buildFunctionCallOutput(toolCall.call_id, result));
				continue;
			}

			toolOutputs.push(
				buildFunctionCallOutput(toolCall.call_id, {
					status: "validation_error",
					message: `Unsupported tool call: ${toolCall.name}`,
				}),
			);
		}

		requestStatus.setCalling(model);
		response = await client.createTurn({
			includeFetchTool: options.includeFetchTool,
			includeMarkdownFileTool: options.includeMarkdownFileTool,
			includeReferencedFileTool: options.includeReferencedFileTool,
			inputItems: toolOutputs,
			previousResponseId: response.responseId,
		});
	}

	throw new Error("Convo GPT exceeded the markdown file tool round limit.");
}

function withToolPolicies(
	messages: ChatMessage[],
	options: {
		includeFetchTool: boolean;
		includeMarkdownFileTool: boolean;
		includeReferencedFileTool: boolean;
		rememberedPath?: string;
	},
): ChatMessage[] {
	const nextMessages = [...messages];

	if (options.includeFetchTool) {
		nextMessages.push({
			role: "system",
			content: buildFetchToolPolicy(),
		});
	}

	if (options.includeReferencedFileTool) {
		nextMessages.push({
			role: "system",
			content: buildReferencedFileToolPolicy(),
		});
	}

	if (options.includeMarkdownFileTool) {
		nextMessages.push({
			role: "system",
			content: buildMarkdownFileToolPolicy(options.rememberedPath),
		});
	}

	return nextMessages;
}

function registerReferencedFileResult(
	app: App,
	state: ReferencedFileReadState,
	result: ReferencedFileReadToolResult,
): void {
	if (result.status !== "success" || !result.path || typeof result.content !== "string") {
		return;
	}

	const file = app.vault.getAbstractFileByPath(result.path);
	if (!(file instanceof TFile)) {
		return;
	}

	addReferencedFileReadSeeds(app, state, [
		{
			currentFile: file,
			content: result.content,
		},
	]);
}
