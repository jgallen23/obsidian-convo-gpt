import { Notice, TFile, type App, type Editor, type MarkdownView } from "obsidian";
import { resolveAgent } from "./agent-resolver";
import { resolveChatConfig } from "./chat-config";
import { injectReferencedNoteContext } from "./context-resolver";
import { parseNoteDocument } from "./frontmatter";
import {
	buildLinkedDocumentSystemPrompt,
	buildLinkedDocumentToolPolicy,
	detectLinkedDocumentEditIntent,
	linkifyLinkedDocumentMentions,
	loadLinkedDocumentContext,
	shouldContinueLinkedDocumentDrafting,
	type LinkedDocumentContext,
} from "./document-mode";
import { executeFetchToolCall } from "./fetch-service";
import { logConvoDebug } from "./debug-log";
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
} from "./markdown-file-service";
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
import { isGeneratedChatBasename } from "./note-title";
import { shouldShowTopOfAnswerLink } from "./response-length";
import { parseSections } from "./message-parser";
import {
	createForcedFunctionToolChoice,
	OpenAIClient,
	type CreateTurnParams,
	type OpenAICompletion,
	type OpenAITurn,
} from "./openai-client";
import type { RequestStatusManager } from "./request-status";
import { buildAssistantPrefix, buildAssistantSuffix, getNextExchangeId } from "./response-anchors";
import { StreamingWriter } from "./streaming-writer";
import { inferRetitledBasename } from "./title-inference";
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
	let agentBodyForTitle = "";
	let agentFileForTitle: TFile | null = null;
	let shouldAutoRetitle = false;

	try {
		const editorText = editor.getValue();
		exchangeId = getNextExchangeId(editorText);
		document = await loadNoteDocumentForChat(app, file, editorText);
		const sections = parseSections(document.body);
		if (sections.length === 0) {
			new Notice("Convo GPT needs note content to send.");
			return;
		}

		const lastSection = sections[sections.length - 1];
		if (!lastSection || lastSection.role !== "user" || !lastSection.content.trim()) {
			new Notice("Convo GPT expects the last message in the note to be a non-empty user message.");
			return;
		}
		shouldAutoRetitle =
			isGeneratedChatBasename(file.basename) &&
			sections.filter((section) => section.role === "user").length === 1 &&
			sections.every((section) => section.role !== "assistant");

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
		agentFileForTitle = agent?.file ?? null;
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
		agentBodyForTitle = agentBody;

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
	let shouldAttemptAutoRetitle = false;
	const shouldUseFetchTool = shouldOfferFetchTool(lastMessage.content, config.enableFetchTool);
	const shouldUseMarkdownFileTool = shouldOfferMarkdownFileTool(
		lastMessage.content,
		config.enableMarkdownFileTool,
		Boolean(linkedDocument?.shouldAutoWrite),
	);
	const shouldUseReferencedFileTool = Boolean(
		config.enableReferencedFileReadTool && referencedFileReadState && referencedFileReadState.allowedPaths.size > 0,
	);
	logConvoDebug("chat.run.flags", {
		notePath: file.path,
		linkedDocumentPath: linkedDocument?.path ?? null,
		linkedDocumentAutoWrite: linkedDocument?.shouldAutoWrite ?? false,
		shouldUseFetchTool,
		shouldUseMarkdownFileTool,
		shouldUseReferencedFileTool,
	});

	try {
		const client = new OpenAIClient(config);
		requestStatus.notifyRequestStart(`Calling ${config.model}`);
		requestStatus.setCalling(config.model);

		if (shouldUseFetchTool || shouldUseMarkdownFileTool || shouldUseReferencedFileTool) {
			const toolResult = await runToolConversation(
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
					requireLinkedDocumentSave: linkedDocument?.shouldAutoWrite === true,
					stopBeforePlainAssistantTurn: config.stream,
				},
			);
			if (toolResult.kind === "completion") {
				completionText = toolResult.completion.text;
				sourcesAppendix = toolResult.completion.sourcesAppendix;
				completionText = postProcessCompletionText(completionText, linkedDocument);
				editor.replaceRange(completionText, editor.offsetToPos(writeOffset));
				writeOffset += completionText.length;
			} else {
				let continuation = toolResult.continuation;

				while (true) {
					const streamedStartOffset = writeOffset;
					const writer = new StreamingWriter(editor, editor.offsetToPos(writeOffset));
					writer.start();
					let didSetStreamingStatus = false;
					let streamedText = "";
					const streamedResponse = await client.streamTurn(
						{
							includeFetchTool: shouldUseFetchTool,
							includeMarkdownFileTool: shouldUseMarkdownFileTool,
							includeReferencedFileTool: shouldUseReferencedFileTool,
							inputItems: continuation.inputItems,
							previousResponseId: continuation.previousResponseId,
							toolChoice: continuation.toolChoice,
						},
						{
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
								streamedText += delta;
							},
						},
					);
					writer.stop();
					writeOffset = editor.posToOffset(writer.getCursor());
					shouldPlaceFinalCursor = writer.isAutoFollowEnabled();

					if (streamedResponse.toolCalls.length === 0) {
						completionText = streamedText || streamedResponse.text;
						const nextCompletionText = postProcessCompletionText(completionText, linkedDocument);
						if (nextCompletionText !== completionText) {
							editor.replaceRange(
								nextCompletionText,
								editor.offsetToPos(streamedStartOffset),
								editor.offsetToPos(writeOffset),
							);
							writeOffset = streamedStartOffset + nextCompletionText.length;
						}
						completionText = nextCompletionText;
						sourcesAppendix = `${streamedResponse.sourcesAppendix}${formatToolConversationAppendix(continuation.state)}`;
						break;
					}

					editor.replaceRange("", editor.offsetToPos(streamedStartOffset), editor.offsetToPos(writeOffset));
					writeOffset = streamedStartOffset;

					const resumedToolResult = await resumeToolConversation(
						app,
						client,
						streamedResponse,
						config.model,
						requestStatus,
						{
							includeFetchTool: shouldUseFetchTool,
							includeMarkdownFileTool: shouldUseMarkdownFileTool,
							includeReferencedFileTool: shouldUseReferencedFileTool,
							linkedDocument,
							referencedFileReadState,
							requireLinkedDocumentSave: linkedDocument?.shouldAutoWrite === true,
							stopBeforePlainAssistantTurn: true,
						},
						continuation.state,
						continuation.roundsCompleted,
					);

					if (resumedToolResult.kind === "completion") {
						completionText = postProcessCompletionText(resumedToolResult.completion.text, linkedDocument);
						sourcesAppendix = resumedToolResult.completion.sourcesAppendix;
						editor.replaceRange(completionText, editor.offsetToPos(writeOffset));
						writeOffset += completionText.length;
						break;
					}

					continuation = resumedToolResult.continuation;
				}
			}
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
		shouldAttemptAutoRetitle = shouldAutoRetitle;
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

	if (shouldAttemptAutoRetitle) {
		const client = new OpenAIClient(config);
		await autoRetitleChatNote(app, file, editor, client, {
			agentBody: agentBodyForTitle,
			agentFile: agentFileForTitle,
			defaultSystemPrompt: config.defaultSystemPrompt,
			systemCommands: config.system_commands,
		});
	}
}

