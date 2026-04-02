import { CHAT_SEPARATOR } from "./constants";
import type { ChatRole, ParsedSection } from "./types";

const ROLE_HEADING_REGEX = /^\s*(?:<a id="[^"]+"><\/a>\s*)*(#{1,6})\s+role::(assistant|system|user)\b[^\n]*\n?([\s\S]*)$/i;
const MODERN_ROLE_HEADING_REGEX = /^\s*(#{1,6})\s+_?(AI|System|You)(?:\s+\d+|\s+\(\d+\))?_?\s*\n?([\s\S]*)$/i;
const ASSISTANT_TOP_LINK_REGEX = /\n*\[\[#_?AI(?: \d+| \(\d+\))_?\|Top of answer\]\]\s*$/;

export function parseSections(body: string): ParsedSection[] {
	const sections: ParsedSection[] = [];
	let cursor = 0;

	if (body.length === 0) {
		return [];
	}

	while (cursor <= body.length) {
		const separatorIndex = body.indexOf(CHAT_SEPARATOR, cursor);
		const endOffset = separatorIndex === -1 ? body.length : separatorIndex;
		const raw = body.slice(cursor, endOffset);
		sections.push(parseSection(raw, cursor, endOffset));

		if (separatorIndex === -1) {
			break;
		}

		cursor = separatorIndex + CHAT_SEPARATOR.length;
	}

	return sections;
}

export function parseSection(raw: string, startOffset: number, endOffset: number): ParsedSection {
	const trimmedLeading = raw.replace(/^\s+/, "");
	const legacyMatch = trimmedLeading.match(ROLE_HEADING_REGEX);
	if (legacyMatch) {
		const role = legacyMatch[2].toLowerCase() as ChatRole;
		return {
			role,
			content: sanitizeSectionContent(role, legacyMatch[3]),
			raw,
			startOffset,
			endOffset,
		};
	}

	const modernMatch = trimmedLeading.match(MODERN_ROLE_HEADING_REGEX);
	if (modernMatch) {
		const role = mapModernHeadingToRole(modernMatch[2]);
		return {
			role,
			content: sanitizeSectionContent(role, modernMatch[3]),
			raw,
			startOffset,
			endOffset,
		};
	}

	return {
		role: "user",
		content: raw.trim(),
		raw,
		startOffset,
		endOffset,
	};
}

export function splitMessages(text: string | undefined): string[] {
	return text ? text.split(CHAT_SEPARATOR) : [];
}

function sanitizeSectionContent(role: ChatRole, content: string): string {
	if (role !== "assistant") {
		return content.trim();
	}

	return content.replace(ASSISTANT_TOP_LINK_REGEX, "").trim();
}

function mapModernHeadingToRole(label: string): ChatRole {
	switch (label.toLowerCase()) {
		case "ai":
			return "assistant";
		case "system":
			return "system";
		case "you":
		default:
			return "user";
	}
}
