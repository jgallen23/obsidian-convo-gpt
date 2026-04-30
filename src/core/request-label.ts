import type { ResolvedChatConfig } from "./types";

export function formatRequestModelLabel(config: Pick<ResolvedChatConfig, "model" | "reasoning_effort" | "temperature">): string {
	const details: string[] = [];

	if (config.reasoning_effort !== "none") {
		details.push(`reasoning: ${config.reasoning_effort}`);
	}

	if (config.temperature !== undefined) {
		details.push(`temperature: ${config.temperature}`);
	}

	if (details.length === 0) {
		return config.model;
	}

	return `${config.model} (${details.join(", ")})`;
}
