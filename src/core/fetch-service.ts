import { createOpenAIFetchAdapter } from "./openai-fetch";
import { parseFetchRequest, type FetchToolResult } from "./fetch-tool";

const MAX_FETCH_BODY_CHARS = 12000;

export async function executeFetchToolCall(
	argumentsJson: string,
	fetchImpl: typeof fetch = createOpenAIFetchAdapter(),
): Promise<FetchToolResult> {
	const parsed = parseFetchRequest(argumentsJson);
	if (!parsed.success) {
		return {
			status: "validation_error",
			message: parsed.error,
		};
	}

	try {
		const response = await fetchImpl(parsed.data.url, {
			method: parsed.data.method,
			headers: normalizeRequestHeaders(parsed.data.headers),
			body: parsed.data.body,
		});
		const rawBody = parsed.data.method === "HEAD" ? "" : await response.text();
		const truncated = rawBody.length > MAX_FETCH_BODY_CHARS;
		const bodyText = truncated ? `${rawBody.slice(0, MAX_FETCH_BODY_CHARS)}\n…` : rawBody;

		return {
			status: "success",
			message: `Fetched ${parsed.data.method} ${response.url || parsed.data.url} with status ${response.status}.`,
			url: parsed.data.url,
			finalUrl: response.url || parsed.data.url,
			method: parsed.data.method,
			statusCode: response.status,
			statusText: response.statusText,
			headers: normalizeResponseHeaders(response.headers),
			bodyText,
			truncated,
		};
	} catch (error) {
		return {
			status: "request_error",
			message: error instanceof Error ? error.message : "Request failed.",
			url: parsed.data.url,
			method: parsed.data.method,
		};
	}
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
	const normalized: Record<string, string> = {};
	headers.forEach((value, key) => {
		normalized[key] = value;
	});
	return normalized;
}

function normalizeRequestHeaders(headers: Array<{ name: string; value: string }>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const header of headers) {
		normalized[header.name] = header.value;
	}
	return normalized;
}
