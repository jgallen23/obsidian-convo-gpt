import matter from "gray-matter";
import { z } from "zod";
import { DEFAULT_REFERENCED_FILE_EXTENSIONS, DEFAULT_SYSTEM_PROMPT } from "./constants";
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

const extensionListSchema = z.preprocess((value) => {
	if (typeof value === "string") {
		return value.split(",");
	}
	return value;
}, z.array(z.string()).default([...DEFAULT_REFERENCED_FILE_EXTENSIONS]));

const noteOverridesSchema = z
	.object({
		model: z.string().min(1).optional(),
		temperature: z.number().finite().optional(),
		max_tokens: z.number().int().positive().optional(),
		stream: booleanSchema.optional(),
		agent: z.string().min(1).optional(),
		document: z.string().min(1).optional(),
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
	enableFetchTool: z.boolean().default(true),
	enableMarkdownFileTool: z.boolean().default(true),
	enableReferencedFileReadTool: z.boolean().default(true),
	referencedFileExtensions: extensionListSchema,
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
	};
}

export function sanitizeSettings(data: unknown): PluginSettings {
	const parsed = settingsSchema.parse(data ?? {});
	return {
		...parsed,
		defaultSystemPrompt: parsed.defaultSystemPrompt || DEFAULT_SYSTEM_PROMPT,
		referencedFileExtensions: normalizeReferencedFileExtensions(parsed.referencedFileExtensions),
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

export function setNoteFrontmatterField(text: string, key: string, value: string): string {
	const parsed = matter(text);
	return matter.stringify(parsed.content, {
		...parsed.data,
		[key]: value,
	});
}
