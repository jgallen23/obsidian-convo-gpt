import { describe, expect, it, vi } from "vitest";
import { PluginRequestStatusManager } from "../core/request-status";

describe("PluginRequestStatusManager", () => {
	it("updates the status bar on desktop", () => {
		const setText = vi.fn();
		const manager = new PluginRequestStatusManager({ setText }, false, vi.fn());

		manager.setCalling("openai@gpt-5.4");
		manager.setWaitingForRenameApproval();
		manager.setStreaming("openai@gpt-5.4");
		manager.setWebSearch();
		manager.setWaitingForFileApproval();
		manager.setSaving("story.md");
		manager.clear();

		expect(setText).toHaveBeenNthCalledWith(1, "Calling openai@gpt-5.4");
		expect(setText).toHaveBeenNthCalledWith(2, "Waiting for rename approval");
		expect(setText).toHaveBeenNthCalledWith(3, "Streaming openai@gpt-5.4");
		expect(setText).toHaveBeenNthCalledWith(4, "Searching the web");
		expect(setText).toHaveBeenNthCalledWith(5, "Waiting for file approval");
		expect(setText).toHaveBeenNthCalledWith(6, "Saving to story.md");
		expect(setText).toHaveBeenNthCalledWith(7, "");
	});

	it("uses a mobile notice only for request start", () => {
		const setText = vi.fn();
		const notify = vi.fn();
		const manager = new PluginRequestStatusManager({ setText }, true, notify);

		manager.notifyRequestStart("Calling openai@gpt-5.4");
		manager.setCalling("openai@gpt-5.4");
		manager.setStreaming("openai@gpt-5.4");
		manager.clear();

		expect(notify).toHaveBeenCalledWith("Convo GPT: Calling openai@gpt-5.4");
		expect(setText).toHaveBeenCalledWith("");
		expect(setText).toHaveBeenCalledTimes(1);
	});
});
