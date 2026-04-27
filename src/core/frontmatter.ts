import matter from "gray-matter";
import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_REFERENCED_FILE_EXTENSIONS, DEFAULT_SYSTEM_PROMPT } from "./constants";
import type { McpServerConfig, NoteOverrides, ParsedNoteDocument, PluginSettings } from "./types";

const booleanSchema = z.preprocess((value) => {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") {
			return true;
		}
		if (normalized === "false") {
			return false;
		}
	}
	return value;
}, z.boolean());

const stringArraySchema = z.preprocess((value) => {
	if (typeof value === "string") {
		return [value];
	}
	return value;
}, z.array(z.string().min(1)).default([]));

const optionalStringArraySchema = z.preprocess((value) => {
	if (typeof value === "string") {
		return [value];
	}
	if (value === null || value === undefined) {
		return undefined;
	}
	return value;
}, z.array(z.string()).optional());

const extensionListSchema = z.preprocess((value) => {
	if (typeof value === "string") {
		return value.split(",");
	}
	return value;
}, z.array(z.string()).default([...DEFAULT_REFERENCED_FILE_EXTENSIONS]));

const optionalTrimmedStringSchema = z.preprocess((value) => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	if (value === null || value === undefined) {
		return undefined;
	}

	return value;
}, z.string().min(1).optional());

const noteOverridesSchema = z
	.object({
		model: optionalTrimmedStringSchema,
		temperature: z.number().finite().optional(),
		max_tokens: z.number().int().positive().optional(),
		stream: booleanSchema.optional(),
		agent: optionalTrimmedStringSchema,
		document: optionalTrimmedStringSchema,
		system_commands: stringArraySchema.optional(),
		mcp_servers: optionalStringArraySchema,
		baseUrl: optionalTrimmedStringSchema.pipe(z.string().url().optional()),
		openai_native_web_search: booleanSchema.optional(),
	})
	.passthrough();

const settingsSchema = z.object({
	apiKey: z.string().default(""),
	baseUrl: z.string().url().default("https://api.openai.com/v1"),
	defaultModel: z.string().min(1).default(DEFAULT_MODEL),
	defaultTemperature: z.number().finite().optional(),
	defaultMaxTokens: z.number().int().positive().default(4096),
	stream: z.boolean().default(true),
	agentFolder: z.string().default(""),
	chatsFolder: z.string().default("chats/"),
	defaultSystemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
	enableOpenAINativeWebSearch: z.boolean().default(true),
	enableFetchTool: z.boolean().default(true),
	enableMarkdownFileTool: z.boolean().default(true),
	enableReferencedFileReadTool: z.boolean().default(true),
	enableDebugLogging: z.boolean().default(false),
	referencedFileExtensions: extensionListSchema,
	enableMcpServers: z.boolean().default(false),
	mcpServers: z.array(z.unknown()).default([]),
});

const FRONTMATTER_BLOCK_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function parseNoteDocument(text: string): ParsedNoteDocument {
	const parsed = matter(text);
	const match = text.match(FRONTMATTER_BLOCK_REGEX);
	const bodyStartOffset = match ? match[0].length : 0;

	return {
		body: parsed.content,
		bodyStartOffset,
		overrides: parseNoteOverrides(parsed.data),
	};
}

export function stripFrontmatter(text: string): string {
	return matter(text).content;
}

export function parseNoteOverrides(data: unknown): NoteOverrides {
	const parsed = noteOverridesSchema.safeParse(data);
	if (!parsed.success) {
		return {};
	}

	return {
		...parsed.data,
		system_commands: parsed.data.system_commands ?? [],
		mcp_servers: parsed.data.mcp_servers === undefined ? undefined : normalizeStringList(parsed.data.mcp_servers),
	};
}

export function sanitizeSettings(data: unknown): PluginSettings {
	const parsed = settingsSchema.parse(data ?? {});
	return {
		...parsed,
		defaultSystemPrompt: parsed.defaultSystemPrompt || DEFAULT_SYSTEM_PROMPT,
		referencedFileExtensions: normalizeReferencedFileExtensions(parsed.referencedFileExtensions),
		mcpServers: normalizeMcpServerConfigs(parsed.mcpServers),
	};
}

export function normalizeReferencedFileExtensions(extensions: string[]): string[] {
	const normalized = Array.from(
		new Set(
			extensions
				.map((extension) => extension.trim().toLowerCase().replace(/^\./, ""))
				.filter((extension) => extension.length > 0),
		),
	);

	return normalized.length > 0 ? normalized : [...DEFAULT_REFERENCED_FILE_EXTENSIONS];
}

export function normalizeMcpServerConfigs(entries: unknown[]): McpServerConfig[] {
	const normalized: McpServerConfig[] = [];
	const usedIds = new Set<string>();

	for (const [index, entry] of entries.entries()) {
		const next = normalizeMcpServerConfigEntry(entry, index, usedIds);
		if (next) {
			normalized.push(next);
		}
	}

	return normalized;
}

export function setNoteFrontmatterField(text: string, key: string, value: string): string {
	const parsed = matter(text);
	return matter.stringify(parsed.content, {
		...parsed.data,
		[key]: value,
	});
}

function normalizeMcpServerConfigEntry(
	entry: unknown,
	index: number,
	usedIds: Set<string>,
): McpServerConfig | null {
	const record = toRecord(entry);
	if (Object.keys(record).length === 0) {
		return null;
	}

	const serverLabel = typeof record.serverLabel === "string" ? record.serverLabel.trim() : "";
	const serverUrl = typeof record.serverUrl === "string" ? record.serverUrl.trim() : "";
	const headers = normalizeHeaderRecord(record.headers);
	const allowedToolNames = normalizeStringList(record.allowedToolNames);
	const rawId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `mcp-${index + 1}`;
	const id = dedupeId(rawId, usedIds);

	return {
		id,
		enabled: Boolean(record.enabled),
		serverLabel,
		serverUrl,
		headers,
		allowedToolNames,
	};
}

function normalizeHeaderRecord(value: unknown): Record<string, string> {
	const record = toRecord(value);
	const headers: Record<string, string> = {};

	for (const [key, rawValue] of Object.entries(record)) {
		if (typeof rawValue !== "string") {
			continue;
		}

		const headerName = key.trim();
		if (!headerName) {
			continue;
		}

		headers[headerName] = rawValue;
	}

	return headers;
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return Array.from(
		new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		),
	);
}

function dedupeId(candidate: string, usedIds: Set<string>): string {
	let next = candidate;
	let suffix = 2;
	while (usedIds.has(next)) {
		next = `${candidate}-${suffix}`;
		suffix += 1;
	}
	usedIds.add(next);
	return next;
}

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
