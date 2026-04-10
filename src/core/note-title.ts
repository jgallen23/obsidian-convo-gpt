const DATE_PREFIX_REGEX = /^(\d{4}-\d{2}-\d{2}\s*-\s*)/;
const GENERATED_CHAT_BASENAME_REGEX = /^(\d{4}-\d{2}-\d{2})-(\d+)$/;
const FORBIDDEN_FILENAME_CHARS_REGEX = /[\\/:*?"<>|]/g;
const TRAILING_NOISE_REGEX = /[.!?,;:]+$/;

export function buildRetitledBasename(currentBasename: string, rawTitle: string): string {
	const preservedPrefix = extractDatePrefix(currentBasename);
	let normalizedTitle = normalizeGeneratedTitle(rawTitle);

	if (preservedPrefix && DATE_PREFIX_REGEX.test(normalizedTitle)) {
		normalizedTitle = normalizeGeneratedTitle(normalizedTitle.replace(DATE_PREFIX_REGEX, ""));
	}

	if (!normalizedTitle) {
		throw new Error("Convo GPT could not infer a valid title.");
	}

	return `${preservedPrefix}${normalizedTitle}`;
}

export function normalizeGeneratedTitle(rawTitle: string): string {
	let title = rawTitle.trim();

	while (hasWrappingQuotes(title)) {
		title = title.slice(1, -1).trim();
	}

	title = title.replace(/^#+\s*/, "");
	title = title.replace(FORBIDDEN_FILENAME_CHARS_REGEX, " ");
	title = title.replace(/\s+/g, " ").trim();
	title = title.replace(TRAILING_NOISE_REGEX, "").trim();
	title = title.replace(/^[\s.-]+|[\s.-]+$/g, "").trim();

	return title;
}

export function extractDatePrefix(title: string): string {
	const generatedChatMatch = title.match(GENERATED_CHAT_BASENAME_REGEX);
	if (generatedChatMatch) {
		return `${generatedChatMatch[1]} - `;
	}

	return title.match(DATE_PREFIX_REGEX)?.[1] ?? "";
}

export function formatChatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function buildGeneratedChatBasename(dateText: string, sequence: number): string {
	return `${dateText}-${sequence}`;
}

export function buildGeneratedChatPath(folder: string, basename: string): string {
	return folder ? `${folder}/${basename}.md` : `${basename}.md`;
}

export function isGeneratedChatBasename(basename: string): boolean {
	return GENERATED_CHAT_BASENAME_REGEX.test(basename);
}

export function normalizeChatsFolder(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, "");
}

function hasWrappingQuotes(value: string): boolean {
	return (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("`") && value.endsWith("`"))
	);
}
