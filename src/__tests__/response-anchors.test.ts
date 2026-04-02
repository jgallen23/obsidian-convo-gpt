import { describe, expect, it } from "vitest";
import {
	buildAssistantHeading,
	buildAssistantPrefix,
	buildAssistantSuffix,
	buildUserHeading,
	getNextExchangeId,
} from "../core/response-anchors";

describe("response anchors", () => {
	it("increments exchange ids based on assistant headings", () => {
		expect(getNextExchangeId("# _AI 1_\n\nText\n<hr class=\"__convo_gpt__\">\n# _You 2_")).toBe("2");
	});

	it("builds AI and You headings with a heading link footer", () => {
		expect(buildAssistantHeading("1")).toBe("# _AI 1_");
		expect(buildUserHeading("2")).toBe("# _You 2_");
		expect(buildAssistantPrefix("openai@gpt-5.4", "1")).toContain(
			"# _AI 1_",
		);
		expect(buildAssistantSuffix("1", true)).toContain("[[#_AI 1_|Top of answer]]");
		expect(buildAssistantSuffix("1", true)).toContain("# _You 2_");
		expect(buildAssistantSuffix("1", true)).toContain("\n\n<hr class=\"__convo_gpt__\">\n# _You 2_");
		expect(buildAssistantSuffix("1", true)).not.toContain("\n\n\n<hr class=\"__convo_gpt__\">");
		expect(buildAssistantSuffix("1", true)).not.toContain("Jump to prompt");
	});

	it("omits the footer link while preserving spacing when disabled", () => {
		expect(buildAssistantSuffix("1", false)).not.toContain("Top of answer");
		expect(buildAssistantSuffix("1", false)).toContain("\n<hr class=\"__convo_gpt__\">\n# _You 2_");
	});
});
