const DATE_PREFIX_REGEX = /^(\d{4}-\d{2}-\d{2}\s*-\s*)/;
const FORBIDDEN_FILENAME_CHARS_REGEX = /[\\/:*?"<>|]/g;
const TRAILING_NOISE_REGEX = /[.!?,;:]+$/;
const DOCUMENT_LOCATION_NOISE_REGEX = /\b(?:in|into)\s+(?:a|an|the|my|this)\s+document\b/gi;
const REQUEST_PREFIX_REGEX =
	/^(?:help me|can you|could you|would you|please|i want (?:you )?to|i need (?:you )?to|let'?s)\s+/i;
const REQUEST_ACTION_REGEX = /^(?:create|write|draft|compose|make|start|begin|generate|put|save|add)\s+/i;

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
	return title.match(DATE_PREFIX_REGEX)?.[1] ?? "";
}

export function inferDocumentBasenameFromRequest(message: string, fallbackBasename: string): string {
	let title = message.trim();
	title = title.replace(/\[\[[^[\]]+\]\]/g, " ");
	title = title.replace(/\[[^\]]+\]\(([^)]+)\)/g, " ");
	title = title.replace(REQUEST_PREFIX_REGEX, "");
	title = title.replace(REQUEST_ACTION_REGEX, "");
	title = title.replace(DOCUMENT_LOCATION_NOISE_REGEX, " ");
	title = title.replace(/\bfor me\b/gi, " ");
	title = title.replace(/\s+/g, " ").trim();

	if (/^(?:a|an|the)\s+/i.test(title)) {
		title = title.replace(/^(?:a|an|the)\s+/i, "");
	}

	title = title.replace(/^\W+|\W+$/g, "").trim();
	if (title) {
		title = title.charAt(0).toUpperCase() + title.slice(1);
	}

	const normalized = normalizeGeneratedTitle(title);
	if (!normalized || /^(?:doc|document|draft)$/i.test(normalized)) {
		return normalizeGeneratedTitle(fallbackBasename);
	}

	return normalized;
}

function hasWrappingQuotes(value: string): boolean {
	return (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("`") && value.endsWith("`"))
	);
}
