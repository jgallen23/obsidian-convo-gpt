import { Modal, Setting, TFile, type App } from "obsidian";
import { throwIfCanceled, waitForCancelable } from "./active-request-manager";
import { DEFAULT_REFERENCED_FILE_MAX_CHARS } from "./constants";
import { resolveNoteReferences } from "./context-resolver";
import {
	normalizeReferencedFileLookup,
	parseReferencedFileReadRequest,
	parseReferencedFileSearchRequest,
	parseReferencedFileSectionReadRequest,
	type ReferencedFileReadToolResult,
	type ReferencedFileSearchMatch,
	type ReferencedFileSearchToolResult,
	type ReferencedFileSectionToolResult,
} from "./referenced-file-tool";

export type OversizedReferencedFileDecision = "cancel" | "full" | "search" | "truncate";

const REFERENCED_FILE_SEARCH_CONTEXT_LINES = 1;
const REFERENCED_FILE_SEARCH_MAX_MATCHES = 5;
const REFERENCED_FILE_SEARCH_MAX_SNIPPET_CHARS = 400;
const REFERENCED_FILE_SECTION_FALLBACK_CONTEXT_LINES = 20;

export interface ReferencedFileReadApprovalRequest {
	maxChars: number;
	path: string;
	sizeChars: number;
}

export type ReferencedFileReadApprover = (
	request: ReferencedFileReadApprovalRequest,
	signal?: AbortSignal,
) => Promise<OversizedReferencedFileDecision>;

export interface ReferencedFileReadStatusCallbacks {
	onWaitingForApproval?: () => void;
}

export interface ReferencedFileReadExecutionOptions {
	signal?: AbortSignal;
	statusCallbacks?: ReferencedFileReadStatusCallbacks;
}

export interface ReferencedFileReadState {
	aliasMap: Map<string, Set<string>>;
	allowedPaths: Set<string>;
	maxContentChars: number;
	oversizedReadDecisions: Map<string, Extract<OversizedReferencedFileDecision, "full" | "search" | "truncate">>;
	oversizedPaths: Set<string>;
	supportedExtensions: Set<string>;
}

interface ReferencedFileLookupFailure {
	status: "validation_error";
	message: string;
	path?: string;
	reference?: string;
}

export interface ReferencedFileReadSeed {
	content: string;
	currentFile: TFile | null;
}

export function createReferencedFileReadState(
	supportedExtensions: string[],
	maxContentChars = DEFAULT_REFERENCED_FILE_MAX_CHARS,
): ReferencedFileReadState {
	return {
		aliasMap: new Map(),
		allowedPaths: new Set(),
		maxContentChars,
		oversizedReadDecisions: new Map(),
		oversizedPaths: new Set(),
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

			addAllowedReference(
				state,
				entry.reference.path,
				entry.file.path,
				isOversizedReferencedFile(entry.file, state.maxContentChars),
			);
		}
	}

	return missingReferences;
}

export async function executeReferencedFileReadToolCall(
	app: App,
	argumentsJson: string,
	state: ReferencedFileReadState,
	approver: ReferencedFileReadApprover = (request, signal) => requestReferencedFileReadApproval(app, request, signal),
	options: ReferencedFileReadExecutionOptions = {},
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

	const resolvedFile = resolveReadableReferencedFile(app, state, reference);
	if (!resolvedFile.success) {
		return resolvedFile.result;
	}
	const existing = resolvedFile.file;

	throwIfCanceled(options.signal);
	const rawContent = await app.vault.read(existing);
	throwIfCanceled(options.signal);
	const oversized = rawContent.length > state.maxContentChars;
	const cachedDecision = oversized ? state.oversizedReadDecisions.get(existing.path) : undefined;
	const decision =
		oversized && cachedDecision === undefined
			? await requestOversizedReferencedFileDecision(approver, options.statusCallbacks, {
					path: existing.path,
					sizeChars: rawContent.length,
					maxChars: state.maxContentChars,
				}, options.signal)
			: cachedDecision ?? "truncate";
	throwIfCanceled(options.signal);

	if (decision === "cancel") {
		return {
			status: "denied",
			message: `User declined to read oversized referenced file ${existing.path}.`,
			reference,
			path: existing.path,
			fileType: existing.extension.toLowerCase(),
		};
	}

	if (decision === "search") {
		if (oversized) {
			state.oversizedReadDecisions.set(existing.path, decision);
		}
		return {
			status: "deferred_to_search",
			message: `User chose search instead of reading oversized referenced file ${existing.path}. Call search_referenced_file for this file.`,
			reference,
			path: existing.path,
			fileType: existing.extension.toLowerCase(),
		};
	}

	if (oversized) {
		state.oversizedReadDecisions.set(existing.path, decision);
	}

	const truncated = oversized && decision === "truncate";
	const content = truncated ? `${rawContent.slice(0, state.maxContentChars)}\n…` : rawContent;

	return {
		status: "success",
		message:
			rawContent.length === 0
				? `Read empty ${existing.extension} file ${existing.path}.`
				: truncated
					? `Read ${existing.extension} file ${existing.path} (truncated).`
					: oversized
						? `Read full ${existing.extension} file ${existing.path} after approval.`
						: `Read ${existing.extension} file ${existing.path}.`,
		reference,
		path: existing.path,
		fileType: existing.extension.toLowerCase(),
		content,
		truncated,
	};
}

