import type { App } from "obsidian";
import { TFile } from "obsidian";
import { resolveMarkdownWriteTargetPath } from "./markdown-file-service";
import { formatMarkdownWikiLink } from "./markdown-file-tool";
import { inferDocumentBasenameFromRequest } from "./note-title";

export interface LinkedDocumentContext {
	content: string;
	exists: boolean;
	path: string;
	shouldAutoWrite: boolean;
}

const DOCUMENT_EDIT_INTENT_REGEX =
	/\b(create|write|compose|edit|rewrite|revise|update|change|modify|rework|redraft|polish|tighten|expand|shorten|lengthen|trim|condense|simplify|clarify|fix|improve|append|add|remove|delete|insert|cut)\b/i;
const DOCUMENT_MAKE_INTENT_REGEX =
	/\bmake (?:it|this|the (?:document|draft|proposal|email|article|case study))(?:\s+\w+){1,4}\b/i;
const DOCUMENT_DRAFT_VERB_REGEX =
	/\bdraft (?:(?:a|an|the|this|that|my|our)\s+)?(?:document|proposal|email|article|case study|story|memo|plan|outline)\b/i;
const DOCUMENT_READ_ONLY_INTENT_REGEX =
	/\b(summarize|summary|review|discuss|analy[sz]e|critique|feedback|explain|describe|compare|what\b|why\b|how\b)\b/i;

export function detectLinkedDocumentEditIntent(message: string): boolean {
	return (
		DOCUMENT_EDIT_INTENT_REGEX.test(message) ||
		DOCUMENT_MAKE_INTENT_REGEX.test(message) ||
		DOCUMENT_DRAFT_VERB_REGEX.test(message)
	);
}

export function shouldContinueLinkedDocumentDrafting(message: string, historyHasEditIntent: boolean): boolean {
	if (!historyHasEditIntent) {
		return false;
	}

	if (DOCUMENT_READ_ONLY_INTENT_REGEX.test(message)) {
		return false;
	}

	const trimmed = message.trim();
	if (!trimmed) {
		return false;
	}

	const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
	return trimmed.length <= 80 && wordCount <= 12;
}

export function buildLinkedDocumentSystemPrompt(context: LinkedDocumentContext): string {
	const stateLine = context.exists
		? `The linked document currently exists at ${context.path}.`
		: `The linked document target is ${context.path} and it does not exist yet.`;
	const content = context.content.trim() ? context.content : "(empty document)";

	return [
		"Linked document mode is active for this chat note.",
		stateLine,
		"Treat the linked document content below as the latest source of truth for the document.",
		"If the user's latest request is about reviewing, discussing, or summarizing the document, do not write to the file.",
		"If the user's latest request is asking for document changes, update only the linked document file and keep the chat response focused on what changed.",
		"If the user asks you to create, draft, write, compose, or update content in the document, do not stop at a draft-in-chat response. Save the content to the linked document in the same turn.",
		"Do not tell the user to paste content into the document yourself when linked document mode is active.",
		"",
		`<linked_document path="${context.path}">`,
		content,
		"</linked_document>",
	].join("\n");
}

export function buildLinkedDocumentToolPolicy(context: LinkedDocumentContext): string {
	const operation = context.exists ? "replace" : "create";
	return [
		"Linked document save policy:",
		`- The default document write target for this chat note is ${context.path}.`,
		`- When editing the linked document, call save_markdown_file with path ${context.path} and operation ${operation}.`,
		"- For create, write, draft, compose, or update requests, you must call save_markdown_file before giving the final answer.",
		"- Provide the full updated document content when saving the linked document.",
		"- Do not ask the user to confirm writes to the linked document.",
		"- Do not write to any other markdown file unless the user explicitly names that other target.",
	].join("\n");
}

export async function loadLinkedDocumentContext(
	app: App,
	notePath: string,
	reference: string,
): Promise<{ context: LinkedDocumentContext; success: true } | { error: string; success: false }> {
	const resolved = resolveMarkdownWriteTargetPath(app, reference, notePath);
	if (!resolved.success) {
		return resolved;
	}

	const existing = app.vault.getAbstractFileByPath(resolved.path);
	if (existing && !(existing instanceof TFile)) {
		return {
			success: false,
			error: `Linked document path is not a markdown file: ${resolved.path}`,
		};
	}

	return {
		success: true,
		context: {
			content: existing instanceof TFile ? await app.vault.read(existing) : "",
			exists: existing instanceof TFile,
			path: resolved.path,
			shouldAutoWrite: false,
		},
	};
}

export function deriveLinkedDocumentReferenceFromChatPath(notePath: string, requestMessage: string): string | null {
	const match = notePath.match(/^(.*\/)?(.+?) chat\.md$/i);
	if (!match) {
		return null;
	}

	const folder = match[1] ?? "";
	const fallbackBasename = match[2]?.trim();
	if (!fallbackBasename) {
		return null;
	}

	const basename = inferDocumentBasenameFromRequest(requestMessage, fallbackBasename);
	if (!basename) {
		return null;
	}

	return formatMarkdownWikiLink(`${folder}${basename}.md`);
}

export function linkifyLinkedDocumentMentions(text: string, documentPath: string): string {
	const wikiLink = formatMarkdownWikiLink(documentPath);
	const escapedPath = escapeRegExp(documentPath);
	const escapedWiki = escapeRegExp(wikiLink);
	const escapedBasename = escapeRegExp(documentPath.split("/").at(-1) ?? documentPath);

	return text
		.replace(new RegExp(`\\*\\*\\\`${escapedPath}\\\`\\*\\*`, "g"), wikiLink)
		.replace(new RegExp(`\\\`${escapedPath}\\\``, "g"), wikiLink)
		.replace(new RegExp(`\\b${escapedPath}\\b`, "g"), wikiLink)
		.replace(new RegExp(`\\*\\*\\\`${escapedBasename}\\\`\\*\\*`, "g"), wikiLink)
		.replace(new RegExp(`\\\`${escapedBasename}\\\``, "g"), wikiLink)
		.replace(new RegExp(`(?<!\\[\\[)${escapedWiki}(?!\\]\\])`, "g"), wikiLink);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
