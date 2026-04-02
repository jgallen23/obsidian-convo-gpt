import { describe, expect, it } from "vitest";
import {
	buildMarkdownFileToolPolicy,
	buildMarkdownWritePreview,
	parseMarkdownWriteRequest,
	resolveMarkdownVaultPath,
	shouldOfferMarkdownFileTool,
} from "../core/markdown-file-tool";

describe("markdown file tool", () => {
	it("offers the tool for direct markdown save requests", () => {
		expect(shouldOfferMarkdownFileTool("Tell me a story and save it to story.md", true)).toBe(true);
	});

	it("does not offer the tool for plain writing requests", () => {
		expect(shouldOfferMarkdownFileTool("Write me a story about the moon.", true)).toBe(false);
	});

	it("offers the tool for follow-up continuation requests when a markdown target is remembered", () => {
		expect(shouldOfferMarkdownFileTool("Add another joke.", true, "story.md")).toBe(true);
	});

	it("does not offer the tool for follow-up continuation requests without a remembered target", () => {
		expect(shouldOfferMarkdownFileTool("Add another joke.", true)).toBe(false);
	});

	it("parses valid create requests", () => {
		expect(
			parseMarkdownWriteRequest(JSON.stringify({ path: "story.md", operation: "create", content: "# Story" })),
		).toEqual({
			success: true,
			data: {
				path: "story.md",
				operation: "create",
				content: "# Story",
			},
		});
	});

	it("rejects edit requests without instructions", () => {
		const result = parseMarkdownWriteRequest(JSON.stringify({ path: "story.md", operation: "edit" }));
		expect(result.success).toBe(false);
	});

	it("normalizes relative markdown vault paths", () => {
		expect(resolveMarkdownVaultPath("./Stories\\story.md")).toEqual({
			success: true,
			path: "Stories/story.md",
		});
	});

	it("rejects non-markdown paths", () => {
		expect(resolveMarkdownVaultPath("story.txt")).toEqual({
			success: false,
			error: "Only .md files are supported.",
		});
	});

	it("builds truncated previews", () => {
		expect(buildMarkdownWritePreview("a".repeat(900))).toContain("…");
	});

	it("builds policy text that includes the remembered target", () => {
		expect(buildMarkdownFileToolPolicy("story.md")).toContain("story.md");
		expect(buildMarkdownFileToolPolicy("story.md")).toContain("Never claim content was saved");
	});
});