export async function executeReferencedFileSearchToolCall(
	app: App,
	argumentsJson: string,
	state: ReferencedFileReadState,
	options: ReferencedFileReadExecutionOptions = {},
): Promise<ReferencedFileSearchToolResult> {
	const parsed = parseReferencedFileSearchRequest(argumentsJson);
	if (!parsed.success) {
		return {
			status: "validation_error",
			message: parsed.error,
		};
	}

	const reference = normalizeReferencedFileLookup(parsed.data.reference);
	const query = parsed.data.query.trim();
	if (!reference) {
		return {
			status: "validation_error",
			message: "A referenced file path is required.",
		};
	}

	if (!query) {
		return {
			status: "validation_error",
			message: "A search query is required.",
			reference,
		};
	}

	const resolvedFile = resolveReadableReferencedFile(app, state, reference);
	if (!resolvedFile.success) {
		return resolvedFile.result;
	}
	const existing = resolvedFile.file;
	throwIfCanceled(options.signal);
	const rawContent = await app.vault.read(existing);
	throwIfCanceled(options.signal);
	const searchResult = searchReferencedFileContent(rawContent, query);

	return {
		status: "success",
		message:
			searchResult.matches.length === 0
				? `No matches found in ${existing.path} for "${query}".`
				: searchResult.truncated
					? `Found ${searchResult.matches.length}+ matches in ${existing.path} for "${query}" (truncated).`
					: `Found ${searchResult.matches.length} match${searchResult.matches.length === 1 ? "" : "es"} in ${existing.path} for "${query}".`,
		matches: searchResult.matches,
		path: existing.path,
		fileType: existing.extension.toLowerCase(),
		query,
		reference,
		truncated: searchResult.truncated,
	};
}

export async function executeReferencedFileSectionToolCall(
	app: App,
	argumentsJson: string,
	state: ReferencedFileReadState,
	options: ReferencedFileReadExecutionOptions = {},
): Promise<ReferencedFileSectionToolResult> {
	const parsed = parseReferencedFileSectionReadRequest(argumentsJson);
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

	const resolvedFile = resolveReadableReferencedFile(app, state, reference);
	if (!resolvedFile.success) {
		return resolvedFile.result;
	}

	const existing = resolvedFile.file;
	throwIfCanceled(options.signal);
	const rawContent = await app.vault.read(existing);
	throwIfCanceled(options.signal);
	const lines = rawContent.split(/\r?\n/);
	if (parsed.data.line > lines.length) {
		return {
			status: "validation_error",
			message: `Line ${parsed.data.line} is outside the file range for ${existing.path}.`,
			path: existing.path,
			reference,
			fileType: existing.extension.toLowerCase(),
		};
	}

	const section = extractReferencedFileSection(
		lines,
		parsed.data.line,
		existing.extension.toLowerCase(),
	);

	return {
		status: "success",
		message:
			section.sectionHeading
				? `Read section "${section.sectionHeading}" from ${existing.path}.`
				: `Read lines ${section.lineStart}-${section.lineEnd} from ${existing.path}.`,
		content: section.content,
		fileType: existing.extension.toLowerCase(),
		lineEnd: section.lineEnd,
		lineStart: section.lineStart,
		path: existing.path,
		reference,
		sectionHeading: section.sectionHeading,
		truncated: false,
	};
}

