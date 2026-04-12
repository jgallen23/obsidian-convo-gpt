import { describe, expect, it } from "vitest";
import {
	normalizeReferencedFileExtensions,
	parseNoteDocument,
	parseNoteOverrides,
	setNoteFrontmatterField,
	sanitizeSettings,
	stripFrontmatter,
} from "../core/frontmatter";
import { DEFAULT_SYSTEM_PROMPT } from "../core/constants";

describe("frontmatter helpers", () => {
	it("parses note overrides and strips the frontmatter from the body", () => {
		const text = `---
model: openai@gpt-5.4
temperature: 0.4
document: "[[Drafts/Proposal]]"
system_commands:
  - Be concise
---
# role::user

Hello`;

		const parsed = parseNoteDocument(text);
		expect(parsed.overrides.model).toBe("openai@gpt-5.4");
		expect(parsed.overrides.temperature).toBe(0.4);
		expect(parsed.overrides.document).toBe("[[Drafts/Proposal]]");
		expect(parsed.overrides.system_commands).toEqual(["Be concise"]);
		expect(parsed.body.trim()).toContain("# role::user");
		expect(parsed.bodyStartOffset).toBeGreaterThan(0);
	});

	it("coerces string system commands to arrays", () => {
		expect(parseNoteOverrides({ system_commands: "Test" }).system_commands).toEqual(["Test"]);
	});

	it("preserves document when sibling frontmatter fields are blank", () => {
		expect(
			parseNoteOverrides({
				agent: null,
				document: "[[list of jokes.md]]",
			}).document,
		).toBe("[[list of jokes.md]]");
	});

	it("sanitizes settings with defaults", () => {
		const settings = sanitizeSettings({});
		expect(settings.defaultModel).toBe("openai@gpt-5.4");
		expect(settings.enableOpenAINativeWebSearch).toBe(true);
		expect(settings.enableFetchTool).toBe(true);
		expect(settings.enableMarkdownFileTool).toBe(true);
		expect(settings.enableReferencedFileReadTool).toBe(true);
		expect(settings.enableDebugLogging).toBe(false);
		expect(settings.referencedFileExtensions).toEqual(["md", "txt", "csv", "json", "yaml"]);
		expect(settings.agentFolder).toBe("");
		expect(settings.chatsFolder).toBe("chats/");
		expect(settings.defaultSystemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
	});

	it("strips frontmatter from content", () => {
		expect(stripFrontmatter("---\na: 1\n---\nBody")).toBe("Body");
	});

	it("preserves an explicitly blank agent folder", () => {
		const settings = sanitizeSettings({ agentFolder: "" });
		expect(settings.agentFolder).toBe("");
	});

	it("normalizes referenced file extensions", () => {
		expect(normalizeReferencedFileExtensions([".MD", " txt ", "", "json", "md"])).toEqual(["md", "txt", "json"]);
	});

	it("adds or updates a frontmatter field", () => {
		expect(setNoteFrontmatterField("# Body", "document", "[[Drafts/Proposal]]")).toContain("document:");
		expect(setNoteFrontmatterField("# Body", "document", "[[Drafts/Proposal]]")).toContain("[[Drafts/Proposal]]");
		expect(setNoteFrontmatterField("---\nmodel: openai@gpt-5.4\n---\nBody", "document", "[[Drafts/Proposal]]")).toContain(
			"[[Drafts/Proposal]]",
		);
	});

	it("builds linked document prompt and policy text", async () => {
		const {
			buildLinkedDocumentSystemPrompt,
			buildLinkedDocumentToolPolicy,
			linkifyLinkedDocumentMentions,
		} = await import("../core/document-mode");
		expect(linkifyLinkedDocumentMentions("Done — wrote it to `document test/doc.md`.", "document test/doc.md")).toBe(
			"Done — wrote it to [[document test/doc]].",
		);
		expect(
			buildLinkedDocumentSystemPrompt({
				path: "document test/doc.md",
				content: "",
				exists: false,
				shouldAutoWrite: true,
			}),
		).toContain("do not stop at a draft-in-chat response");
		expect(
			buildLinkedDocumentToolPolicy({
				path: "document test/doc.md",
				content: "",
				exists: false,
				shouldAutoWrite: true,
			}),
		).toContain("you must call save_markdown_file before giving the final answer");
	});
});
