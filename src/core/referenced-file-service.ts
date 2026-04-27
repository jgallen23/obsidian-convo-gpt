import { Modal, Setting, TFile, type App } from "obsidian";
import { DEFAULT_REFERENCED_FILE_MAX_CHARS } from "./constants";
import { resolveNoteReferences } from "./context-resolver";
import {
	normalizeReferencedFileLookup,
	parseReferencedFileReadRequest,
	type ReferencedFileReadToolResult,
} from "./referenced-file-tool";

export type OversizedReferencedFileDecision = "cancel" | "full" | "truncate";

export interface ReferencedFileReadApprovalRequest {
	maxChars: number;
	path: string;
	sizeChars: number;
}

export type ReferencedFileReadApprover = (request: ReferencedFileReadApprovalRequest) => Promise<OversizedReferencedFileDecision>;

export interface ReferencedFileReadStatusCallbacks {
	onWaitingForApproval?: () => void;
}

export interface ReferencedFileReadExecutionOptions {
	statusCallbacks?: ReferencedFileReadStatusCallbacks;
}

export interface ReferencedFileReadState {
	aliasMap: Map<string, Set<string>>;
	allowedPaths: Set<string>;
	maxContentChars: number;
	oversizedReadDecisions: Map<string, Extract<OversizedReferencedFileDecision, "full" | "truncate">>;
	supportedExtensions: Set<string>;
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
	approver: ReferencedFileReadApprover = (request) => requestReferencedFileReadApproval(app, request),
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
	const oversized = rawContent.length > state.maxContentChars;
	const cachedDecision = oversized ? state.oversizedReadDecisions.get(existing.path) : undefined;
	const decision =
		oversized && cachedDecision === undefined
			? await requestOversizedReferencedFileDecision(approver, options.statusCallbacks, {
					path: existing.path,
					sizeChars: rawContent.length,
					maxChars: state.maxContentChars,
				})
			: cachedDecision ?? "truncate";

	if (decision === "cancel") {
		return {
			status: "denied",
			message: `User declined to read oversized referenced file ${existing.path}.`,
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

async function requestOversizedReferencedFileDecision(
	approver: ReferencedFileReadApprover,
	statusCallbacks: ReferencedFileReadStatusCallbacks | undefined,
	request: ReferencedFileReadApprovalRequest,
): Promise<OversizedReferencedFileDecision> {
	statusCallbacks?.onWaitingForApproval?.();
	return approver(request);
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
): Promise<OversizedReferencedFileDecision> {
	return new Promise((resolve) => {
		new OversizedReferencedFileReadApprovalModal(app, request, resolve).open();
	});
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
