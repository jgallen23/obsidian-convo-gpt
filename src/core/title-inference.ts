import { buildRetitledBasename } from "./note-title";
import type { AITraceCollector } from "./ai-trace";
import type { ChatMessage } from "./types";

interface TitleInferenceClient {
	create(
		messages: ChatMessage[],
		options?: { signal?: AbortSignal; traceCollector?: AITraceCollector; traceLabel?: string },
	): Promise<{ text: string }>;
}

interface InferRetitledBasenameParams {
	currentBasename: string;
	noteContent: string;
	agentBody: string;
	defaultSystemPrompt: string;
	systemCommands: string[];
	signal?: AbortSignal;
	traceCollector?: AITraceCollector;
	traceLabel?: string;
}

export async function inferRetitledBasename(
	client: TitleInferenceClient,
	params: InferRetitledBasenameParams,
): Promise<string> {
	const completion = await client.create(
		buildTitleMessages(params.noteContent, params.agentBody, params.defaultSystemPrompt, params.systemCommands),
		{ signal: params.signal, traceCollector: params.traceCollector, traceLabel: params.traceLabel },
	);
	return buildRetitledBasename(params.currentBasename, completion.text);
}

export function buildTitleMessages(
	noteContent: string,
	agentBody: string,
	defaultSystemPrompt: string,
	systemCommands: string[],
): ChatMessage[] {
	const messages: ChatMessage[] = [];

	if (defaultSystemPrompt.trim()) {
		messages.push({
			role: "system",
			content: defaultSystemPrompt.trim(),
		});
	}

	if (agentBody.trim()) {
		messages.push({
			role: "system",
			content: agentBody.trim(),
		});
	}

	for (const command of systemCommands) {
		if (command.trim()) {
			messages.push({
				role: "system",
				content: command.trim(),
			});
		}
	}

	messages.push({
		role: "system",
		content:
			"Return only a concise note title suitable for an Obsidian filename. Do not include a date prefix, file extension, quotes, markdown, labels, or explanation.",
	});
	messages.push({
		role: "user",
		content: `Infer a short, descriptive title for this note.\n\n<note>\n${noteContent.trim()}\n</note>`,
	});

	return messages;
}
