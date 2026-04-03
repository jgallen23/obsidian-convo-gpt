import type { App, TFile } from "obsidian";
import { stripFrontmatter } from "./frontmatter";

export interface NoteReference {
	label: string;
	linkText: string;
	path: string;
}

export interface ResolvedNoteReference {
	file: TFile;
	reference: NoteReference;
}

const WIKI_LINK_REGEX = /\[\[([^[\]]+)\]\]/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;
const URI_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;

export function findNoteReferences(message: string): NoteReference[] {
	const results: NoteReference[] = [];
	const seen = new Set<string>();

	for (const match of message.matchAll(WIKI_LINK_REGEX)) {
		const rawPath = match[1]?.split("|")[0]?.trim();
		if (!rawPath || shouldIgnorePath(rawPath) || seen.has(rawPath)) {
			continue;
		}

		results.push({
			label: rawPath,
			linkText: match[0],
			path: rawPath,
		});
		seen.add(rawPath);
	}

	for (const match of message.matchAll(MARKDOWN_LINK_REGEX)) {
		const path = match[2]?.trim();
		if (!path || shouldIgnorePath(path) || seen.has(path)) {
			continue;
		}

		results.push({
			label: match[1] || path,
			linkText: match[0],
			path,
		});
		seen.add(path);
	}

	return results;
}

export async function injectReferencedNoteContext(
	app: App,
	currentFile: TFile | null,
	message: string,
): Promise<{ content: string; missingReferences: string[] }> {
	const { missingReferences, references } = resolveNoteReferences(app, currentFile, message);
	if (references.length === 0) {
		return { content: message, missingReferences: [] };
	}

	const blocks: string[] = [];
	const seenPaths = new Set<string>();

	for (const { file, reference } of references) {
		if (seenPaths.has(file.path)) {
			continue;
		}

		const rawContent = await app.vault.read(file);
		const content = stripFrontmatter(rawContent).trim();
		seenPaths.add(file.path);
		blocks.push(
			[
				`Referenced note: ${reference.linkText}`,
				`Path: ${file.path}`,
				"",
				content || "_Empty note_",
			].join("\n"),
		);
	}

	if (blocks.length === 0) {
		return { content: message, missingReferences };
	}

	return {
		content: [message.trim(), "", "---", "Referenced note context", "", blocks.join("\n\n---\n\n")].join("\n"),
		missingReferences,
	};
}

export function resolveNoteReferences(
	app: App,
	currentFile: TFile | null,
	message: string,
): { references: ResolvedNoteReference[]; missingReferences: string[] } {
	const references = findNoteReferences(message);
	if (references.length === 0) {
		return {
			references: [],
			missingReferences: [],
		};
	}

	const resolved: ResolvedNoteReference[] = [];
	const missingReferences: string[] = [];
	const seen = new Set<string>();

	for (const reference of references) {
		const file = app.metadataCache.getFirstLinkpathDest(reference.path, currentFile?.path ?? "");
		if (!file) {
			missingReferences.push(reference.path);
			continue;
		}

		if (currentFile && file.path === currentFile.path) {
			continue;
		}

		const key = `${reference.path}::${file.path}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		resolved.push({
			file,
			reference,
		});
	}

	return {
		references: resolved,
		missingReferences,
	};
}

function shouldIgnorePath(path: string): boolean {
	return path.includes("#") || URI_SCHEME_REGEX.test(path);
}
