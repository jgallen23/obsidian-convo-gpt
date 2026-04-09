import type {
	FunctionTool,
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

const WIKI_LINK_REGEX = /\[\[[^[\]]+\]\]/;
const MARKDOWN_LINK_REGEX = /\[[^\]]+\]\(([^)]+)\)/;

export function shouldOfferMarkdownFileTool(message: string, enabled: boolean): boolean {
	if (!enabled) {
		return false;
	}

	const normalized = message.toLowerCase();
	const hasWriteIntent = /\b(save|append|replace|update|edit|rewrite|create|write)\b/.test(normalized);
	if (!hasWriteIntent) {
		return false;
	}

	if (/\.md\b/.test(normalized)) {
		return true;
	}

	if (WIKI_LINK_REGEX.test(message)) {
		return true;
	}

	for (const match of message.matchAll(new RegExp(MARKDOWN_LINK_REGEX, "g"))) {
		const path = match[1]?.trim() ?? "";
		if (path.toLowerCase().endsWith(".md")) {
			return true;
		}
	}

	return false;
}

export function buildMarkdownFileToolPolicy(): string {
	return [
		"Markdown file save policy:",
		"- Never claim content was saved, appended, updated, or written unless save_markdown_file returned status success in this turn.",
		"- If no save succeeds, explicitly say the content was not saved.",
		"- Only use save_markdown_file when the user explicitly names the markdown target, such as story.md, Stories/story.md, or [[Stories/story]].",
		"- If the user asks to save but does not provide an explicit markdown path or note reference, ask them where to save it instead of guessing.",
	].join("\n");
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
					description: "Vault-relative markdown path or note reference like story.md, Stories/story.md, or [[Stories/story]].",
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
	const trimmed = normalizeMarkdownPathInput(rawPath);
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

function normalizeMarkdownPathInput(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return "";
	}

	const wikiMatch = trimmed.match(/^\[\[([^[\]]+)\]\]$/);
	const markdownMatch = trimmed.match(/^\[[^\]]+\]\(([^)]+)\)$/);
	const referenceTarget = wikiMatch?.[1] ?? markdownMatch?.[1] ?? trimmed;
	const withoutAlias = referenceTarget.split("|")[0]?.trim() ?? "";
	const withoutFragment = withoutAlias.split("#")[0]?.trim() ?? "";

	if (!withoutFragment) {
		return "";
	}

	if (!/\.[^./\\]+$/.test(withoutFragment)) {
		return `${withoutFragment}.md`;
	}

	return withoutFragment;
}

export function buildMarkdownWritePreview(content: string | undefined, maxChars = 800): string {
	const trimmed = (content ?? "").trim();
	if (!trimmed) {
		return "(no content preview)";
	}

	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…` : trimmed;
}