async function loadNoteDocumentForChat(app: App, file: TFile, editorText: string): Promise<ReturnType<typeof parseNoteDocument>> {
	const editorDocument = parseNoteDocument(editorText);
	const storedText = await readStoredNoteText(app, file);
	if (storedText === null) {
		logConvoDebug("chat.noteDocument.editorOnly", {
			notePath: file.path,
			editorHasDocument: Boolean(editorDocument.overrides.document),
			editorHasAgent: Boolean(editorDocument.overrides.agent),
		});
		return editorDocument;
	}

	const storedDocument = parseNoteDocument(storedText);
	logConvoDebug("chat.noteDocument.compare", {
		notePath: file.path,
		editorHasDocument: Boolean(editorDocument.overrides.document),
		storedHasDocument: Boolean(storedDocument.overrides.document),
		editorHasAgent: Boolean(editorDocument.overrides.agent),
		storedHasAgent: Boolean(storedDocument.overrides.agent),
		editorStartsWithFrontmatter: editorText.startsWith("---\n") || editorText.startsWith("---\r\n"),
		storedStartsWithFrontmatter: storedText.startsWith("---\n") || storedText.startsWith("---\r\n"),
	});

	return {
		...editorDocument,
		overrides: mergeNoteOverrides(storedDocument.overrides, editorDocument.overrides),
	};
}

