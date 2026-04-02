import { describe, expect, it } from "vitest";
import { formatWebSearchSources, supportsOpenAINativeWebSearch } from "../core/openai-native-web-search";

describe("OpenAI native web search helpers", () => {
	it("matches supported model families", () => {
		expect(supportsOpenAINativeWebSearch("gpt-5.4")).toBe(true);
		expect(supportsOpenAINativeWebSearch("gpt-4.1-nano")).toBe(false);
	});

	it("formats sources into a markdown appendix", () => {
		expect(
			formatWebSearchSources([
				{ title: "OpenAI", url: "https://openai.com" },
				{ title: "OpenAI", url: "https://openai.com" },
			]),
		).toContain("### Sources");
	});
});