function addAllowedReference(
	state: ReferencedFileReadState,
	rawReference: string,
	resolvedPath: string,
	isOversized = false,
): void {
	const normalizedReference = normalizeReferencedFileLookup(rawReference);
	const normalizedResolvedPath = normalizeReferencedFileLookup(resolvedPath);
	if (!normalizedReference || !normalizedResolvedPath) {
		return;
	}

	state.allowedPaths.add(normalizedResolvedPath);
	if (isOversized) {
		state.oversizedPaths.add(normalizedResolvedPath);
	}
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

async function requestOversizedReferencedFileDecision(
	approver: ReferencedFileReadApprover,
	statusCallbacks: ReferencedFileReadStatusCallbacks | undefined,
	request: ReferencedFileReadApprovalRequest,
	signal?: AbortSignal,
): Promise<OversizedReferencedFileDecision> {
	statusCallbacks?.onWaitingForApproval?.();
	return waitForCancelable(approver(request, signal), signal);
}

function resolveReadableReferencedFile(
	app: App,
	state: ReferencedFileReadState,
	reference: string,
):
	| { file: TFile; success: true }
	| {
			result: ReferencedFileLookupFailure;
			success: false;
	  } {
	const resolvedPath = resolveAllowedReferencedPath(state, reference);
	if (!resolvedPath.success) {
		return {
			success: false,
			result: {
				status: "validation_error",
				message: resolvedPath.error,
				reference,
			},
		};
	}

	const existing = app.vault.getAbstractFileByPath(resolvedPath.path);
	if (!(existing instanceof TFile)) {
		return {
			success: false,
			result: {
				status: "validation_error",
				message: `Referenced file not found: ${resolvedPath.path}`,
				reference,
				path: resolvedPath.path,
			},
		};
	}

	if (!isSupportedReferencedFile(existing, state.supportedExtensions)) {
		return {
			success: false,
			result: {
				status: "validation_error",
				message: `Unsupported referenced file type: ${existing.path}`,
				reference,
				path: existing.path,
			},
		};
	}

	return {
		success: true,
		file: existing,
	};
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

export function requestReferencedFileReadApproval(
	app: App,
	request: ReferencedFileReadApprovalRequest,
	signal?: AbortSignal,
): Promise<OversizedReferencedFileDecision> {
	if (signal?.aborted) {
		return Promise.resolve("cancel");
	}

	return new Promise((resolve) => {
		const modal = new OversizedReferencedFileReadApprovalModal(app, request, (decision) => {
			signal?.removeEventListener("abort", abort);
			resolve(decision);
		});
		const abort = () => {
			modal.close();
		};
		signal?.addEventListener("abort", abort, { once: true });
		modal.open();
	});
}

function isSupportedReferencedFile(file: TFile, supportedExtensions: Set<string>): boolean {
	return supportedExtensions.has(file.extension.toLowerCase());
}

function isOversizedReferencedFile(file: TFile, maxContentChars: number): boolean {
	return typeof file.stat?.size === "number" && file.stat.size > maxContentChars;
}

function buildSupportedExtensionPattern(supportedExtensions: Set<string>): RegExp | null {
	if (supportedExtensions.size === 0) {
		return null;
	}

	const escapedExtensions = Array.from(supportedExtensions).map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
}

class OversizedReferencedFileReadApprovalModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly request: ReferencedFileReadApprovalRequest,
		private readonly resolveDecision: (decision: OversizedReferencedFileDecision) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Large referenced file" });
		contentEl.createEl("p", {
			text: `${this.request.path} is ${formatCount(this.request.sizeChars)} characters, which exceeds the auto-read limit of ${formatCount(this.request.maxChars)} characters.`,
		});
		contentEl.createEl("p", {
			text: "Choose whether to send a truncated preview or the full file to the model for this turn.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText(`Read first ${formatCount(this.request.maxChars)} chars`).setCta().onClick(() => {
					this.settle("truncate");
				}),
			)
			.addButton((button) =>
				button.setButtonText("Send full file").onClick(() => {
					this.settle("full");
				}),
			)
			.addButton((button) =>
				button.setButtonText("Search within file").onClick(() => {
					this.settle("search");
				}),
			)
			.addExtraButton((button) =>
				button.setIcon("cross").setTooltip("Cancel").onClick(() => {
					this.settle("cancel");
				}),
			);
	}

	override onClose(): void {
		if (!this.settled) {
			this.resolveDecision("cancel");
		}
	}

	private settle(decision: OversizedReferencedFileDecision): void {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.resolveDecision(decision);
		this.close();
	}
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

