import { Notice, TFile, type App, type Editor, type MarkdownView } from "obsidian";
import { resolveAgent } from "./agent-resolver";
import { resolveChatConfig } from "./chat-config";
import { injectReferencedNoteContext } from "./context-resolver";
import {
	parseNoteDocument,
	setNoteFrontmatterField,
} from "./frontmatter";
import {
	buildLinkedDocumentSystemPrompt,
	buildLinkedDocumentToolPolicy,
	deriveLinkedDocumentReferenceFromChatPath,
	detectLinkedDocumentEditIntent,
	linkifyLinkedDocumentMentions,
	loadLinkedDocumentContext,
	shouldContinueLinkedDocumentDrafting,
	type LinkedDocumentContext,
} from "./document-mode";
import { executeFetchToolCall } from "./fetch-service";
import {
	buildFetchToolPolicy,
	FETCH_TOOL_NAME,
	formatFetchAppendix,
	parseFetchRequest,
	shouldOfferFetchTool,
	type FetchSummary,
} from "./fetch-tool";
import {
	executeMarkdownWriteToolCall,
	resolveMarkdownWriteTargetPath,
} from "./markdown-file-service";
import {
	addReferencedFileReadSeeds,
	createReferencedFileReadState,
	executeReferencedFileReadToolCall,
	type ReferencedFileReadState,
} from "./referenced-file-service";
import {
	buildMarkdownFileToolPolicy,
	extractExplicitMarkdownTarget,
	formatMarkdownWikiLink,
	hasExplicitMarkdownWriteIntent,
	MAX_MARKDOWN_TOOL_ROUNDS,
	MARKDOWN_FILE_TOOL_NAME,
	parseMarkdownWriteRequest,
	shouldOfferMarkdownFileTool,
} from "./markdown-file-tool";
import {
	buildFunctionCallOutput,
	formatReferencedFileAppendix,
	buildReferencedFileToolPolicy,
	normalizeReferencedFileLookup,
	parseReferencedFileReadRequest,
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
	let linkedDocument: LinkedDocumentContext | undefined;
	let referencedFileReadState: ReferencedFileReadState | undefined;

	try {
		exchangeId = getNextExchangeId(editor.getValue());
		document = parseNoteDocument(editor.getValue());
		let sections = parseSections(document.body);
		if (sections.length === 0) {
			new Notice("Convo GPT needs note content to send.");
			return;
		}

		const lastSection = sections[sections.length - 1];
		if (!lastSection || lastSection.role !== "user" || !lastSection.content.trim()) {
			new Notice("Convo GPT expects the last message in the note to be a non-empty user message.");
			return;
		}

		document = inferLinkedDocumentReference(app, file, editor, document, lastSection.content);
		sections = parseSections(document.body);
		linkedDocument = await resolveLinkedDocument(
			app,
			file,
			document.overrides.document,
			lastSection.content,
			sections
				.filter((section) => section.role === "user")
				.slice(0, -1)
				.map((section) => section.content),
		);

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
			linkedDocument,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`Convo GPT request failed: ${message}`);
		return;
	}

	const lastMessage = messages[messages.length - 1];
	const assistantPrefix = buildAssistantPrefix(config.model, exchangeId);
	let writeOffset = editor.getValue().length;
	editor.replaceRange(assistantPrefix, editor.offsetToPos(writeOffset));
	writeOffset += assistantPrefix.length;
	const completionStartOffset = writeOffset;

	let completionText = "";
	let sourcesAppendix = "";
	let shouldPlaceFinalCursor = true;
	const shouldUseFetchTool = shouldOfferFetchTool(lastMessage.content, config.enableFetchTool);
	const shouldUseMarkdownFileTool = shouldOfferMarkdownFileTool(
		lastMessage.content,
		config.enableMarkdownFileTool,
		Boolean(linkedDocument?.shouldAutoWrite),
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
					linkedDocument,
				}),
				config.model,
				requestStatus,
				{
					includeFetchTool: shouldUseFetchTool,
					includeMarkdownFileTool: shouldUseMarkdownFileTool,
					includeReferencedFileTool: shouldUseReferencedFileTool,
					linkedDocument,
					referencedFileReadState,
				},
			);
			completionText = completion.text;
			sourcesAppendix = completion.sourcesAppendix;
			completionText = postProcessCompletionText(completionText, linkedDocument);
			editor.replaceRange(completionText, editor.offsetToPos(writeOffset));
			writeOffset += completionText.length;
		} else if (config.stream) {
			const writer = new StreamingWriter(editor, editor.offsetToPos(writeOffset));
			writer.start();
			let didSetStreamingStatus = false;
			const completion = await client.stream(messages, {
				onSearchStart: () => {
					requestStatus.notifyToolUse("Using web search");
					requestStatus.setWebSearch();
				},
				onText: (delta) => {
					if (!didSetStreamingStatus) {
						requestStatus.setStreaming(config.model);
						didSetStreamingStatus = true;
					}

					writer.append(delta);
					completionText += delta;
				},
			});
			writer.stop();
			writeOffset = editor.posToOffset(writer.getCursor());
			shouldPlaceFinalCursor = writer.isAutoFollowEnabled();
			const nextCompletionText = postProcessCompletionText(completionText, linkedDocument);
			if (nextCompletionText !== completionText) {
				editor.replaceRange(nextCompletionText, editor.offsetToPos(completionStartOffset), editor.offsetToPos(writeOffset));
				writeOffset = completionStartOffset + nextCompletionText.length;
				completionText = nextCompletionText;
			}

			sourcesAppendix = completion.sourcesAppendix;
		} else {
			const completion = await client.create(messages);
			completionText = postProcessCompletionText(completion.text, linkedDocument);
			sourcesAppendix = completion.sourcesAppendix;
			editor.replaceRange(completionText, editor.offsetToPos(writeOffset));
			writeOffset += completionText.length;
		}

		if (sourcesAppendix) {
			editor.replaceRange(sourcesAppendix, editor.offsetToPos(writeOffset));
			writeOffset += sourcesAppendix.length;
		}
	} catch (error) {
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
	linkedDocument?: LinkedDocumentContext,
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

	if (linkedDocument) {
		messages.push({
			role: "system",
			content: buildLinkedDocumentSystemPrompt(linkedDocument),
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

interface ToolConversationOptions {
	includeFetchTool: boolean;
	includeMarkdownFileTool: boolean;
	includeReferencedFileTool: boolean;
	linkedDocument?: LinkedDocumentContext;
	referencedFileReadState?: ReferencedFileReadState;
}

async function runToolConversation(
	app: App,
	client: OpenAIClient,
	messages: ChatMessage[],
	model: string,
	requestStatus: RequestStatusManager,
	options: ToolConversationOptions,
): Promise<OpenAICompletion> {
	let response = await client.createTurn({
		messages,
		includeFetchTool: options.includeFetchTool,
		includeMarkdownFileTool: options.includeMarkdownFileTool,
		includeReferencedFileTool: options.includeReferencedFileTool,
	});
	const fetchCalls: FetchSummary[] = [];
	const referencedFilesRead: ReferencedFileSummary[] = [];

	for (let round = 0; round < MAX_MARKDOWN_TOOL_ROUNDS; round += 1) {
		if (response.toolCalls.length === 0) {
			return {
				text: response.text,
				sourcesAppendix: `${response.sourcesAppendix}${formatReferencedFileAppendix(referencedFilesRead)}${formatFetchAppendix(fetchCalls)}`,
			};
		}

		const toolOutputs = [];
		for (const toolCall of response.toolCalls) {
			if (toolCall.name === FETCH_TOOL_NAME && options.includeFetchTool) {
				requestStatus.notifyToolUse(describeFetchToolCall(toolCall.arguments));
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
				requestStatus.notifyToolUse(describeMarkdownToolCall(toolCall.arguments));
				const result = await executeMarkdownWriteToolCall(app, toolCall.arguments, undefined, {
					statusCallbacks: {
						onSaving: (path) => {
							requestStatus.setSaving(path);
						},
						onWaitingForApproval: () => {
							requestStatus.setWaitingForFileApproval();
						},
					},
					trustedPaths:
						options.linkedDocument?.shouldAutoWrite === true
							? new Set([options.linkedDocument.path])
							: undefined,
				});
				toolOutputs.push(buildFunctionCallOutput(toolCall.call_id, result));
				continue;
			}

			if (toolCall.name === REFERENCED_FILE_TOOL_NAME && options.includeReferencedFileTool && options.referencedFileReadState) {
				requestStatus.notifyToolUse(describeReferencedFileToolCall(toolCall.arguments));
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

function describeFetchToolCall(argumentsJson: string): string {
	const parsed = parseFetchRequest(argumentsJson);
	if (!parsed.success) {
		return "Using fetch";
	}

	return `Using fetch: ${parsed.data.method} ${parsed.data.url}`;
}

function describeMarkdownToolCall(argumentsJson: string): string {
	const parsed = parseMarkdownWriteRequest(argumentsJson);
	if (!parsed.success) {
		return "Using markdown save tool";
	}

	return `Saving markdown file: ${parsed.data.path}`;
}

function describeReferencedFileToolCall(argumentsJson: string): string {
	const parsed = parseReferencedFileReadRequest(argumentsJson);
	if (!parsed.success) {
		return "Reading referenced file";
	}

	const normalizedReference = normalizeReferencedFileLookup(parsed.data.reference);
	return `Reading referenced file: ${normalizedReference || parsed.data.reference}`;
}

function withToolPolicies(
	messages: ChatMessage[],
	options: {
		includeFetchTool: boolean;
		includeMarkdownFileTool: boolean;
		includeReferencedFileTool: boolean;
		linkedDocument?: LinkedDocumentContext;
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
			content: buildMarkdownFileToolPolicy(),
		});

		if (options.linkedDocument?.shouldAutoWrite) {
			nextMessages.push({
				role: "system",
				content: buildLinkedDocumentToolPolicy(options.linkedDocument),
			});
		}
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

function inferLinkedDocumentReference(
	app: App,
	file: TFile,
	editor: Editor,
	document: ReturnType<typeof parseNoteDocument>,
	lastUserMessage: string,
): ReturnType<typeof parseNoteDocument> {
	if (document.overrides.document) {
		return document;
	}

	let nextReference: string | null = null;
	if (hasExplicitMarkdownWriteIntent(lastUserMessage)) {
		const explicitTarget = extractExplicitMarkdownTarget(lastUserMessage);
		if (explicitTarget) {
			const resolved = resolveMarkdownWriteTargetPath(app, explicitTarget, file.path);
			if (resolved.success) {
				nextReference = formatMarkdownWikiLink(resolved.path);
			}
		}
	}

	if (!nextReference) {
		nextReference = deriveLinkedDocumentReferenceFromChatPath(file.path, lastUserMessage);
	}

	if (!nextReference) {
		return document;
	}

	const nextText = setNoteFrontmatterField(editor.getValue(), "document", nextReference);
	editor.setValue(nextText);
	return parseNoteDocument(nextText);
}

async function resolveLinkedDocument(
	app: App,
	file: TFile,
	reference: string | undefined,
	lastUserMessage: string,
	previousUserMessages: string[],
): Promise<LinkedDocumentContext | undefined> {
	if (!reference?.trim()) {
		return undefined;
	}

	const result = await loadLinkedDocumentContext(app, file.path, reference);
	if (!result.success) {
		new Notice(`Convo GPT document mode disabled: ${result.error}`);
		return undefined;
	}

	return {
		...result.context,
		shouldAutoWrite:
			detectLinkedDocumentEditIntent(lastUserMessage) ||
			shouldContinueLinkedDocumentDrafting(
				lastUserMessage,
				previousUserMessages.some((message) => detectLinkedDocumentEditIntent(message)),
			),
	};
}

function postProcessCompletionText(text: string, linkedDocument?: LinkedDocumentContext): string {
	if (!linkedDocument) {
		return text;
	}

	return linkifyLinkedDocumentMentions(text, linkedDocument.path);
}
