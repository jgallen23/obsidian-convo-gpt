import { describe, expect, it } from "vitest";
import { findNoteReferences, injectReferencedNoteContext } from "../core/context-resolver";

describe("context resolver", () => {
	it("finds wiki links and markdown note links", () => {
		const refs = findNoteReferences("[[Note]] and [Other](folder/file)");
		expect(refs).toHaveLength(2);
		expect(refs[0]?.path).toBe("Note");
		expect(refs[1]?.path).toBe("folder/file");
	});

	it("deduplicates references and ignores external urls", () => {
		const refs = findNoteReferences("[[Note]] [Link](https://example.com) [[Note]]");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.path).toBe("Note");
	});

	it("ignores anchor links", () => {
		const refs = findNoteReferences("[[Note#Heading]] and [Other](folder/file#section) and [Here](#local-anchor)");
		expect(refs).toEqual([]);
	});

	it("ignores uri-scheme links like mailto and obsidian", () => {
		const refs = findNoteReferences("[Email](mailto:test@example.com) [Open](obsidian://open?vault=JGA) [[Note]]");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.path).toBe("Note");
	});

	it("ignores wiki and markdown links inside fenced code blocks", () => {
		const refs = findNoteReferences([
			"Use [[Outside]].",
			"",
			"```md",
			"[[Inside Wiki]]",
			"[Inside Markdown](Docs/inside.md)",
			"```",
			"",
			"And [Outside Markdown](Docs/outside.md).",
		].join("\n"));

		expect(refs).toHaveLength(2);
		expect(refs[0]?.path).toBe("Outside");
		expect(refs[1]?.path).toBe("Docs/outside.md");
	});

	it("ignores links inside tilde-fenced code blocks", () => {
		const refs = findNoteReferences([
			"~~~",
			"[[Inside Only]]",
			"~~~",
			"",
			"[[Outside Only]]",
		].join("\n"));

		expect(refs).toHaveLength(1);
		expect(refs[0]?.path).toBe("Outside Only");
	});

	it("injects referenced note context relative to the current file", async () => {
		const agentFile = { path: "Agents/writer.md" };
		const styleGuideFile = { path: "Agents/Style Guide.md" };
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string, currentPath: string) => {
					if (path === "Style Guide" && currentPath === "Agents/writer.md") {
						return styleGuideFile;
					}
					return null;
				},
			},
			vault: {
				read: async (file: { path: string }) => {
					if (file.path === "Agents/Style Guide.md") {
						return "---\ntitle: Style Guide\n---\nUse active voice.";
					}
					return "";
				},
			},
		};

		const result = await injectReferencedNoteContext(
			app as never,
			agentFile as never,
			"Follow [[Style Guide]]",
		);

		expect(result.missingReferences).toEqual([]);
		expect(result.content).toContain("Referenced note: [[Style Guide]]");
		expect(result.content).toContain("Path: Agents/Style Guide.md");
		expect(result.content).toContain("Use active voice.");
		expect(result.content).not.toContain("title: Style Guide");
	});

	it("reports missing references without recursive expansion", async () => {
		const agentFile = { path: "Agents/writer.md" };
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (path: string) => {
					if (path === "Existing") {
						return { path: "Agents/Existing.md" };
					}
					return null;
				},
			},
			vault: {
				read: async () => "Keep [[Nested]] as-is.",
			},
		};

		const result = await injectReferencedNoteContext(
			app as never,
			agentFile as never,
			"Use [[Existing]] and [[Missing]]",
		);

		expect(result.missingReferences).toEqual(["Missing"]);
		expect(result.content).toContain("Keep [[Nested]] as-is.");
	});
});