async function readStoredNoteText(app: App, file: TFile): Promise<string | null> {
	try {
		if ("cachedRead" in app.vault && typeof app.vault.cachedRead === "function") {
			return await app.vault.cachedRead(file);
		}

		return await app.vault.read(file);
	} catch (error) {
		logConvoDebug("chat.noteDocument.readStoredFailed", {
			notePath: file.path,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function mergeNoteOverrides(
	storedOverrides: ReturnType<typeof parseNoteDocument>["overrides"],
	editorOverrides: ReturnType<typeof parseNoteDocument>["overrides"],
): ReturnType<typeof parseNoteDocument>["overrides"] {
	return {
		...storedOverrides,
		...editorOverrides,
		system_commands:
			editorOverrides.system_commands && editorOverrides.system_commands.length > 0
				? editorOverrides.system_commands
				: storedOverrides.system_commands ?? [],
	};
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
	requireLinkedDocumentSave?: boolean;
	stopBeforePlainAssistantTurn?: boolean;
}

interface ToolConversationState {
	didSaveLinkedDocument: boolean;
	fetchCalls: FetchSummary[];
	referencedFilesRead: ReferencedFileSummary[];
}

interface ToolConversationContinuation {
	inputItems: NonNullable<CreateTurnParams["inputItems"]>;
	previousResponseId: string;
	roundsCompleted: number;
	state: ToolConversationState;
	toolChoice?: CreateTurnParams["toolChoice"];
}

type ToolConversationResult =
	| {
			kind: "completion";
			completion: OpenAICompletion;
	  }
	| {
			kind: "continue";
			continuation: ToolConversationContinuation;
	  };

async function runToolConversation(
	app: App,
	client: OpenAIClient,
	messages: ChatMessage[],
	model: string,
	requestStatus: RequestStatusManager,
	options: ToolConversationOptions,
): Promise<ToolConversationResult> {
	logConvoDebug("chat.toolConversation.start", {
		includeFetchTool: options.includeFetchTool,
		includeMarkdownFileTool: options.includeMarkdownFileTool,
		includeReferencedFileTool: options.includeReferencedFileTool,
		requireLinkedDocumentSave: options.requireLinkedDocumentSave ?? false,
		linkedDocumentPath: options.linkedDocument?.path ?? null,
	});
	let response = await client.createTurn({
		messages,
		includeFetchTool: options.includeFetchTool,
		includeMarkdownFileTool: options.includeMarkdownFileTool,
		includeReferencedFileTool: options.includeReferencedFileTool,
		toolChoice: options.requireLinkedDocumentSave ? "required" : undefined,
	});
	return resumeToolConversation(
		app,
		client,
		response,
		model,
		requestStatus,
		options,
		{
			didSaveLinkedDocument: false,
			fetchCalls: [],
			referencedFilesRead: [],
		},
		0,
	);
}

async function resumeToolConversation(
	app: App,
	client: OpenAIClient,
	response: OpenAITurn,
	model: string,
	requestStatus: RequestStatusManager,
	options: ToolConversationOptions,
	state: ToolConversationState,
	startingRound: number,
): Promise<ToolConversationResult> {
	for (let round = startingRound; round < MAX_MARKDOWN_TOOL_ROUNDS; round += 1) {
		logConvoDebug("chat.toolConversation.round", {
			round: round + 1,
			responseId: response.responseId,
			toolCallNames: response.toolCalls.map((toolCall) => toolCall.name),
			didSaveLinkedDocument: state.didSaveLinkedDocument,
		});

		if (response.toolCalls.length === 0) {
			if (options.requireLinkedDocumentSave && !state.didSaveLinkedDocument) {
				logConvoDebug("chat.toolConversation.missingLinkedDocumentSave", {
					responseId: response.responseId,
					textLength: response.text.length,
				});
				throw new Error("Convo GPT expected to save the linked document, but the model did not call save_markdown_file.");
			}

			return {
				kind: "completion",
				completion: {
					text: response.text,
					sourcesAppendix: `${response.sourcesAppendix}${formatToolConversationAppendix(state)}`,
				},
			};
		}

		const toolOutputs: NonNullable<CreateTurnParams["inputItems"]> = [];
		for (const toolCall of response.toolCalls) {
			if (toolCall.name === FETCH_TOOL_NAME && options.includeFetchTool) {
				requestStatus.notifyToolUse(describeFetchToolCall(toolCall.arguments));
				const result = await executeFetchToolCall(toolCall.arguments);
				logConvoDebug("chat.toolConversation.fetchResult", {
					status: result.status,
					url: "url" in result ? result.url ?? null : null,
					finalUrl: "finalUrl" in result ? result.finalUrl ?? null : null,
					statusCode: "statusCode" in result ? result.statusCode ?? null : null,
				});
				if (result.status === "success" && result.method && result.statusCode && (result.finalUrl || result.url)) {
					state.fetchCalls.push({
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
				logConvoDebug("chat.toolConversation.markdownWriteResult", {
					status: result.status,
					path: "path" in result ? result.path ?? null : null,
					operation: "operation" in result ? result.operation ?? null : null,
					message: "message" in result ? result.message : null,
				});
				if (result.status === "success" && options.requireLinkedDocumentSave) {
					state.didSaveLinkedDocument = true;
				}
				toolOutputs.push(buildFunctionCallOutput(toolCall.call_id, result));
				continue;
			}

			if (toolCall.name === REFERENCED_FILE_TOOL_NAME && options.includeReferencedFileTool && options.referencedFileReadState) {
				requestStatus.notifyToolUse(describeReferencedFileToolCall(toolCall.arguments));
				const result = await executeReferencedFileReadToolCall(app, toolCall.arguments, options.referencedFileReadState);
				logConvoDebug("chat.toolConversation.referencedFileResult", {
					status: result.status,
					path: "path" in result ? result.path ?? null : null,
					truncated: "truncated" in result ? Boolean(result.truncated) : false,
				});
				registerReferencedFileResult(app, options.referencedFileReadState, result);
				if (result.status === "success" && result.path) {
					state.referencedFilesRead.push({
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
		const nextToolChoice =
			options.requireLinkedDocumentSave && !state.didSaveLinkedDocument
				? createForcedFunctionToolChoice(MARKDOWN_FILE_TOOL_NAME)
				: undefined;
		if (options.stopBeforePlainAssistantTurn && nextToolChoice === undefined) {
			return {
				kind: "continue",
				continuation: {
					inputItems: toolOutputs,
					previousResponseId: response.responseId,
					roundsCompleted: round + 1,
					state,
					toolChoice: nextToolChoice,
				},
			};
		}
		logConvoDebug("chat.toolConversation.nextTurn", {
			previousResponseId: response.responseId,
			toolOutputCount: toolOutputs.length,
			nextToolChoice: nextToolChoice ?? null,
		});
		response = await client.createTurn({
			includeFetchTool: options.includeFetchTool,
			includeMarkdownFileTool: options.includeMarkdownFileTool,
			includeReferencedFileTool: options.includeReferencedFileTool,
			inputItems: toolOutputs,
			previousResponseId: response.responseId,
			toolChoice: nextToolChoice,
		});
	}

	logConvoDebug("chat.toolConversation.roundLimitExceeded", {
		linkedDocumentPath: options.linkedDocument?.path ?? null,
		requireLinkedDocumentSave: options.requireLinkedDocumentSave ?? false,
	});
	throw new Error("Convo GPT exceeded the markdown file tool round limit.");
}

function formatToolConversationAppendix(state: ToolConversationState): string {
	return `${formatReferencedFileAppendix(state.referencedFilesRead)}${formatFetchAppendix(state.fetchCalls)}`;
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

async function resolveLinkedDocument(
	app: App,
	file: TFile,
	reference: string | undefined,
	lastUserMessage: string,
	previousUserMessages: string[],
): Promise<LinkedDocumentContext | undefined> {
	if (!reference?.trim()) {
		logConvoDebug("chat.resolveLinkedDocument.skipped", {
			notePath: file.path,
			reason: "missing_reference",
		});
		return undefined;
	}

	logConvoDebug("chat.resolveLinkedDocument.start", {
		notePath: file.path,
		reference,
	});
	const result = await loadLinkedDocumentContext(app, file.path, reference);
	if (!result.success) {
		logConvoDebug("chat.resolveLinkedDocument.failed", {
			notePath: file.path,
			reference,
			error: result.error,
		});
		new Notice(`Convo GPT document mode disabled: ${result.error}`);
		return undefined;
	}

	const shouldAutoWrite =
		detectLinkedDocumentEditIntent(lastUserMessage) ||
		shouldContinueLinkedDocumentDrafting(
			lastUserMessage,
			previousUserMessages.some((message) => detectLinkedDocumentEditIntent(message)),
		);
	logConvoDebug("chat.resolveLinkedDocument.success", {
		notePath: file.path,
		reference,
		resolvedPath: result.context.path,
		exists: result.context.exists,
		shouldAutoWrite,
	});
	return {
		...result.context,
		shouldAutoWrite,
	};
}

function postProcessCompletionText(text: string, linkedDocument?: LinkedDocumentContext): string {
	if (!linkedDocument) {
		return text;
	}

	return linkifyLinkedDocumentMentions(text, linkedDocument.path);
}

async function autoRetitleChatNote(
	app: App,
	file: TFile,
	editor: Editor,
	client: OpenAIClient,
	context: {
		agentBody: string;
		agentFile: TFile | null;
		defaultSystemPrompt: string;
		systemCommands: string[];
	},
): Promise<void> {
	try {
		const document = parseNoteDocument(editor.getValue());
		if (!document.body.trim()) {
			return;
		}

		let agentBody = context.agentBody;
		if (context.agentFile && agentBody.trim()) {
			const enrichedAgent = await injectReferencedNoteContext(app, context.agentFile, agentBody);
			if (enrichedAgent.missingReferences.length > 0) {
				new Notice(`Convo GPT could not resolve agent references: ${enrichedAgent.missingReferences.join(", ")}`);
			}
			agentBody = enrichedAgent.content;
		}

		const enrichedDocument = await injectReferencedNoteContext(app, file, document.body);
		if (enrichedDocument.missingReferences.length > 0) {
			new Notice(`Convo GPT could not resolve: ${enrichedDocument.missingReferences.join(", ")}`);
		}

		const nextBasename = await inferRetitledBasename(client, {
			currentBasename: file.basename,
			noteContent: enrichedDocument.content,
			agentBody,
			defaultSystemPrompt: context.defaultSystemPrompt,
			systemCommands: context.systemCommands,
		});
		const nextPath = buildSiblingMarkdownPath(file.path, nextBasename);
		if (nextPath === file.path) {
			return;
		}

		logConvoDebug("chat.autoRetitle.rename", {
			currentPath: file.path,
			nextPath,
		});
		await app.fileManager.renameFile(file, nextPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logConvoDebug("chat.autoRetitle.failed", {
			notePath: file.path,
			error: message,
		});
		new Notice(`Convo GPT could not auto-retitle the chat: ${message}`);
	}
}

function buildSiblingMarkdownPath(currentPath: string, nextBasename: string): string {
	const slashIndex = currentPath.lastIndexOf("/");
	const folder = slashIndex >= 0 ? currentPath.slice(0, slashIndex + 1) : "";
	return `${folder}${nextBasename}.md`;
}
