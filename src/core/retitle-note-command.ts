import type { App, Editor, MarkdownView } from "obsidian";
import { resolveAgent } from "./agent-resolver";
import { resolveChatConfig } from "./chat-config";
import { injectReferencedNoteContext } from "./context-resolver";
import { parseNoteDocument } from "./frontmatter";
import { buildRetitledBasename } from "./note-title";
import { OpenAIClient } from "./openai-client";
import type { RequestStatusManager } from "./request-status";
import type { RetitleApprover } from "./retitle-note-approval";
import type { ChatMessage, PluginSettings } from "./types";

interface RetitleNoteCommandContext {
	app: App;
	approver: RetitleApprover;
	editor: Editor;
	notify: (message: string) => void;
	requestStatus: RequestStatusManager;
	view: MarkdownView;
	settings: PluginSettings;
}

export async function runRetitleNoteCommand(context: RetitleNoteCommandContext): Promise<void> {
	const { app, approver, editor, notify, requestStatus, settings, view } = context;
	const file = view.file;

	if (!file) {
		notify("Convo GPT requires an open note.");
		return;
	}

	const document = parseNoteDocument(editor.getValue());
	if (!document.body.trim()) {
		notify("Convo GPT needs note content to summarize.");
		return;
	}

	const agent = await resolveAgent(app, settings, document.overrides.agent);
	const config = resolveChatConfig(settings, agent?.frontmatter, document.overrides);
	if (!config.apiKey) {
		notify("Convo GPT is missing an OpenAI API key.");
		return;
	}

	let agentBody = agent?.body ?? "";
	if (agent && agentBody.trim()) {
		const enrichedAgent = await injectReferencedNoteContext(app, agent.file, agentBody);
		if (enrichedAgent.missingReferences.length > 0) {
			notify(`Convo GPT could not resolve agent references: ${enrichedAgent.missingReferences.join(", ")}`);
		}
		agentBody = enrichedAgent.content;
	}

	const enrichedDocument = await injectReferencedNoteContext(app, file, document.body);
	if (enrichedDocument.missingReferences.length > 0) {
		notify(`Convo GPT could not resolve: ${enrichedDocument.missingReferences.join(", ")}`);
	}

	try {
		requestStatus.notifyRequestStart(`Calling ${config.model}`);
		requestStatus.setCalling(config.model);

		const client = new OpenAIClient(config);
		const completion = await client.create(buildTitleMessages(enrichedDocument.content, agentBody, config.defaultSystemPrompt, config.system_commands));
		const nextBasename = buildRetitledBasename(file.basename, completion.text);
		const nextPath = buildSiblingMarkdownPath(file.path, nextBasename);

		if (nextPath === file.path) {
			notify("Convo GPT title already matches the inferred title.");
			return;
		}

		requestStatus.setWaitingForRenameApproval();
		const approved = await approver({
			currentBasename: file.basename,
			nextBasename,
		});
		if (!approved) {
			notify("Convo GPT rename canceled.");
			return;
		}

		await app.fileManager.renameFile(file, nextPath);
		notify(`Convo GPT renamed note to ${nextBasename}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(`Convo GPT request failed: ${message}`);
	} finally {
		requestStatus.clear();
	}
}

function buildTitleMessages(
	noteContent: string,
	agentBody: string,
	defaultSystemPrompt: string,
	systemCommands: string[],
): ChatMessage[] {
	const messages: ChatMessage[] = [];

	if (defaultSystemPrompt.trim()) {
		messages.push({
			role: "system",
			content: defaultSystemPrompt.trim(),
		});
	}

	if (agentBody.trim()) {
		messages.push({
			role: "system",
			content: agentBody.trim(),
		});
	}

	for (const command of systemCommands) {
		if (command.trim()) {
			messages.push({
				role: "system",
				content: command.trim(),
			});
		}
	}

	messages.push({
		role: "system",
		content:
			"Return only a concise note title suitable for an Obsidian filename. Do not include a date prefix, file extension, quotes, markdown, labels, or explanation.",
	});
	messages.push({
		role: "user",
		content: `Infer a short, descriptive title for this note.\n\n<note>\n${noteContent.trim()}\n</note>`,
	});

	return messages;
}

function buildSiblingMarkdownPath(currentPath: string, nextBasename: string): string {
	const slashIndex = currentPath.lastIndexOf("/");
	const folder = slashIndex >= 0 ? currentPath.slice(0, slashIndex + 1) : "";
	return `${folder}${nextBasename}.md`;
}
