import type { App, Editor, MarkdownView } from "obsidian";
import { isConvoAbortError, PluginActiveRequestManager, waitForCancelable, type ActiveRequestManager } from "./active-request-manager";
import { resolveAgent } from "./agent-resolver";
import { resolveChatConfig } from "./chat-config";
import { injectReferencedNoteContext } from "./context-resolver";
import { parseNoteDocument } from "./frontmatter";
import { OpenAIClient } from "./openai-client";
import { formatRequestModelLabel } from "./request-label";
import type { RequestStatusManager } from "./request-status";
import type { RetitleApprover } from "./retitle-note-approval";
import { inferRetitledBasename } from "./title-inference";
import type { PluginSettings } from "./types";

interface RetitleNoteCommandContext {
	app: App;
	approver: RetitleApprover;
	editor: Editor;
	notify: (message: string) => void;
	requestManager?: ActiveRequestManager;
	requestStatus: RequestStatusManager;
	view: MarkdownView;
	settings: PluginSettings;
}

export async function runRetitleNoteCommand(context: RetitleNoteCommandContext): Promise<void> {
	const { app, approver, editor, notify, requestStatus, settings, view } = context;
	const requestManager = context.requestManager ?? new PluginActiveRequestManager();
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

	const activeRequest = requestManager.beginActiveRequest();
	if (!activeRequest) {
		notify("Convo GPT already has an active request. Cancel it before starting another one.");
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
		const requestModelLabel = formatRequestModelLabel(config);
		requestStatus.notifyRequestStart(`Calling ${requestModelLabel}`);
		requestStatus.setCalling(requestModelLabel);

		const client = new OpenAIClient(config);
		const nextBasename = await inferRetitledBasename(client, {
			currentBasename: file.basename,
			noteContent: enrichedDocument.content,
			agentBody,
			defaultSystemPrompt: config.defaultSystemPrompt,
			systemCommands: config.system_commands,
			signal: activeRequest.signal,
		});
		const nextPath = buildSiblingMarkdownPath(file.path, nextBasename);

		if (nextPath === file.path) {
			notify("Convo GPT title already matches the inferred title.");
			return;
		}

		requestStatus.setWaitingForRenameApproval();
		const approved = await waitForCancelable(approver({
			currentBasename: file.basename,
			nextBasename,
		}, activeRequest.signal), activeRequest.signal);
		if (!approved) {
			notify("Convo GPT rename canceled.");
			return;
		}

		await app.fileManager.renameFile(file, nextPath);
		notify(`Convo GPT renamed note to ${nextBasename}`);
	} catch (error) {
		if (isConvoAbortError(error)) {
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		notify(`Convo GPT request failed: ${message}`);
	} finally {
		requestStatus.clear();
		activeRequest.finish();
	}
}

function buildSiblingMarkdownPath(currentPath: string, nextBasename: string): string {
	const slashIndex = currentPath.lastIndexOf("/");
	const folder = slashIndex >= 0 ? currentPath.slice(0, slashIndex + 1) : "";
	return `${folder}${nextBasename}.md`;
}
