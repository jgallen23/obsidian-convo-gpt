import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginActiveRequestManager } from "../core/active-request-manager";
import type { PluginSettings } from "../core/types";
import { runRetitleNoteCommand } from "../core/retitle-note-command";

const noticeMessages: string[] = [];
const createMock = vi.fn();

vi.mock("../core/agent-resolver", () => ({
	resolveAgent: vi.fn(async () => null),
}));

vi.mock("../core/context-resolver", () => ({
	injectReferencedNoteContext: vi.fn(async (_app: unknown, _file: unknown, content: string) => ({
		content,
		missingReferences: [],
	})),
}));

vi.mock("../core/openai-client", () => ({
	OpenAIClient: class {
		async create(...args: unknown[]) {
			return createMock(...args);
		}
	},
}));

describe("runRetitleNoteCommand", () => {
	beforeEach(() => {
		noticeMessages.length = 0;
		createMock.mockReset();
	});

	it("requires an open note", async () => {
		await runRetitleNoteCommand({
			app: {} as never,
			approver: vi.fn(),
			editor: { getValue: () => "# Body" } as never,
			notify: (message) => {
				noticeMessages.push(message);
			},
			view: { file: null } as never,
			settings: buildSettings(),
			requestStatus: buildRequestStatus(),
		});

		expect(noticeMessages).toContain("Convo GPT requires an open note.");
	});

	it("requires an API key", async () => {
		await runRetitleNoteCommand({
			app: {} as never,
			approver: vi.fn(),
			editor: { getValue: () => "# Body" } as never,
			notify: (message) => {
				noticeMessages.push(message);
			},
			view: { file: buildFile("Notes/Old Title.md", "Old Title") } as never,
			settings: buildSettings({ apiKey: "" }),
			requestStatus: buildRequestStatus(),
		});

		expect(noticeMessages).toContain("Convo GPT is missing an OpenAI API key.");
	});

	it("renames the current note and keeps the folder and extension", async () => {
		createMock.mockResolvedValue({
			text: "Project kickoff notes",
			sourcesAppendix: "",
		});
		const approver = vi.fn().mockResolvedValue(true);
		const renameFile = vi.fn().mockResolvedValue(undefined);
		const requestStatus = buildRequestStatus();

		await runRetitleNoteCommand({
			app: {
				fileManager: { renameFile },
				metadataCache: {},
				vault: {},
			} as never,
			approver,
			editor: { getValue: () => "---\nmodel: openai@gpt-5.4\n---\n# Body\n\nMeeting notes." } as never,
			notify: (message) => {
				noticeMessages.push(message);
			},
			view: { file: buildFile("Projects/2026-04-02 - Old Title.md", "2026-04-02 - Old Title") } as never,
			settings: buildSettings(),
			requestStatus,
		});

		expect(renameFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: "Projects/2026-04-02 - Old Title.md" }),
			"Projects/2026-04-02 - Project kickoff notes.md",
		);
		expect(approver).toHaveBeenCalledWith(
			{
				currentBasename: "2026-04-02 - Old Title",
				nextBasename: "2026-04-02 - Project kickoff notes",
			},
			expect.any(AbortSignal),
		);
		expect(requestStatus.setWaitingForRenameApproval).toHaveBeenCalled();
		expect(requestStatus.clear).toHaveBeenCalled();
		expect(noticeMessages).toContain("Convo GPT renamed note to 2026-04-02 - Project kickoff notes");
	});

	it("does not rename the file when the approval is denied", async () => {
		createMock.mockResolvedValue({
			text: "Project kickoff notes",
			sourcesAppendix: "",
		});
		const renameFile = vi.fn().mockResolvedValue(undefined);

		await runRetitleNoteCommand({
			app: {
				fileManager: { renameFile },
				metadataCache: {},
				vault: {},
			} as never,
			approver: vi.fn().mockResolvedValue(false),
			editor: { getValue: () => "# Body\n\nMeeting notes." } as never,
			notify: (message) => {
				noticeMessages.push(message);
			},
			view: { file: buildFile("Projects/Old Title.md", "Old Title") } as never,
			settings: buildSettings(),
			requestStatus: buildRequestStatus(),
		});

		expect(renameFile).not.toHaveBeenCalled();
		expect(noticeMessages).toContain("Convo GPT rename canceled.");
	});

	it("leaves the editor content untouched", async () => {
		createMock.mockResolvedValue({
			text: "Project kickoff notes",
			sourcesAppendix: "",
		});
		const content = "# Body\n\nMeeting notes.";
		const approver = vi.fn().mockResolvedValue(true);
		const renameFile = vi.fn().mockResolvedValue(undefined);
		const editor = {
			getValue: vi.fn(() => content),
		};

		await runRetitleNoteCommand({
			app: {
				fileManager: { renameFile },
				metadataCache: {},
				vault: {},
			} as never,
			approver,
			editor: editor as never,
			notify: (message) => {
				noticeMessages.push(message);
			},
			view: { file: buildFile("Projects/Old Title.md", "Old Title") } as never,
			settings: buildSettings(),
			requestStatus: buildRequestStatus(),
		});

		expect(editor.getValue).toHaveReturnedWith(content);
		expect(renameFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: "Projects/Old Title.md" }),
			"Projects/Project kickoff notes.md",
		);
	});

	it("suppresses the generic failure notice when canceled", async () => {
		const requestManager = new PluginActiveRequestManager();
		let markStarted: (() => void) | null = null;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		createMock.mockImplementationOnce(async (_messages, options) => {
			markStarted?.();
			return new Promise((_resolve, reject) => {
				options.signal.addEventListener(
					"abort",
					() => {
						reject(new Error("Request aborted"));
					},
					{ once: true },
				);
			});
		});

		const runPromise = runRetitleNoteCommand({
			app: {
				fileManager: { renameFile: vi.fn() },
				metadataCache: {},
				vault: {},
			} as never,
			approver: vi.fn().mockResolvedValue(true),
			editor: { getValue: () => "# Body\n\nMeeting notes." } as never,
			notify: (message) => {
				noticeMessages.push(message);
			},
			requestManager,
			view: { file: buildFile("Projects/Old Title.md", "Old Title") } as never,
			settings: buildSettings(),
			requestStatus: buildRequestStatus(),
		});

		await started;
		expect(requestManager.cancelActiveRequest()).toBe(true);
		await runPromise;

		expect(noticeMessages).not.toContain("Convo GPT request failed: Request aborted");
	});
});

function buildSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		apiKey: "test-key",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "openai@gpt-5.4",
		defaultReasoningEffort: "none",
		defaultTemperature: 0.2,
		defaultMaxTokens: 4096,
		stream: true,
		agentFolder: "",
		chatsFolder: "chats/",
		defaultSystemPrompt: "Be concise.",
		enableOpenAINativeWebSearch: true,
		enableFetchTool: true,
		enableMarkdownFileTool: true,
		enableReferencedFileReadTool: true,
		enableDebugLogging: false,
		referencedFileExtensions: ["md", "txt", "csv", "json", "yaml"],
		referencedFileReadMaxChars: 12000,
		enableMcpServers: false,
		mcpServers: [],
		...overrides,
	};
}

function buildRequestStatus() {
	return {
		clear: vi.fn(),
		notifyRequestStart: vi.fn(),
		notifyToolUse: vi.fn(),
		setCalling: vi.fn(),
		setWaitingForContinueApproval: vi.fn(),
		setWaitingForRenameApproval: vi.fn(),
		setSaving: vi.fn(),
		setStreaming: vi.fn(),
		setWaitingForFileApproval: vi.fn(),
		setWebSearch: vi.fn(),
	};
}

function buildFile(path: string, basename: string) {
	return {
		path,
		basename,
		extension: "md",
	};
}
