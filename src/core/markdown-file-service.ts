import { Modal, Setting, TFile, TFolder, type App } from "obsidian";
import {
	buildMarkdownWritePreview,
	parseMarkdownWriteRequest,
	resolveMarkdownVaultPath,
	type MarkdownWriteRequest,
	type MarkdownWriteToolResult,
	type MarkdownWriteOperation,
} from "./markdown-file-tool";

export interface MarkdownWriteApprovalRequest {
	path: string;
	operation: MarkdownWriteOperation;
	exists: boolean;
	reason: string;
	preview: string;
}

export type MarkdownWriteApprover = (request: MarkdownWriteApprovalRequest) => Promise<boolean>;

export interface MarkdownWriteStatusCallbacks {
	onSaving?: (path: string) => void;
	onWaitingForApproval?: () => void;
}

export interface MarkdownWriteExecutionOptions {
	statusCallbacks?: MarkdownWriteStatusCallbacks;
	trustedPaths?: ReadonlySet<string>;
}

export async function executeMarkdownWriteToolCall(
	app: App,
	argumentsJson: string,
	approver: MarkdownWriteApprover = (request) => requestMarkdownWriteApproval(app, request),
	options: MarkdownWriteExecutionOptions = {},
): Promise<MarkdownWriteToolResult> {
	const parsed = parseMarkdownWriteRequest(argumentsJson);
	if (!parsed.success) {
		return {
			status: "validation_error",
			message: parsed.error,
		};
	}

	return executeMarkdownWriteRequest(app, parsed.data, approver, options);
}

export async function executeMarkdownWriteRequest(
	app: App,
	request: MarkdownWriteRequest,
	approver: MarkdownWriteApprover,
	options: MarkdownWriteExecutionOptions = {},
): Promise<MarkdownWriteToolResult> {
	const statusCallbacks = options.statusCallbacks ?? {};
	const resolved = resolveMarkdownWriteTargetPath(app, request.path);
	if (!resolved.success) {
		return {
			status: "validation_error",
			message: resolved.error,
			operation: request.operation,
		};
	}

	const existing = app.vault.getAbstractFileByPath(resolved.path);
	if (existing && !(existing instanceof TFile)) {
		return {
			status: "validation_error",
			message: `Target path is not a markdown file: ${resolved.path}`,
			path: resolved.path,
			operation: request.operation,
		};
	}

	if (request.operation === "edit") {
		if (!(existing instanceof TFile)) {
			return {
				status: "validation_error",
				message: `Cannot edit missing markdown file: ${resolved.path}`,
				path: resolved.path,
				operation: request.operation,
			};
		}

		return {
			status: "edit_context",
			message:
				"Current markdown file content returned. Review it and call save_markdown_file again with operation replace or append to apply the change.",
			path: resolved.path,
			operation: request.operation,
			currentContent: await app.vault.read(existing),
		};
	}

	const approval = options.trustedPaths?.has(resolved.path)
		? true
		: await requestApproval(approver, statusCallbacks, {
				path: resolved.path,
				operation: request.operation,
				exists: existing instanceof TFile,
				reason: request.reason?.trim() || "Model requested a markdown file change.",
				preview: buildMarkdownWritePreview(request.content),
			});

	if (!approval) {
		return {
			status: "denied",
			message: `User denied ${request.operation} for ${resolved.path}.`,
			path: resolved.path,
			operation: request.operation,
		};
	}

	switch (request.operation) {
		case "create":
			statusCallbacks.onSaving?.(resolved.path);
			if (existing instanceof TFile) {
				return {
					status: "validation_error",
					message: `Markdown file already exists: ${resolved.path}`,
					path: resolved.path,
					operation: request.operation,
				};
			}
			await ensureParentFolders(app, resolved.path);
			await app.vault.create(resolved.path, request.content ?? "");
			return {
				status: "success",
				message: `Created markdown file ${resolved.path}.`,
				path: resolved.path,
				operation: request.operation,
			};
		case "replace":
			statusCallbacks.onSaving?.(resolved.path);
			if (!(existing instanceof TFile)) {
				return {
					status: "validation_error",
					message: `Cannot replace missing markdown file: ${resolved.path}`,
					path: resolved.path,
					operation: request.operation,
				};
			}
			await app.vault.modify(existing, request.content ?? "");
			return {
				status: "success",
				message: `Replaced markdown file ${resolved.path}.`,
				path: resolved.path,
				operation: request.operation,
			};
		case "append":
			statusCallbacks.onSaving?.(resolved.path);
			if (!(existing instanceof TFile)) {
				return {
					status: "validation_error",
					message: `Cannot append to missing markdown file: ${resolved.path}`,
					path: resolved.path,
					operation: request.operation,
				};
			}
			await app.vault.process(existing, (content) => `${content}${request.content ?? ""}`);
			return {
				status: "success",
				message: `Appended markdown content to ${resolved.path}.`,
				path: resolved.path,
				operation: request.operation,
			};
		default:
			return {
				status: "validation_error",
				message: `Unsupported markdown write operation: ${String(request.operation)}`,
				path: resolved.path,
				operation: request.operation,
			};
	}
}

