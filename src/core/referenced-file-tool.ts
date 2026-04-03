import type {
	FunctionTool,
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses";
import { z } from "zod";

export const REFERENCED_FILE_TOOL_NAME = "read_referenced_file";

export interface ReferencedFileReadRequest {
	reference: string;
}

export interface ReferencedFileReadToolResult {
	status: "success" | "validation_error";
	message: string;
	reference?: string;
	path?: string;
	fileType?: string;
	content?: string;
	truncated?: boolean;
}

export interface ReferencedFileSummary {
	path: string;
	truncated: boolean;
}

const referencedFileReadRequestSchema = z.object({
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

export function buildReferencedFileToolPolicy(): string {
	return [
		"Referenced file read policy:",
		"- Linked .md and .csv files from the current chat note and the active agent prompt are available through read_referenced_file instead of being preloaded.",
		"- Call read_referenced_file when you need the contents of a linked file.",
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
