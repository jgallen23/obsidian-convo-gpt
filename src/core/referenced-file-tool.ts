import type {
	FunctionTool,
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import { z } from "zod";

export const REFERENCED_FILE_TOOL_NAME = "read_referenced_file";
export const REFERENCED_FILE_SEARCH_TOOL_NAME = "search_referenced_file";
export const REFERENCED_FILE_SECTION_TOOL_NAME = "read_referenced_file_section";

export interface ReferencedFileReadRequest {
	reference: string;
}

export interface ReferencedFileSearchRequest {
	query: string;
	reference: string;
}

export interface ReferencedFileSectionReadRequest {
	line: number;
	reference: string;
}

export interface ReferencedFileReadToolResult {
	status: "deferred_to_search" | "denied" | "success" | "validation_error";
	message: string;
	reference?: string;
	path?: string;
	fileType?: string;
	content?: string;
	truncated?: boolean;
}

export interface ReferencedFileSearchMatch {
	lineEnd: number;
	lineStart: number;
	snippet: string;
}

export interface ReferencedFileSearchToolResult {
	status: "success" | "validation_error";
	message: string;
	matches?: ReferencedFileSearchMatch[];
	path?: string;
	fileType?: string;
	query?: string;
	reference?: string;
	truncated?: boolean;
}

export interface ReferencedFileSectionToolResult {
	status: "success" | "validation_error";
	message: string;
	content?: string;
	fileType?: string;
	lineEnd?: number;
	lineStart?: number;
	path?: string;
	reference?: string;
	sectionHeading?: string;
	truncated?: boolean;
}

export interface ReferencedFileSummary {
	path: string;
	truncated: boolean;
}

export interface ReferencedFileSearchSummary {
	path: string;
	query: string;
	truncated: boolean;
}

export interface ReferencedFileSectionSummary {
	lineEnd: number;
	lineStart: number;
	path: string;
	sectionHeading?: string;
}

const referencedFileReadRequestSchema = z.object({
	reference: z.string().min(1),
});

const referencedFileSearchRequestSchema = z.object({
	query: z.string().min(1),
	reference: z.string().min(1),
});

const referencedFileSectionReadRequestSchema = z.object({
	line: z.number().int().positive(),
	reference: z.string().min(1),
});

export function getReferencedFileToolDefinition(): FunctionTool {
	return {
		type: "function",
		name: REFERENCED_FILE_TOOL_NAME,
		description:
			"Read the contents of a linked Obsidian markdown or CSV file when the chat note or agent prompt references it.",
		strict: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				reference: {
					type: "string",
					description: "The linked file target to read, such as Style Guide, Notes/Brief.md, or data/report.csv.",
				},
			},
			required: ["reference"],
		},
	};
}

export function getReferencedFileSearchToolDefinition(): FunctionTool {
	return {
		type: "function",
		name: REFERENCED_FILE_SEARCH_TOOL_NAME,
		description:
			"Search within a linked Obsidian markdown or CSV file and return matching snippets with line ranges.",
		strict: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				reference: {
					type: "string",
					description: "The linked file target to search, such as Style Guide, Notes/Brief.md, or data/report.csv.",
				},
				query: {
					type: "string",
					description: "A short keyword or phrase to search for inside the linked file.",
				},
			},
			required: ["reference", "query"],
		},
	};
}

export function getReferencedFileSectionToolDefinition(): FunctionTool {
	return {
		type: "function",
		name: REFERENCED_FILE_SECTION_TOOL_NAME,
		description:
			"Read the enclosing markdown section for a line number found in search results, or a bounded line window for non-markdown files.",
		strict: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				reference: {
					type: "string",
					description: "The linked file target to read from, such as Style Guide, Notes/Brief.md, or data/report.csv.",
				},
				line: {
					type: "number",
					description: "A 1-based line number, usually taken from search_referenced_file results.",
				},
			},
			required: ["reference", "line"],
		},
	};
}

export function buildReferencedFileToolPolicy(): string {
	return [
		"Referenced file read policy:",
		"- Linked supported files from the current chat note and the active agent prompt are available through read_referenced_file instead of being preloaded.",
		"- Linked supported files are also available through search_referenced_file, which returns matching snippets with line ranges.",
		"- Linked supported files are also available through read_referenced_file_section, which reads the enclosing section for a line number from search results.",
		"- Call read_referenced_file when you need the full contents of a linked file, including large files.",
		"- Only use search_referenced_file when the user explicitly asks you to search within a file instead of loading the full file, or when a tool result tells you the user chose search for a large file.",
		"- When search_referenced_file finds a relevant line, call read_referenced_file_section with that line number before asking for another full file read.",
		"- You may follow links found inside files that were successfully read earlier in this turn.",
		"- Never claim you read a file unless read_referenced_file returned status success in this turn.",
	].join("\n");
}

