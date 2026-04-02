import { describe, expect, it } from "vitest";
import { buildRetitledBasename, normalizeGeneratedTitle } from "../core/note-title";

describe("note title helpers", () => {
	it("preserves a leading date prefix when retitling", () => {
		expect(buildRetitledBasename("2026-04-02 - Daily Scratchpad", "Project kickoff notes")).toBe(
			"2026-04-02 - Project kickoff notes",
		);
	});

	it("replaces a title without a date prefix directly", () => {
		expect(buildRetitledBasename("Scratchpad", "Project kickoff notes")).toBe("Project kickoff notes");
	});

	it("does not duplicate a date prefix returned by the model", () => {
		expect(buildRetitledBasename("2026-04-02 - Daily Scratchpad", "2026-04-02 - Project kickoff notes")).toBe(
			"2026-04-02 - Project kickoff notes",
		);
	});

	it("strips wrapping quotes, heading markers, trailing punctuation, and forbidden path characters", () => {
		expect(normalizeGeneratedTitle('  "# Launch / Plan: v2?!"  ')).toBe("Launch Plan v2");
	});

	it("rejects empty titles after normalization", () => {
		expect(() => buildRetitledBasename("2026-04-02 - Daily Scratchpad", '""')).toThrow(
			"Convo GPT could not infer a valid title.",
		);
	});
});