export function resolveMarkdownWriteTargetPath(
	app: App,
	rawPath: string,
	currentPath = "",
): { path: string; success: true } | { error: string; success: false } {
	const resolved = resolveMarkdownVaultPath(rawPath);
	if (!resolved.success) {
		return resolved;
	}

	const explicitReference = extractExplicitMarkdownReference(rawPath);
	if (!explicitReference) {
		return resolved;
	}

	const linkedFile = app.metadataCache.getFirstLinkpathDest?.(explicitReference, currentPath);
	if (linkedFile instanceof TFile && linkedFile.extension.toLowerCase() === "md") {
		return {
			success: true,
			path: linkedFile.path,
		};
	}

	return resolved;
}

async function requestApproval(
	approver: MarkdownWriteApprover,
	statusCallbacks: MarkdownWriteStatusCallbacks,
	request: MarkdownWriteApprovalRequest,
): Promise<boolean> {
	statusCallbacks.onWaitingForApproval?.();
	return approver(request);
}

export function requestMarkdownWriteApproval(app: App, request: MarkdownWriteApprovalRequest): Promise<boolean> {
	return new Promise((resolve) => {
		new MarkdownWriteApprovalModal(app, request, resolve).open();
	});
}

async function ensureParentFolders(app: App, path: string): Promise<void> {
	const segments = path.split("/");
	segments.pop();

	let currentPath = "";
	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const existing = app.vault.getAbstractFileByPath(currentPath);
		if (!existing) {
			await app.vault.createFolder(currentPath);
			continue;
		}

		if (!(existing instanceof TFolder)) {
			throw new Error(`Cannot create folder "${currentPath}" because a file already exists at that path.`);
		}
	}
}

class MarkdownWriteApprovalModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly request: MarkdownWriteApprovalRequest,
		private readonly resolveApproval: (approved: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Approve markdown file write" });
		contentEl.createEl("p", {
			text: `${capitalize(this.request.operation)} ${this.request.exists ? "existing" : "new"} file: ${this.request.path}`,
		});
		contentEl.createEl("p", { text: this.request.reason });
		contentEl.createEl("pre", { text: this.request.preview });

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Approve").setCta().onClick(() => {
					this.settle(true);
				}),
			)
			.addExtraButton((button) =>
				button.setIcon("cross").setTooltip("Deny").onClick(() => {
					this.settle(false);
				}),
			);
	}

	override onClose(): void {
		if (!this.settled) {
			this.resolveApproval(false);
		}
	}

	private settle(approved: boolean): void {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.resolveApproval(approved);
		this.close();
	}
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function extractExplicitMarkdownReference(rawPath: string): string | null {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return null;
	}

	const wikiMatch = trimmed.match(/^\[\[([^[\]]+)\]\]$/);
	if (wikiMatch) {
		return normalizeReferenceTarget(wikiMatch[1] ?? "");
	}

	const markdownMatch = trimmed.match(/^\[[^\]]+\]\(([^)]+)\)$/);
	if (markdownMatch) {
		return normalizeReferenceTarget(markdownMatch[1] ?? "");
	}

	return null;
}

function normalizeReferenceTarget(rawReference: string): string {
	return rawReference.split("|")[0]?.split("#")[0]?.trim() ?? "";
}
