import { describe, expect, it } from "vitest";
import { CHAT_SEPARATOR } from "../core/constants";
import { parseSections, splitMessages } from "../core/message-parser";

describe("message parser", () => {
	it("splits messages on the configured separator", () => {
		const text = `One${CHAT_SEPARATOR}Two`;
		expect(splitMessages(text)).toEqual(["One", "Two"]);
	});

	it("parses explicit role headings", () => {
		const sections = parseSections(`# role::user\n\nHello${CHAT_SEPARATOR}\n# role::assistant [openai@gpt-5.4]\n\nHi`);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.role).toBe("user");
		expect(sections[0]?.content).toBe("Hello");
		expect(sections[1]?.role).toBe("assistant");
		expect(sections[1]?.content).toBe("Hi");
	});

	it("strips assistant anchor chrome from parsed content", () => {
		const sections = parseSections(
			`# _AI (1)_\n\nHello there\n\n[[#_AI (1)_|Top of answer]]`,
		);
		expect(sections[0]?.role).toBe("assistant");
		expect(sections[0]?.content).toBe("Hello there");
	});

	it("parses modern AI and You headings", () => {
		const sections = parseSections(`# _You (1)_\n\nPrompt${CHAT_SEPARATOR}\n# _AI (1)_\n\nResponse`);
		expect(sections[0]?.role).toBe("user");
		expect(sections[0]?.content).toBe("Prompt");
		expect(sections[1]?.role).toBe("assistant");
		expect(sections[1]?.content).toBe("Response");
	});

	it("keeps backward compatibility with unparenthesized modern headings", () => {
		const sections = parseSections(`# _You 1_\n\nPrompt${CHAT_SEPARATOR}\n# _AI 1_\n\nResponse`);
		expect(sections[0]?.role).toBe("user");
		expect(sections[1]?.role).toBe("assistant");
	});

	it("defaults plain sections to user messages", () => {
		const sections = parseSections("Plain prompt");
		expect(sections[0]?.role).toBe("user");
		expect(sections[0]?.content).toBe("Plain prompt");
	});
});
