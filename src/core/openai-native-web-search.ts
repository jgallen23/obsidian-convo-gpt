const WEB_SEARCH_MODEL_PATTERNS = ["gpt-5*", "gpt-4o*", "gpt-4.1*", "o1*", "o3*", "o4*"];
const EXCLUDED_MODELS = new Set(["gpt-4.1-nano"]);

export interface SourceCandidate {
	title?: string;
	name?: string;
	url?: string;
	source?: {
		title?: string;
		name?: string;
		url?: string;
	};
}

export function supportsOpenAINativeWebSearch(modelId: string): boolean {
	if (!modelId || EXCLUDED_MODELS.has(modelId)) {
		return false;
	}

	return WEB_SEARCH_MODEL_PATTERNS.some((pattern) => matchesPattern(modelId, pattern));
}

export function formatWebSearchSources(sources: unknown): string {
	if (!Array.isArray(sources) || sources.length === 0) {
		return "";
	}

	const links = new Map<string, string>();

	for (const source of sources as SourceCandidate[]) {
		const url = source.url || source.source?.url;
		if (!url) {
			continue;
		}

		const title = source.title || source.name || source.source?.title || source.source?.name || url;
		if (!links.has(url)) {
			links.set(url, escapeMarkdownLinkText(title));
		}
	}

	if (links.size === 0) {
		return "";
	}

	const lines = Array.from(links.entries()).map(([url, title], index) => `${index + 1}. [${title}](${url})`);
	return `\n\n### Sources\n${lines.join("\n")}`;
}

export function extractResponseSources(payload: unknown): SourceCandidate[] {
	const sources: SourceCandidate[] = [];
	collectSources(payload, sources);
	return sources;
}

function collectSources(value: unknown, sink: SourceCandidate[]): void {
	if (!value || typeof value !== "object") {
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectSources(item, sink);
		}
		return;
	}

	const candidate = value as Record<string, unknown>;
	if (
		(typeof candidate.url === "string" || typeof candidate.source === "object") &&
		(typeof candidate.title === "string" ||
			typeof candidate.name === "string" ||
			(typeof candidate.source === "object" && candidate.source !== null))
	) {
		sink.push(candidate as SourceCandidate);
	}

	if (
		candidate.type === "url_citation" &&
		typeof candidate.url === "string" &&
		typeof candidate.title === "string"
	) {
		sink.push({
			title: candidate.title,
			url: candidate.url,
		});
	}

	for (const nestedValue of Object.values(candidate)) {
		collectSources(nestedValue, sink);
	}
}

function matchesPattern(value: string, pattern: string): boolean {
	if (!pattern.includes("*")) {
		return value === pattern;
	}

	const prefix = pattern.slice(0, pattern.indexOf("*"));
	return value.startsWith(prefix);
}

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
