import { describe, expect, it } from "vitest";
import {
	normalizeReferencedFileExtensions,
	parseNoteDocument,
	parseNoteOverrides,
	persistLastSavedMarkdownPath,
	sanitizeSettings,
	stripFrontmatter,
} from "../core/frontmatter";
import { DEFAULT_SYSTEM_PROMPT } from "../core/constants";

describe("frontmatter helpers", () => {
	it("parses note overrides and strips the frontmatter from the body", () => {
		const text = `---
model: openai@gpt-5.4
temperature: 0.4
system_commands:
  - Be concise
---
# role::user

Hello`;

		const parsed = parseNoteDocument(text);
		expect(parsed.overrides.model).toBe("openai@gpt-5.4");
		expect(parsed.overrides.temperature).toBe(0.4);
		expect(parsed.overrides.system_commands).toEqual(["Be concise"]);
		expect(parsed.body.trim()).toContain("# role::user");
		expect(parsed.bodyStartOffset).toBeGreaterThan(0);
	});

	it("coerces string system commands to arrays", () => {
		expect(parseNoteOverrides({ system_commands: "Test" }).system_commands).toEqual(["Test"]);
	});

	it("sanitizes settings with defaults", () => {
		const settings = sanitizeSettings({});
		expect(settings.defaultModel).toBe("openai@gpt-5.4");
		expect(settings.enableOpenAINativeWebSearch).toBe(true);
		expect(settings.enableMarkdownFileTool).toBe(true);
		expect(settings.enableReferencedFileReadTool).toBe(true);
		expect(settings.referencedFileExtensions).toEqual(["md", "txt", "csv", "json", "yaml"]);
		expect(settings.agentFolder).toBe("");
		expect(settings.defaultSystemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
	});

	it("strips frontmatter from content", () => {
		expect(stripFrontmatter("---\na: 1\n---\nBody")).toBe("Body");
	});

	it("preserves an explicitly blank agent folder", () => {
		const settings = sanitizeSettings({ agentFolder: "" });
		expect(settings.agentFolder).toBe("");
	});

	it("persists and parses the last saved markdown path", () => {
		const updated = persistLastSavedMarkdownPath("# _You 1_\n\nHello", "Stories/story.md");
		const parsed = parseNoteDocument(updated);
		expect(parsed.lastSavedMarkdownPath).toBe("Stories/story.md");
		expect(parsed.body).toContain("# _You 1_");
	});

	it("normalizes referenced file extensions", () => {
		expect(normalizeReferencedFileExtensions([".MD", " txt ", "", "json", "md"])).toEqual(["md", "txt", "json"]);
	});
});
