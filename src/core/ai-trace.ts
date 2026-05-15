import { TFile, TFolder, type App } from "obsidian";
import { formatMarkdownWikiLink } from "./markdown-file-tool";
import { resolveMarkdownWriteTargetPath } from "./markdown-file-service";
import type { ReasoningEffort } from "./types";

export type AITraceOutcome = "canceled" | "failed" | "success";

interface AITraceEntry {
	data?: unknown;
	heading: string;
	kind: "error" | "event" | "mcp" | "request" | "response" | "tool_call" | "tool_result";
}

export interface AITraceCollectorOptions {
	aiLogPath: string;
	maxTokens: number;
	model: string;
	notePath: string;
	operation: "chat" | "retitle";
	reasoningEffort: ReasoningEffort;
	stream: boolean;
	temperature?: number;
}

export class AITraceCollector {
	private readonly entries: AITraceEntry[] = [];
	private errorMessage: string | null = null;
	private outcome: AITraceOutcome | null = null;
	private readonly startedAt = new Date();

	constructor(private readonly options: AITraceCollectorOptions) {}

	get aiLogPath(): string {
		return this.options.aiLogPath;
	}

	get notePath(): string {
		return this.options.notePath;
	}

	get currentOutcome(): AITraceOutcome | null {
		return this.outcome;
	}

	recordError(heading: string, error: unknown): void {
		this.entries.push({
			kind: "error",
			heading,
			data: normalizeErrorForTrace(error),
		});
	}

	recordEvent(heading: string, data?: unknown): void {
		this.entries.push({
			kind: "event",
			heading,
			data,
		});
	}

	recordMcpActivity(heading: string, data?: unknown): void {
		this.entries.push({
			kind: "mcp",
			heading,
			data,
		});
	}

	recordRequest(heading: string, request: unknown): void {
		this.entries.push({
			kind: "request",
			heading,
			data: request,
		});
	}

	recordResponse(heading: string, response: unknown): void {
		this.entries.push({
			kind: "response",
			heading,
			data: response,
		});
	}

	recordToolCall(toolName: string, data: unknown): void {
		this.entries.push({
			kind: "tool_call",
			heading: `Tool call: ${toolName}`,
			data,
		});
	}

	recordToolResult(toolName: string, data: unknown): void {
		this.entries.push({
			kind: "tool_result",
			heading: `Tool result: ${toolName}`,
			data,
		});
	}

	setOutcome(outcome: AITraceOutcome, errorMessage?: string): void {
		this.outcome = outcome;
		if (errorMessage) {
			this.errorMessage = errorMessage;
		}
	}

	renderMarkdown(): string {
		const finishedAt = new Date();
		const startedAtLabel = this.startedAt.toLocaleString("en-US", { timeZoneName: "short" });
		const finishedAtLabel = finishedAt.toLocaleString("en-US", { timeZoneName: "short" });
		const durationMs = finishedAt.getTime() - this.startedAt.getTime();
		const lines = [
			`## ${startedAtLabel} - ${this.options.operation} - ${this.outcome ?? "unknown"}`,
			"",
			`- Source note: ${formatMarkdownWikiLink(this.options.notePath)}`,
			`- Model: \`${this.options.model}\``,
			`- Reasoning: \`${this.options.reasoningEffort}\``,
			`- Temperature: ${this.options.temperature ?? "(omitted)"}`,
			`- Max tokens: \`${this.options.maxTokens}\``,
			`- Stream: \`${this.options.stream}\``,
			`- Started: ${startedAtLabel}`,
			`- Finished: ${finishedAtLabel}`,
			`- Duration ms: \`${durationMs}\``,
			`- Outcome: \`${this.outcome ?? "unknown"}\``,
		];

		if (this.errorMessage) {
			lines.push(`- Error: ${this.errorMessage}`);
		}

		for (const [index, entry] of this.entries.entries()) {
			lines.push("", `### ${index + 1}. ${entry.heading}`);
			if (entry.data !== undefined) {
				lines.push("", formatTraceCodeBlock(entry.data));
			}
		}

		return lines.join("\n");
	}
}

export async function appendAITraceLog(
	app: App,
	sourceNotePath: string,
	collector: AITraceCollector,
	currentPath = sourceNotePath,
): Promise<string> {
	const resolved = resolveMarkdownWriteTargetPath(app, collector.aiLogPath, currentPath);
	if (!resolved.success) {
		throw new Error(`Invalid ai_log path: ${resolved.error}`);
	}

	if (resolved.path === sourceNotePath) {
		throw new Error("ai_log cannot target the active note.");
	}

	const nextSection = collector.renderMarkdown();
	const existing = app.vault.getAbstractFileByPath(resolved.path);

	if (existing instanceof TFile) {
		await app.vault.process(existing, (content) => {
			if (!content.trim()) {
				return nextSection;
			}

			return `${content.replace(/\s*$/, "")}\n\n${nextSection}`;
		});
		return resolved.path;
	}

	await ensureParentFolders(app, resolved.path);
	await app.vault.create(resolved.path, nextSection);
	return resolved.path;
}

function ensureRedactedHeaderMap(record: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(record)) {
		if (isSensitiveKey(key)) {
			normalized[key] = "[REDACTED]";
			continue;
		}

		normalized[key] = value;
	}

	return normalized;
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

function formatTraceCodeBlock(data: unknown): string {
	if (typeof data === "string") {
		return `\`\`\`text\n${data}\n\`\`\``;
	}

	return `\`\`\`json\n${JSON.stringify(sanitizeTraceValue(data), null, 2)}\n\`\`\``;
}

function isSensitiveKey(key: string): boolean {
	return /authorization|api[-_]?key|cookie|secret|token/i.test(key);
}

function normalizeErrorForTrace(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
		};
	}

	return {
		message: String(error),
	};
}

function sanitizeTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) {
		return value ?? null;
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (typeof value !== "object") {
		return value;
	}

	if (value instanceof Error) {
		return normalizeErrorForTrace(value);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeTraceValue(entry, seen));
	}

	if (seen.has(value)) {
		return "[Circular]";
	}

	seen.add(value);
	const record = value as Record<string, unknown>;
	const normalized: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(record)) {
		if (entry && typeof entry === "object" && key.toLowerCase() === "headers" && !Array.isArray(entry)) {
			normalized[key] = ensureRedactedHeaderMap(entry as Record<string, unknown>);
			continue;
		}

		if (isSensitiveKey(key)) {
			normalized[key] = "[REDACTED]";
			continue;
		}

		normalized[key] = sanitizeTraceValue(entry, seen);
	}

	return normalized;
}
