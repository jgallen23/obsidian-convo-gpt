import type {
	FunctionTool,
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import { z } from "zod";

export const MARKDOWN_FILE_TOOL_NAME = "save_markdown_file";
export const MAX_MARKDOWN_TOOL_ROUNDS = 8;

export type MarkdownWriteOperation = "append" | "create" | "edit" | "replace";

export interface MarkdownWriteRequest {
	path: string;
	operation: MarkdownWriteOperation;
	content?: string;
	instructions?: string;
	reason?: string;
}

export interface MarkdownWriteToolResult {
	status: "denied" | "edit_context" | "success" | "validation_error";
	message: string;
	path?: string;
	operation?: MarkdownWriteOperation;
	currentContent?: string;
}

const markdownWriteRequestSchema = z
	.object({
		path: z.string().min(1),
		operation: z.enum(["append", "create", "edit", "replace"]),
		content: z.string().nullable().optional(),
		instructions: z.string().nullable().optional(),
		reason: z.string().nullable().optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.operation === "append" || value.operation === "create" || value.operation === "replace") && !value.content) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `content is required for ${value.operation}`,
				path: ["content"],
			});
		}

		if (value.operation === "edit" && !value.instructions?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "instructions are required for edit",
				path: ["instructions"],
			});
		}
	});

export function shouldOfferMarkdownFileTool(message: string, enabled: boolean, rememberedPath?: string): boolean {
	if (!enabled) {
		return false;
	}

	const normalized = message.toLowerCase();
	if (/\.md\b/.test(normalized)) {
		return true;
	}

	const hasWriteIntent = /\b(save|append|replace|update|edit|rewrite|create)\b/.test(normalized);
	const hasFileHint = /\b(file|note|markdown)\b/.test(normalized);
	const hasContinuationIntent = /\b(add|append|continue|expand|update|revise|rewrite|change)\b/.test(normalized);

	if (hasWriteIntent && hasFileHint) {
		return true;
	}

	return Boolean(rememberedPath && hasContinuationIntent);
}

export function buildMarkdownFileToolPolicy(rememberedPath?: string): string {
	const lines = [
		"Markdown file save policy:",
		"- Never claim content was saved, appended, updated, or written unless save_markdown_file returned status success in this turn.",
		"- If no save succeeds, explicitly say the content was not saved.",
	];

	if (rememberedPath) {
		lines.push(
			`- This note remembers the last successful markdown save target: ${rememberedPath}.`,
			"- For follow-up requests to add, continue, expand, revise, or update content without naming a file, default to appending to that remembered markdown file unless the user clearly asks for replace.",
		);
	} else {
		lines.push("- If the user asks to save but does not provide a markdown filename, ask them where to save it instead of guessing.");
	}

	return lines.join("\n");
}

export function getMarkdownFileToolDefinition(): FunctionTool {
	return {
		type: "function",
		name: MARKDOWN_FILE_TOOL_NAME,
		description:
			"Create or update another markdown file in the Obsidian vault. Use this when the user asks you to save generated content into a .md file.",
		strict: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: {
					type: "string",
					description: "Vault-relative markdown path like story.md or Stories/story.md.",
				},
				operation: {
					type: "string",
					enum: ["create", "replace", "append", "edit"],
					description: "The kind of markdown file change to perform.",
				},
				content: {
					type: ["string", "null"],
					description: "Required for create, replace, and append. Set to null for edit.",
				},
				instructions: {
					type: ["string", "null"],
					description: "Required for edit. Describe the targeted change you want applied to the existing markdown file. Set to null otherwise.",
				},
				reason: {
					type: ["string", "null"],
					description: "Short explanation shown to the user during approval.",
				},
			},
			required: ["path", "operation", "content", "instructions", "reason"],
		},
	};
}

export function parseMarkdownWriteRequest(argumentsJson: string): { data: MarkdownWriteRequest; success: true } | { error: string; success: false } {
	try {
		const parsedJson = JSON.parse(argumentsJson) as unknown;
		const parsed = markdownWriteRequestSchema.safeParse(parsedJson);
		if (!parsed.success) {
			const [issue] = parsed.error.issues;
			return {
				success: false,
				error: issue?.message ?? "Invalid markdown write request.",
			};
		}

		return {
			success: true,
			data: {
				path: parsed.data.path,
				operation: parsed.data.operation,
				content: parsed.data.content ?? undefined,
				instructions: parsed.data.instructions ?? undefined,
				reason: parsed.data.reason ?? undefined,
			},
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Invalid JSON arguments.",
		};
	}
}

export function resolveMarkdownVaultPath(rawPath: string): { path: string; success: true } | { error: string; success: false } {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return { success: false, error: "A markdown file path is required." };
	}

	if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[a-z]:/i.test(trimmed)) {
		return { success: false, error: "Use a vault-relative markdown path, not an absolute filesystem path." };
	}

	const normalizedSegments: string[] = [];
	for (const segment of trimmed.replace(/\\/g, "/").split("/")) {
		if (!segment || segment === ".") {
			continue;
		}

		if (segment === "..") {
			return { success: false, error: "Parent directory segments are not allowed." };
		}

		normalizedSegments.push(segment);
	}

	if (normalizedSegments.length === 0) {
		return { success: false, error: "A markdown file path is required." };
	}

	const path = normalizedSegments.join("/");
	if (!path.toLowerCase().endsWith(".md")) {
		return { success: false, error: "Only .md files are supported." };
	}

	return { success: true, path };
}

export function extractFunctionToolCalls(response: unknown): ResponseFunctionToolCall[] {
	const record = toRecord(response);
	const output = Array.isArray(record.output) ? record.output : [];
	const calls: ResponseFunctionToolCall[] = [];

	for (const item of output) {
		const itemRecord = toRecord(item);
		if (
			itemRecord.type === "function_call" &&
			typeof itemRecord.call_id === "string" &&
			typeof itemRecord.name === "string" &&
			typeof itemRecord.arguments === "string"
		) {
			calls.push({
				type: "function_call",
				call_id: itemRecord.call_id,
				name: itemRecord.name,
				arguments: itemRecord.arguments,
				id: typeof itemRecord.id === "string" ? itemRecord.id : undefined,
				status: itemRecord.status === "completed" || itemRecord.status === "in_progress" || itemRecord.status === "incomplete"
					? itemRecord.status
					: undefined,
			});
		}
	}

	return calls;
}

export function buildFunctionCallOutput(callId: string, result: MarkdownWriteToolResult): ResponseInputItem {
	return {
		type: "function_call_output",
		call_id: callId,
		output: JSON.stringify(result),
	};
}

export function buildMarkdownWritePreview(content: string | undefined, maxChars = 800): string {
	const trimmed = (content ?? "").trim();
	if (!trimmed) {
		return "(no content preview)";
	}

	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…` : trimmed;
}

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
