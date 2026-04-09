/* eslint-disable @typescript-eslint/no-unused-vars */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"obsidian",
	() => {
		class TFile {}
		class TFolder {}
		class Notice {
			constructor(_message?: string) {}
		}
		class Modal {
			contentEl = {
				empty() {},
				createEl() {
					return {};
				},
			};

			constructor(_app?: unknown) {}
			open() {}
			close() {}
		}
		class Setting {
			constructor(_containerEl?: unknown) {}
			addButton(callback: (button: { onClick: (handler: () => void) => unknown; setButtonText: (text: string) => unknown; setCta: () => unknown }) => unknown) {
				callback({
					onClick: () => undefined,
					setButtonText: () => ({
						setCta: () => ({
							onClick: () => undefined,
						}),
					}),
					setCta: () => ({
						onClick: () => undefined,
					}),
				});
				return this;
			}
			addExtraButton(callback: (button: { onClick: (handler: () => void) => unknown; setIcon: (icon: string) => unknown; setTooltip: (text: string) => unknown }) => unknown) {
				callback({
					onClick: () => undefined,
					setIcon: () => ({
						setTooltip: () => ({
							onClick: () => undefined,
						}),
					}),
					setTooltip: () => ({
						onClick: () => undefined,
					}),
				});
				return this;
			}
		}

		return { Modal, Notice, Setting, TFile, TFolder };
	},
);

import { TFile } from "obsidian";
import { runChatCommand } from "../core/chat-command";
import type { AgentDefinition, PluginSettings } from "../core/types";

const {
	resolveAgentMock,
	executeFetchToolCallMock,
	executeMarkdownWriteToolCallMock,
	createTurnMock,
	createMock,
	streamMock,
} = vi.hoisted(() => ({
	resolveAgentMock: vi.fn<() => Promise<AgentDefinition | null>>(),
	executeFetchToolCallMock: vi.fn(),
	executeMarkdownWriteToolCallMock: vi.fn(),
	createTurnMock: vi.fn(),
	createMock: vi.fn(),
	streamMock: vi.fn(),
}));

vi.mock("../core/agent-resolver", () => ({
	resolveAgent: resolveAgentMock,
}));

vi.mock("../core/markdown-file-service", async () => {
	const actual = await vi.importActual("../core/markdown-file-service");
	return {
		...(actual as object),
		executeMarkdownWriteToolCall: executeMarkdownWriteToolCallMock,
	};
});

vi.mock("../core/fetch-service", async () => {
	const actual = await vi.importActual("../core/fetch-service");
	return {
		...(actual as object),
		executeFetchToolCall: executeFetchToolCallMock,
	};
});

vi.mock("../core/openai-client", () => ({
	OpenAIClient: class {
		async createTurn(...args: unknown[]) {
			return createTurnMock(args[0]);
		}

		async create(...args: unknown[]) {
			return createMock(args[0]);
		}

		async stream(...args: unknown[]) {
			return streamMock(args[0], args[1]);
		}
	},
}));

