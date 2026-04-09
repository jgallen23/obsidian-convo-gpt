import { describe, expect, it, vi } from "vitest";
import { PluginRequestStatusManager } from "../core/request-status";

describe("PluginRequestStatusManager", () => {
	it("updates the status bar on desktop and keeps the request notice open until clear", () => {
		const setText = vi.fn();
		const hidePersistentNotice = vi.fn();
		const createNotice = vi
			.fn()
			.mockReturnValueOnce({ hide: hidePersistentNotice })
			.mockReturnValue({ hide: vi.fn() });
		const manager = new PluginRequestStatusManager({ setText }, false, createNotice);

		manager.notifyRequestStart("Calling openai@gpt-5.4");
		manager.setCalling("openai@gpt-5.4");
		manager.setWaitingForRenameApproval();
		manager.setStreaming("openai@gpt-5.4");
		manager.setWebSearch();
		manager.setWaitingForFileApproval();
		manager.setSaving("story.md");
		manager.notifyToolUse("Using web search");
		manager.clear();

		expect(setText).toHaveBeenNthCalledWith(1, "Calling openai@gpt-5.4");
		expect(setText).toHaveBeenNthCalledWith(2, "Waiting for rename approval");
		expect(setText).toHaveBeenNthCalledWith(3, "Streaming openai@gpt-5.4");
		expect(setText).toHaveBeenNthCalledWith(4, "Searching the web");
		expect(setText).toHaveBeenNthCalledWith(5, "Waiting for file approval");
		expect(setText).toHaveBeenNthCalledWith(6, "Saving to story.md");
		expect(setText).toHaveBeenNthCalledWith(7, "");
		expect(createNotice).toHaveBeenNthCalledWith(1, "Convo GPT: Calling openai@gpt-5.4", 0);
		expect(createNotice).toHaveBeenNthCalledWith(2, "Convo GPT: Using web search");
		expect(hidePersistentNotice).toHaveBeenCalledTimes(1);
	});

	it("uses notices for request start and tool use on mobile", () => {
		const setText = vi.fn();
		const hidePersistentNotice = vi.fn();
		const createNotice = vi
			.fn()
			.mockReturnValueOnce({ hide: hidePersistentNotice })
			.mockReturnValue({ hide: vi.fn() });
		const manager = new PluginRequestStatusManager({ setText }, true, createNotice);

		manager.notifyRequestStart("Calling openai@gpt-5.4");
		manager.notifyToolUse("Using web search");
		manager.setCalling("openai@gpt-5.4");
		manager.setStreaming("openai@gpt-5.4");
		manager.clear();

		expect(createNotice).toHaveBeenNthCalledWith(1, "Convo GPT: Calling openai@gpt-5.4", 0);
		expect(createNotice).toHaveBeenNthCalledWith(2, "Convo GPT: Using web search");
		expect(hidePersistentNotice).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
		expect(setText).toHaveBeenCalledTimes(1);
	});
});
