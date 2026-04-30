import { describe, expect, it } from "vitest";
import { formatRequestModelLabel } from "../core/request-label";

describe("formatRequestModelLabel", () => {
	it("returns the bare model when neither reasoning nor temperature is set", () => {
		expect(
			formatRequestModelLabel({
				model: "openai@gpt-5.4",
				reasoning_effort: "none",
				temperature: undefined,
			}),
		).toBe("openai@gpt-5.4");
	});

	it("includes reasoning and temperature when set", () => {
		expect(
			formatRequestModelLabel({
				model: "openai@gpt-5.4",
				reasoning_effort: "high",
				temperature: 0.2,
			}),
		).toBe("openai@gpt-5.4 (reasoning: high, temperature: 0.2)");
	});

	it("includes only temperature when reasoning is none", () => {
		expect(
			formatRequestModelLabel({
				model: "openai@gpt-5.4",
				reasoning_effort: "none",
				temperature: 0.2,
			}),
		).toBe("openai@gpt-5.4 (temperature: 0.2)");
	});
});