describe("runChatCommand", () => {
	beforeEach(() => {
		resolveAgentMock.mockReset();
		resolveAgentMock.mockResolvedValue(null);
		executeFetchToolCallMock.mockReset();
		executeFetchToolCallMock.mockResolvedValue({
			status: "success",
			message: "Fetched GET https://api.example.com/users with status 200.",
			method: "GET",
			url: "https://api.example.com/users",
			finalUrl: "https://api.example.com/users",
			statusCode: 200,
			statusText: "OK",
			headers: { "content-type": "application/json" },
			bodyText: '{"ok":true}',
			truncated: false,
		});
		executeMarkdownWriteToolCallMock.mockReset();
		executeMarkdownWriteToolCallMock.mockResolvedValue({
			status: "success",
			path: "Stories/story.md",
			operation: "append",
			message: "Appended markdown content to Stories/story.md.",
		});
		createTurnMock.mockReset();
		createMock.mockReset();
		streamMock.mockReset();
	});

	it("lets the model read files linked only from the active agent prompt", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const agentFile = createFile("Agents/writer.md");
		const styleGuideFile = createFile("Agents/Style Guide.md");

		resolveAgentMock.mockResolvedValue({
			frontmatter: {},
			body: "Consult [[Style Guide]] before answering.",
			file: agentFile,
			path: agentFile.path,
		});

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "read_referenced_file",
						arguments: JSON.stringify({ reference: "Style Guide" }),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Final answer.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const app = buildApp(
			noteFile,
			{
				"Style Guide|Agents/writer.md": styleGuideFile,
			},
			{
				"Agents/Style Guide.md": "Use active voice.",
			},
		);
		const editor = createEditor("# _You (1)_\n\nHelp me write this.");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: app as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const firstTurn = createTurnMock.mock.calls[0]?.[0];
		expect(firstTurn.includeReferencedFileTool).toBe(true);
		expect(firstTurn.messages[1]?.content).toContain("[[Style Guide]]");
		expect(firstTurn.messages[1]?.content).not.toContain("Referenced note context");
		expect(firstTurn.messages[1]?.content).not.toContain("Use active voice.");

		const secondTurn = createTurnMock.mock.calls[1]?.[0];
		expect(secondTurn.inputItems).toHaveLength(1);
		expect(JSON.parse(secondTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			path: "Agents/Style Guide.md",
			content: "Use active voice.",
		});
		expect(editor.getValue()).toContain("Final answer.");
		expect(editor.getValue()).toContain("### Referenced files");
		expect(editor.getValue()).toContain("[[Agents/Style Guide.md]]");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Reading referenced file: Style Guide");
	});

	it("allows nested reads discovered from an earlier file read in the same turn", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const startFile = createFile("Docs/Start.md");
		const nestedFile = createFile("Docs/Nested.md");

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "read_referenced_file",
						arguments: JSON.stringify({ reference: "Start" }),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_2",
						name: "read_referenced_file",
						arguments: JSON.stringify({ reference: "Nested" }),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_3",
				text: "Finished.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const app = buildApp(
			noteFile,
			{
				"Start|Notes/Chat.md": startFile,
				"Nested|Docs/Start.md": nestedFile,
			},
			{
				"Docs/Start.md": "See [[Nested]] next.",
				"Docs/Nested.md": "Nested details.",
			},
		);
		const editor = createEditor("# _You (1)_\n\nPlease summarize [[Start]].");

		await runChatCommand({
			app: app as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const secondTurn = createTurnMock.mock.calls[1]?.[0];
		expect(JSON.parse(secondTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			path: "Docs/Start.md",
		});

		const thirdTurn = createTurnMock.mock.calls[2]?.[0];
		expect(JSON.parse(thirdTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			path: "Docs/Nested.md",
			content: "Nested details.",
		});
	});

	it("can process read and write tools in the same turn loop", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_read",
						name: "read_referenced_file",
						arguments: JSON.stringify({ reference: "Brief" }),
					},
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "Stories/story.md",
							operation: "append",
							content: "\nNew ending.",
							instructions: null,
							reason: "Save the updated draft.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Saved and summarized.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const app = buildApp(
			noteFile,
			{
				"Brief|Notes/Chat.md": briefFile,
			},
			{
				"Docs/Brief.md": "Short brief.",
			},
		);
		const editor = createEditor("# _You (1)_\n\nRead [[Brief]] and save it to story.md.");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: app as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const followUpTurn = createTurnMock.mock.calls[1]?.[0];
		expect(followUpTurn.inputItems).toHaveLength(2);
		expect(JSON.parse(followUpTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			path: "Docs/Brief.md",
		});
		expect(JSON.parse(followUpTurn.inputItems[1].output)).toMatchObject({
			status: "success",
			path: "Stories/story.md",
		});
		expect(executeMarkdownWriteToolCallMock).toHaveBeenCalledTimes(1);
		expect(editor.getValue()).toContain("### Referenced files");
		expect(editor.getValue()).toContain("[[Docs/Brief.md]]");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Reading referenced file: Brief");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Saving markdown file: Stories/story.md");
	});

	it("can process fetch calls and append a fetch summary", async () => {
		const noteFile = createFile("Notes/Chat.md");

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_fetch",
						name: "fetch",
						arguments: JSON.stringify({
							url: "https://api.example.com/users",
							method: "GET",
							headers: [{ name: "Authorization", value: "Bearer token" }],
							body: null,
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Fetched the users.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const editor = createEditor("# _You (1)_\n\nFetch https://api.example.com/users with an Authorization header.");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const firstTurn = createTurnMock.mock.calls[0]?.[0];
		expect(firstTurn.includeFetchTool).toBe(true);
		expect(firstTurn.messages.some((message: { content: string }) => message.content.includes("HTTP fetch tool policy"))).toBe(true);

		const secondTurn = createTurnMock.mock.calls[1]?.[0];
		expect(JSON.parse(secondTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			method: "GET",
			url: "https://api.example.com/users",
			statusCode: 200,
		});
		expect(executeFetchToolCallMock).toHaveBeenCalledTimes(1);
		expect(editor.getValue()).toContain("### Fetch calls");
		expect(editor.getValue()).toContain("GET [https://api.example.com/users](https://api.example.com/users) -> 200");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using fetch: GET https://api.example.com/users");
	});

	it("shows a notice when web search starts without writing inline status text", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const requestStatus = buildRequestStatus();

		streamMock.mockImplementation(async (_messages, callbacks) => {
			callbacks.onSearchStart?.();
			callbacks.onText("Search-backed answer.");
			return {
				text: "Search-backed answer.",
				sourcesAppendix: "",
			};
		});

		const editor = createEditor("# _You (1)_\n\nWhat happened in the latest OpenAI news?");

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using web search");
		expect(requestStatus.setWebSearch).toHaveBeenCalledTimes(1);
		expect(editor.getValue()).toContain("Search-backed answer.");
		expect(editor.getValue()).not.toContain("Using web search");
	});

	it("does not expose fetch for a plain url without explicit request intent", async () => {
		const noteFile = createFile("Notes/Chat.md");
		createMock.mockResolvedValue({
			text: "I can help analyze that URL.",
			sourcesAppendix: "",
		});

		const editor = createEditor("# _You (1)_\n\nhttps://api.example.com/users");

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(createTurnMock).not.toHaveBeenCalled();
		expect(createMock).toHaveBeenCalledTimes(1);
	});
});

