import { describe, expect, it } from "vitest";
import { shouldShowTopOfAnswerLink } from "../core/response-length";

describe("shouldShowTopOfAnswerLink", () => {
	it("does not show the link for one paragraph", () => {
		expect(shouldShowTopOfAnswerLink("Short response.")).toBe(false);
	});

	it("does not show the link for two paragraphs", () => {
		expect(shouldShowTopOfAnswerLink("First paragraph.\n\nSecond paragraph.")).toBe(false);
	});

	it("shows the link for three paragraphs", () => {
		expect(shouldShowTopOfAnswerLink("One.\n\nTwo.\n\nThree.")).toBe(true);
	});

	it("ignores empty paragraphs", () => {
		expect(shouldShowTopOfAnswerLink("One.\n\n \n\nTwo.\n\nThree.")).toBe(true);
	});
});
