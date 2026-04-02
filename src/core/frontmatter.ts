import matter from "gray-matter";
import { z } from "zod";
import { DEFAULT_SYSTEM_PROMPT, LAST_SAVED_MARKDOWN_PATH_KEY } from "./constants";
import type { NoteOverrides, ParsedNoteDocument, PluginSettings } from "./types";

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

const noteOverridesSchema = z
	.object({
		model: z.string().min(1).optional(),
		temperature: z.number().finite().optional(),
		max_tokens: z.number().int().positive().optional(),
		stream: booleanSchema.optional(),
		agent: z.string().min(1).optional(),
		system_commands: stringArraySchema.optional(),
		baseUrl: z.string().url().optional(),
		openai_native_web_search: booleanSchema.optional(),
	})
	.passthrough();

const settingsSchema = z.object({
	apiKey: z.string().default(""),
	baseUrl: z.string().url().default("https://api.openai.com/v1"),
	defaultModel: z.string().min(1).default("openai@gpt-5.4"),
	defaultTemperature: z.number().finite().default(0.2),
	defaultMaxTokens: z.number().int().positive().default(4096),
	stream: z.boolean().default(true),
	agentFolder: z.string().default(""),
	defaultSystemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
	enableOpenAINativeWebSearch: z.boolean().default(true),
	enableMarkdownFileTool: z.boolean().default(true),
});

const FRONTMATTER_BLOCK_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function parseNoteDocument(text: string): ParsedNoteDocument {
	const parsed = matter(text);
	const match = text.match(FRONTMATTER_BLOCK_REGEX);
	const bodyStartOffset = match ? match[0].length : 0;
	const lastSavedMarkdownPath = getPersistedLastSavedMarkdownPath(text);

	return {
		body: parsed.content,
		bodyStartOffset,
		overrides: parseNoteOverrides(parsed.data),
		lastSavedMarkdownPath,
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
	};
}

export function sanitizeSettings(data: unknown): PluginSettings {
	const parsed = settingsSchema.parse(data ?? {});
	return {
		...parsed,
		defaultSystemPrompt: parsed.defaultSystemPrompt || DEFAULT_SYSTEM_PROMPT,
	};
}

export function getPersistedLastSavedMarkdownPath(text: string): string | undefined {
	const parsed = matter(text);
	const value = parsed.data?.[LAST_SAVED_MARKDOWN_PATH_KEY];
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function persistLastSavedMarkdownPath(text: string, path: string): string {
	const parsed = matter(text);
	const data = typeof parsed.data === "object" && parsed.data !== null ? { ...parsed.data } : {};
	data[LAST_SAVED_MARKDOWN_PATH_KEY] = path;
	return matter.stringify(parsed.content, data);
}