function buildApp(noteFile: TFile, linkMap: Record<string, TFile>, fileContents: Record<string, string>) {
	return {
		metadataCache: {
			getFirstLinkpathDest: (path: string, currentPath: string) => linkMap[`${path}|${currentPath}`] ?? null,
		},
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (path === noteFile.path) {
					return noteFile;
				}
				return Object.values(linkMap).find((file) => file.path === path) ?? null;
			},
			read: async (file: TFile) => fileContents[file.path] ?? "",
		},
	};
}

function buildSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		apiKey: "test-key",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "openai@gpt-5.4",
		defaultTemperature: 0.2,
		defaultMaxTokens: 4096,
		stream: true,
		agentFolder: "Agents",
		defaultSystemPrompt: "Be concise.",
		enableOpenAINativeWebSearch: true,
		enableFetchTool: true,
		enableMarkdownFileTool: true,
		enableReferencedFileReadTool: true,
		referencedFileExtensions: ["md", "txt", "csv", "json", "yaml"],
		...overrides,
	};
}

function buildRequestStatus() {
	return {
		clear: vi.fn(),
		notifyRequestStart: vi.fn(),
		notifyToolUse: vi.fn(),
		setCalling: vi.fn(),
		setWaitingForRenameApproval: vi.fn(),
		setSaving: vi.fn(),
		setStreaming: vi.fn(),
		setWaitingForFileApproval: vi.fn(),
		setWebSearch: vi.fn(),
	};
}

function createEditor(initialValue: string) {
	let value = initialValue;

	return {
		getValue: () => value,
		offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
		posToOffset: (pos: { ch: number }) => pos.ch,
		replaceRange: (text: string, start: { ch: number }, end?: { ch: number }) => {
			const from = start.ch;
			const to = end?.ch ?? from;
			value = `${value.slice(0, from)}${text}${value.slice(to)}`;
		},
		setCursor: vi.fn(),
		setValue: (nextValue: string) => {
			value = nextValue;
		},
	};
}

function createFile(path: string): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	Object.assign(file, {
		path,
		name: path.split("/").at(-1) ?? path,
		basename: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""),
		extension: path.split(".").at(-1) ?? "",
	});
	return file;
}
