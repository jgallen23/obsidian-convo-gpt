import { CHAT_HEADING_PREFIX, CHAT_SEPARATOR } from "./constants";

const ASSISTANT_HEADING_REGEX = /(^|\n)\s*(?:#{1,6}\s+_?AI(?:\s+\d+|\s+\(\d+\))_?|#{1,6}\s+role::assistant\b)/gim;

export function getNextExchangeId(text: string): string {
	return String(Array.from(text.matchAll(ASSISTANT_HEADING_REGEX)).length + 1);
}

export function buildAssistantPrefix(_model: string, exchangeId: string): string {
	return [
		"",
		"",
		CHAT_SEPARATOR,
		"",
		buildAssistantHeading(exchangeId),
		"",
	].join("\n");
}

export function buildAssistantSuffix(exchangeId: string, includeTopLink: boolean): string {
	const nextUserId = String(Number(exchangeId) + 1);

	const lines = [""];

	if (includeTopLink) {
		lines.push(`[[#_AI (${exchangeId})_|Top of answer]]`, "");
	}

	lines.push(CHAT_SEPARATOR, buildUserHeading(nextUserId), "", "");
	return lines.join("\n");
}

export function buildAssistantHeading(exchangeId: string): string {
	return `${CHAT_HEADING_PREFIX} _AI (${exchangeId})_`;
}

export function buildUserHeading(exchangeId: string): string {
	return `${CHAT_HEADING_PREFIX} _You (${exchangeId})_`;
}
