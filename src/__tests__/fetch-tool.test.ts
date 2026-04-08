import { describe, expect, it } from "vitest";
import {
	buildFetchToolPolicy,
	formatFetchAppendix,
	parseFetchRequest,
	shouldOfferFetchTool,
} from "../core/fetch-tool";

describe("fetch tool", () => {
	it("offers the tool for explicit API requests", () => {
		expect(shouldOfferFetchTool("Call https://api.example.com/users with an Authorization header.", true)).toBe(true);
	});

	it("does not offer the tool for a bare url without explicit fetch intent", () => {
		expect(shouldOfferFetchTool("https://api.example.com/users", true)).toBe(false);
	});

	it("does not offer the tool without an explicit url", () => {
		expect(shouldOfferFetchTool("What's a good public JSON API I can hit?", true)).toBe(false);
	});

	it("does not offer the tool for a general web lookup with a url", () => {
		expect(shouldOfferFetchTool("Summarize https://example.com for me.", true)).toBe(false);
	});

	it("does not offer the tool for plain writing requests", () => {
		expect(shouldOfferFetchTool("Write me a story about the moon.", true)).toBe(false);
	});

	it("parses valid POST requests", () => {
		expect(
			parseFetchRequest(
				JSON.stringify({
					url: "https://api.example.com/users",
					method: "post",
					headers: [{ name: "Authorization", value: "Bearer token" }],
					body: '{"name":"Ada"}',
				}),
			),
		).toEqual({
			success: true,
			data: {
				url: "https://api.example.com/users",
				method: "POST",
				headers: [{ name: "Authorization", value: "Bearer token" }],
				body: '{"name":"Ada"}',
			},
		});
	});

	it("rejects unsupported URL schemes", () => {
		const result = parseFetchRequest(
			JSON.stringify({
				url: "ftp://example.com/data",
				method: "GET",
				headers: [],
				body: null,
			}),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("Unsupported URL scheme");
		}
	});

	it("builds a compact appendix", () => {
		expect(
			formatFetchAppendix([
				{ method: "GET", url: "https://api.example.com/users", statusCode: 200, truncated: false },
				{ method: "GET", url: "https://api.example.com/users", statusCode: 200, truncated: false },
			]),
		).toContain("### Fetch calls");
		expect(buildFetchToolPolicy()).toContain("HTTP fetch tool policy");
	});
});
