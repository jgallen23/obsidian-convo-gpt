import { TFile, type App } from "obsidian";
import { resolveNoteReferences } from "./context-resolver";
import {
	normalizeReferencedFileLookup,
	parseReferencedFileReadRequest,
	type ReferencedFileReadToolResult,
} from "./referenced-file-tool";
const MAX_REFERENCED_FILE_CONTENT_CHARS = 12000;

export interface ReferencedFileReadState {
	aliasMap: Map<string, Set<string>>;
	allowedPaths: Set<string>;
	supportedExtensions: Set<string>;
}

export interface ReferencedFileReadSeed {
	content: string;
	currentFile: TFile | null;
}

export function createReferencedFileReadState(supportedExtensions: string[]): ReferencedFileReadState {
	return {
		aliasMap: new Map(),
		allowedPaths: new Set(),
		supportedExtensions: new Set(supportedExtensions.map((extension) => extension.toLowerCase())),
	};
}

export function addReferencedFileReadSeeds(
	app: App,
	state: ReferencedFileReadState,
	seeds: ReferencedFileReadSeed[],
): string[] {
	const missingReferences: string[] = [];

	for (const seed of seeds) {
		if (!seed.content.trim()) {
			continue;
		}

		const resolved = resolveNoteReferences(app, seed.currentFile, seed.content);
		missingReferences.push(...resolved.missingReferences);
		for (const entry of resolved.references) {
			if (!isSupportedReferencedFile(entry.file, state.supportedExtensions)) {
				continue;
			}

			addAllowedReference(state, entry.reference.path, entry.file.path);
		}
	}

	return missingReferences;
}

export async function executeReferencedFileReadToolCall(
	app: App,
	argumentsJson: string,
	state: ReferencedFileReadState,
): Promise<ReferencedFileReadToolResult> {
	const parsed = parseReferencedFileReadRequest(argumentsJson);
	if (!parsed.success) {
		return {
			status: "validation_error",
			message: parsed.error,
		};
	}

	const reference = normalizeReferencedFileLookup(parsed.data.reference);
	if (!reference) {
		return {
			status: "validation_error",
			message: "A referenced file path is required.",
		};
	}

	const resolvedPath = resolveAllowedReferencedPath(state, reference);
	if (!resolvedPath.success) {
		return {
			status: "validation_error",
			message: resolvedPath.error,
			reference,
		};
	}

	const existing = app.vault.getAbstractFileByPath(resolvedPath.path);
	if (!(existing instanceof TFile)) {
		return {
			status: "validation_error",
			message: `Referenced file not found: ${resolvedPath.path}`,
			reference,
			path: resolvedPath.path,
		};
	}

	if (!isSupportedReferencedFile(existing, state.supportedExtensions)) {
		return {
			status: "validation_error",
			message: `Unsupported referenced file type: ${existing.path}`,
			reference,
			path: existing.path,
		};
	}

	const rawContent = await app.vault.read(existing);
	const truncated = rawContent.length > MAX_REFERENCED_FILE_CONTENT_CHARS;
	const content = truncated ? `${rawContent.slice(0, MAX_REFERENCED_FILE_CONTENT_CHARS)}\n…` : rawContent;

	return {
		status: "success",
		message:
			rawContent.length === 0
				? `Read empty ${existing.extension} file ${existing.path}.`
				: truncated
					? `Read ${existing.extension} file ${existing.path} (truncated).`
					: `Read ${existing.extension} file ${existing.path}.`,
		reference,
		path: existing.path,
		fileType: existing.extension.toLowerCase(),
		content,
		truncated,
	};
}

function addAllowedReference(state: ReferencedFileReadState, rawReference: string, resolvedPath: string): void {
	const normalizedReference = normalizeReferencedFileLookup(rawReference);
	const normalizedResolvedPath = normalizeReferencedFileLookup(resolvedPath);
	if (!normalizedReference || !normalizedResolvedPath) {
		return;
	}

	state.allowedPaths.add(normalizedResolvedPath);
	addAlias(state.aliasMap, normalizedReference, normalizedResolvedPath);
	addAlias(state.aliasMap, normalizedResolvedPath, normalizedResolvedPath);

	const extensionPattern = buildSupportedExtensionPattern(state.supportedExtensions);
	if (!extensionPattern) {
		return;
	}

	const withoutExtension = normalizedResolvedPath.replace(extensionPattern, "");
	if (withoutExtension !== normalizedResolvedPath && withoutExtension.length > 0) {
		addAlias(state.aliasMap, withoutExtension, normalizedResolvedPath);
	}
}

function addAlias(aliasMap: Map<string, Set<string>>, alias: string, resolvedPath: string): void {
	const existing = aliasMap.get(alias);
	if (existing) {
		existing.add(resolvedPath);
		return;
	}

	aliasMap.set(alias, new Set([resolvedPath]));
}

function resolveAllowedReferencedPath(
	state: ReferencedFileReadState,
	reference: string,
): { path: string; success: true } | { error: string; success: false } {
	const aliasMatches = state.aliasMap.get(reference);
	if (aliasMatches && aliasMatches.size > 0) {
		if (aliasMatches.size > 1) {
			return {
				success: false,
				error: `Referenced file is ambiguous: ${reference}. Use one of: ${Array.from(aliasMatches).join(", ")}`,
			};
		}

		return {
			success: true,
			path: Array.from(aliasMatches)[0]!,
		};
	}

	if (state.allowedPaths.has(reference)) {
		return {
			success: true,
			path: reference,
		};
	}

	return {
		success: false,
		error: `Referenced file is not available in this turn: ${reference}`,
	};
}

function isSupportedReferencedFile(file: TFile, supportedExtensions: Set<string>): boolean {
	return supportedExtensions.has(file.extension.toLowerCase());
}

function buildSupportedExtensionPattern(supportedExtensions: Set<string>): RegExp | null {
	if (supportedExtensions.size === 0) {
		return null;
	}

	const escapedExtensions = Array.from(supportedExtensions).map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
}
