import { describe, expect, it } from "vitest";
import { getBlankAgentFolderNotice } from "../core/agent-notices";

describe("agent resolver", () => {
	it("returns a notice message when agent folder is blank", () => {
		expect(getBlankAgentFolderNotice("", "writer")).toBe(
			'Convo GPT agent folder is not configured; skipping agent "writer".',
		);
	});

	it("returns a notice message when agent folder is whitespace", () => {
		expect(getBlankAgentFolderNotice("   ", "writer")).toBe(
			'Convo GPT agent folder is not configured; skipping agent "writer".',
		);
	});

	it("does not return a notice when agent folder is configured", () => {
		expect(getBlankAgentFolderNotice("Agents", "writer")).toBeNull();
	});
});