function searchReferencedFileContent(
	content: string,
	query: string,
): { matches: ReferencedFileSearchMatch[]; truncated: boolean } {
	const normalizedQuery = query.toLocaleLowerCase();
	const lines = content.split(/\r?\n/);
	const matches: ReferencedFileSearchMatch[] = [];
	let totalMatches = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.toLocaleLowerCase().includes(normalizedQuery)) {
			continue;
		}

		totalMatches += 1;
		if (matches.length >= REFERENCED_FILE_SEARCH_MAX_MATCHES) {
			continue;
		}

		const lineStartIndex = Math.max(0, index - REFERENCED_FILE_SEARCH_CONTEXT_LINES);
		const lineEndIndex = Math.min(lines.length - 1, index + REFERENCED_FILE_SEARCH_CONTEXT_LINES);
		const snippet = lines
			.slice(lineStartIndex, lineEndIndex + 1)
			.join("\n")
			.slice(0, REFERENCED_FILE_SEARCH_MAX_SNIPPET_CHARS);

		matches.push({
			lineStart: lineStartIndex + 1,
			lineEnd: lineEndIndex + 1,
			snippet:
				snippet.length <
				lines.slice(lineStartIndex, lineEndIndex + 1).join("\n").length
					? `${snippet}…`
					: snippet,
		});
	}

	return {
		matches,
		truncated: totalMatches > matches.length,
	};
}

function extractReferencedFileSection(
	lines: string[],
	targetLine: number,
	fileExtension: string,
): { content: string; lineEnd: number; lineStart: number; sectionHeading?: string } {
	if (fileExtension === "md") {
		const markdownSection = extractMarkdownSection(lines, targetLine);
		if (markdownSection) {
			return markdownSection;
		}
	}

	return extractLineWindow(lines, targetLine);
}

function extractMarkdownSection(
	lines: string[],
	targetLine: number,
): { content: string; lineEnd: number; lineStart: number; sectionHeading?: string } | null {
	const headings = collectMarkdownHeadings(lines);
	const targetIndex = targetLine - 1;
	let sectionHeading = headings
		.filter((heading) => heading.lineIndex <= targetIndex)
		.at(-1);

	if (!sectionHeading) {
		return extractPreambleBlock(lines, targetLine);
	}

	const nextHeading = headings.find(
		(heading) => heading.lineIndex > sectionHeading.lineIndex && heading.level <= sectionHeading.level,
	);
	const lineStart = sectionHeading.lineIndex + 1;
	const lineEnd = nextHeading ? nextHeading.lineIndex : lines.length;

	return {
		content: lines.slice(lineStart - 1, lineEnd).join("\n"),
		lineStart,
		lineEnd,
		sectionHeading: sectionHeading.text,
	};
}

function extractPreambleBlock(
	lines: string[],
	targetLine: number,
): { content: string; lineEnd: number; lineStart: number } | null {
	const targetIndex = targetLine - 1;
	if (targetIndex < 0 || targetIndex >= lines.length) {
		return null;
	}

	let startIndex = targetIndex;
	let endIndex = targetIndex;

	while (startIndex > 0 && lines[startIndex - 1]?.trim() !== "") {
		startIndex -= 1;
	}

	while (endIndex < lines.length - 1 && lines[endIndex + 1]?.trim() !== "") {
		endIndex += 1;
	}

	return {
		content: lines.slice(startIndex, endIndex + 1).join("\n"),
		lineStart: startIndex + 1,
		lineEnd: endIndex + 1,
	};
}

function collectMarkdownHeadings(lines: string[]): Array<{ level: number; lineIndex: number; text: string }> {
	const headings: Array<{ level: number; lineIndex: number; text: string }> = [];
	let activeFence: "`" | "~" | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const fenceMatch = line.match(/^([`~]{3,})/);
		if (fenceMatch) {
			const fenceChar = fenceMatch[1]?.[0];
			if (fenceChar === "`" || fenceChar === "~") {
				if (activeFence === fenceChar) {
					activeFence = null;
				} else if (activeFence === null) {
					activeFence = fenceChar;
				}
			}
		}

		if (activeFence !== null) {
			continue;
		}

		const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!headingMatch) {
			continue;
		}

		headings.push({
			level: headingMatch[1]!.length,
			lineIndex: index,
			text: headingMatch[2]!.trim(),
		});
	}

	return headings;
}

function extractLineWindow(
	lines: string[],
	targetLine: number,
): { content: string; lineEnd: number; lineStart: number } {
	const targetIndex = targetLine - 1;
	const startIndex = Math.max(0, targetIndex - REFERENCED_FILE_SECTION_FALLBACK_CONTEXT_LINES);
	const endIndex = Math.min(lines.length - 1, targetIndex + REFERENCED_FILE_SECTION_FALLBACK_CONTEXT_LINES);

	return {
		content: lines.slice(startIndex, endIndex + 1).join("\n"),
		lineStart: startIndex + 1,
		lineEnd: endIndex + 1,
	};
}