export function formatReferencedFileAppendix(reads: ReferencedFileSummary[]): string {
	if (reads.length === 0) {
		return "";
	}

	const seen = new Set<string>();
	const lines: string[] = [];

	for (const read of reads) {
		if (seen.has(read.path)) {
			continue;
		}

		seen.add(read.path);
		lines.push(`${lines.length + 1}. [[${read.path}]]${read.truncated ? " (truncated)" : ""}`);
	}

	if (lines.length === 0) {
		return "";
	}

	return `\n\n### Referenced files\n${lines.join("\n")}`;
}

export function formatReferencedFileSearchAppendix(searches: ReferencedFileSearchSummary[]): string {
	if (searches.length === 0) {
		return "";
	}

	const seen = new Set<string>();
	const lines: string[] = [];

	for (const search of searches) {
		const key = `${search.path} ${search.query} ${search.truncated}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		lines.push(
			`${lines.length + 1}. Searched [[${search.path}]] for "${escapeInlineQuotes(search.query)}"${search.truncated ? " (truncated)" : ""}`,
		);
	}

	if (lines.length === 0) {
		return "";
	}

	return `\n\n### Referenced file searches\n${lines.join("\n")}`;
}

export function formatReferencedFileSectionAppendix(sections: ReferencedFileSectionSummary[]): string {
	if (sections.length === 0) {
		return "";
	}

	const seen = new Set<string>();
	const lines: string[] = [];

	for (const section of sections) {
		const key = `${section.path} ${section.lineStart} ${section.lineEnd} ${section.sectionHeading ?? ""}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		lines.push(
			section.sectionHeading
				? `${lines.length + 1}. Read section "${escapeInlineQuotes(section.sectionHeading)}" from [[${section.path}]] (lines ${section.lineStart}-${section.lineEnd})`
				: `${lines.length + 1}. Read lines ${section.lineStart}-${section.lineEnd} from [[${section.path}]]`,
		);
	}

	if (lines.length === 0) {
		return "";
	}

	return `\n\n### Referenced file sections\n${lines.join("\n")}`;
}

export function parseReferencedFileReadRequest(
	argumentsJson: string,
): { data: ReferencedFileReadRequest; success: true } | { error: string; success: false } {
	try {
		const parsedJson = JSON.parse(argumentsJson) as unknown;
		const parsed = referencedFileReadRequestSchema.safeParse(parsedJson);
		if (!parsed.success) {
			const [issue] = parsed.error.issues;
			return {
				success: false,
				error: issue?.message ?? "Invalid referenced file read request.",
			};
		}

		return {
			success: true,
			data: parsed.data,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Invalid JSON arguments.",
		};
	}
}

export function parseReferencedFileSearchRequest(
	argumentsJson: string,
): { data: ReferencedFileSearchRequest; success: true } | { error: string; success: false } {
	try {
		const parsedJson = JSON.parse(argumentsJson) as unknown;
		const parsed = referencedFileSearchRequestSchema.safeParse(parsedJson);
		if (!parsed.success) {
			const [issue] = parsed.error.issues;
			return {
				success: false,
				error: issue?.message ?? "Invalid referenced file search request.",
			};
		}

		return {
			success: true,
			data: parsed.data,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Invalid JSON arguments.",
		};
	}
}

export function parseReferencedFileSectionReadRequest(
	argumentsJson: string,
): { data: ReferencedFileSectionReadRequest; success: true } | { error: string; success: false } {
	try {
		const parsedJson = JSON.parse(argumentsJson) as unknown;
		const parsed = referencedFileSectionReadRequestSchema.safeParse(parsedJson);
		if (!parsed.success) {
			const [issue] = parsed.error.issues;
			return {
				success: false,
				error: issue?.message ?? "Invalid referenced file section read request.",
			};
		}

		return {
			success: true,
			data: parsed.data,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Invalid JSON arguments.",
		};
	}
}

export function buildFunctionCallOutput(callId: string, result: unknown): ResponseInputItem {
	return {
		type: "function_call_output",
		call_id: callId,
		output: JSON.stringify(result),
	};
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
				status:
					itemRecord.status === "completed" || itemRecord.status === "in_progress" || itemRecord.status === "incomplete"
						? itemRecord.status
						: undefined,
			});
		}
	}

	return calls;
}

export function normalizeReferencedFileLookup(rawReference: string): string {
	const trimmed = rawReference.trim();
	if (!trimmed) {
		return "";
	}

	const wikiMatch = trimmed.match(/^\[\[([^[\]]+)\]\]$/);
	if (wikiMatch) {
		return normalizeReferenceAlias(wikiMatch[1] ?? "");
	}

	const markdownMatch = trimmed.match(/^\[[^\]]+\]\(([^)]+)\)$/);
	if (markdownMatch) {
		return normalizeReferenceAlias(markdownMatch[1] ?? "");
	}

	return normalizeReferenceAlias(trimmed);
}

function normalizeReferenceAlias(rawReference: string): string {
	return rawReference
		.split("|")[0]
		?.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "") ?? "";
}

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function escapeInlineQuotes(text: string): string {
	return text.replace(/"/g, '\\"');
}
