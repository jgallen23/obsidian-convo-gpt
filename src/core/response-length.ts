export function shouldShowTopOfAnswerLink(responseText: string): boolean {
	return countParagraphs(responseText) >= 3;
}

function countParagraphs(responseText: string): number {
	const trimmed = responseText.replace(/\r\n/g, "\n").trim();
	if (!trimmed) {
		return 0;
	}

	return trimmed
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0).length;
}
