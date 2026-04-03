import type { FunctionTool } from "openai/resources/responses/responses";
import { z } from "zod";

export const FETCH_TOOL_NAME = "fetch";

const FETCH_METHODS = ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"] as const;
const URL_REGEX = /\bhttps?:\/\/[^\s)]+/i;

export interface FetchHeader {
	name: string;
	value: string;
}

export interface FetchRequest {
	body?: string;
	headers: FetchHeader[];
	method: (typeof FETCH_METHODS)[number];
	url: string;
}

export interface FetchToolResult {
	status: "request_error" | "success" | "validation_error";
	message: string;
	bodyText?: string;
	finalUrl?: string;
	headers?: Record<string, string>;
	method?: string;
	statusCode?: number;
	statusText?: string;
	truncated?: boolean;
	url?: string;
}

export interface FetchSummary {
	method: string;
	statusCode: number;
	truncated: boolean;
	url: string;
}

const fetchRequestSchema = z
	.object({
		url: z.string().url(),
		method: z.string().transform((value) => value.trim().toUpperCase()),
		headers: z
			.array(
				z.object({
					name: z.string().min(1),
					value: z.string(),
				}),
			)
			.default([]),
		body: z.string().nullable().optional(),
	})
	.superRefine((value, ctx) => {
		if (!FETCH_METHODS.includes(value.method as (typeof FETCH_METHODS)[number])) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Unsupported method: ${value.method}`,
				path: ["method"],
			});
		}

		const hasBody = typeof value.body === "string" && value.body.length > 0;
		if (hasBody && (value.method === "GET" || value.method === "HEAD")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${value.method} requests cannot include a body`,
				path: ["body"],
			});
		}
	});

export function shouldOfferFetchTool(message: string, enabled: boolean): boolean {
	if (!enabled) {
		return false;
	}

	return URL_REGEX.test(message);
}

export function getFetchToolDefinition(): FunctionTool {
	return {
		type: "function",
		name: FETCH_TOOL_NAME,
		description: "Make an outbound HTTP request with an explicit method, headers, and optional text body.",
		strict: true,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: {
					type: "string",
					description: "The full http:// or https:// URL to request.",
				},
				method: {
					type: "string",
					enum: [...FETCH_METHODS],
					description: "The HTTP method to use.",
				},
				headers: {
					type: "array",
					description: "Request headers to send. Use [] when no headers are needed.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: {
								type: "string",
								description: "Header name, such as Authorization or Content-Type.",
							},
							value: {
								type: "string",
								description: "Header value.",
							},
						},
						required: ["name", "value"],
					},
				},
				body: {
					type: ["string", "null"],
					description: "Optional text request body. Set to null when there is no body.",
				},
			},
			required: ["url", "method", "headers", "body"],
		},
	};
}

export function buildFetchToolPolicy(): string {
	return [
		"HTTP fetch tool policy:",
		"- Use fetch for outbound HTTP or HTTPS calls to APIs and webpages.",
		"- Supported methods are GET, POST, PUT, PATCH, DELETE, and HEAD.",
		"- You may set request headers explicitly, including Authorization.",
		"- Response bodies may be truncated.",
		"- Never claim a request succeeded unless fetch returned status success in this turn.",
	].join("\n");
}

export function formatFetchAppendix(calls: FetchSummary[]): string {
	if (calls.length === 0) {
		return "";
	}

	const seen = new Set<string>();
	const lines: string[] = [];

	for (const call of calls) {
		const key = `${call.method} ${call.url} ${call.statusCode} ${call.truncated}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		lines.push(
			`${lines.length + 1}. ${call.method} [${escapeMarkdownLinkText(call.url)}](${call.url}) -> ${call.statusCode}${call.truncated ? " (truncated)" : ""}`,
		);
	}

	if (lines.length === 0) {
		return "";
	}

	return `\n\n### Fetch calls\n${lines.join("\n")}`;
}

export function parseFetchRequest(argumentsJson: string): { data: FetchRequest; success: true } | { error: string; success: false } {
	try {
		const parsedJson = JSON.parse(argumentsJson) as unknown;
		const parsed = fetchRequestSchema.safeParse(parsedJson);
		if (!parsed.success) {
			const [issue] = parsed.error.issues;
			return {
				success: false,
				error: issue?.message ?? "Invalid fetch request.",
			};
		}

		const url = new URL(parsed.data.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return {
				success: false,
				error: `Unsupported URL scheme: ${url.protocol}`,
			};
		}

		return {
			success: true,
			data: {
				url: url.toString(),
				method: parsed.data.method as FetchRequest["method"],
				headers: parsed.data.headers,
				body: parsed.data.body ?? undefined,
			},
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Invalid JSON arguments.",
		};
	}
}

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
