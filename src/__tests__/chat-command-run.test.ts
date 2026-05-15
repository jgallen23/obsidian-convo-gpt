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

import { TFile, TFolder } from "obsidian";
import { PluginActiveRequestManager } from "../core/active-request-manager";
import { runChatCommand } from "../core/chat-command";
import type { AgentDefinition, PluginSettings } from "../core/types";

const {
	resolveAgentMock,
	requestToolRoundLimitApprovalMock,
	executeFetchToolCallMock,
	executeMarkdownWriteToolCallMock,
	createTurnMock,
	createMock,
	streamMock,
	streamTurnMock,
} = vi.hoisted(() => ({
	resolveAgentMock: vi.fn<() => Promise<AgentDefinition | null>>(),
	requestToolRoundLimitApprovalMock: vi.fn(),
	executeFetchToolCallMock: vi.fn(),
	executeMarkdownWriteToolCallMock: vi.fn(),
	createTurnMock: vi.fn(),
	createMock: vi.fn(),
	streamMock: vi.fn(),
	streamTurnMock: vi.fn(),
}));

vi.mock("../core/agent-resolver", () => ({
	resolveAgent: resolveAgentMock,
}));

vi.mock("../core/tool-round-limit-approval", () => ({
	requestToolRoundLimitApproval: requestToolRoundLimitApprovalMock,
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
	createForcedFunctionToolChoice: (name: string) => ({
		type: "function",
		name,
	}),
	OpenAIClient: class {
		async createTurn(...args: unknown[]) {
			return createTurnMock(args[0], args[1]);
		}

		async create(...args: unknown[]) {
			return createMock(args[0], args[1]);
		}

		async stream(...args: unknown[]) {
			return streamMock(args[0], args[1], args[2]);
		}

		async streamTurn(...args: unknown[]) {
			return streamTurnMock(args[0], args[1], args[2]);
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
		requestToolRoundLimitApprovalMock.mockReset();
		requestToolRoundLimitApprovalMock.mockResolvedValue("stop");
		createMock.mockReset();
		streamMock.mockReset();
		streamTurnMock.mockReset();
		streamTurnMock.mockImplementation(async (params: unknown, callbacks: { onText?: (delta: string) => void }) => {
			const response = await createTurnMock(params);
			if (typeof response?.text === "string" && response.text.length > 0) {
				callbacks.onText?.(response.text);
			}
			return response;
		});
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
		expect(secondTurn.instructions).toContain("Be concise.");
		expect(secondTurn.instructions).toContain("Consult [[Style Guide]] before answering.");
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

	it("can search an oversized referenced file before deciding whether to read it", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md", { size: 30000 });

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_search",
						name: "search_referenced_file",
						arguments: JSON.stringify({ reference: "Brief", query: "deadline" }),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "The brief mentions a Friday deadline.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const app = buildApp(
			noteFile,
			{
				"Brief|Notes/Chat.md": briefFile,
			},
			{
				"Docs/Brief.md": `${"Overview\n".repeat(2000)}Project deadline is Friday.\nBudget is unchanged.`,
			},
		);
		const editor = createEditor("# _You (1)_\n\nWhat deadline is in [[Brief]]?");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: app as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const firstTurn = createTurnMock.mock.calls[0]?.[0];
		expect(
			firstTurn.messages.some((message: { content: string }) =>
				message.content.includes("Call read_referenced_file when you need the full contents of a linked file, including large files."),
			),
		).toBe(true);

		const secondTurn = createTurnMock.mock.calls[1]?.[0];
		expect(JSON.parse(secondTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			path: "Docs/Brief.md",
			query: "deadline",
			matches: [
				expect.objectContaining({
					lineStart: expect.any(Number),
					lineEnd: expect.any(Number),
					snippet: expect.stringContaining("Project deadline is Friday."),
				}),
			],
		});
		expect(editor.getValue()).toContain("The brief mentions a Friday deadline.");
		expect(editor.getValue()).not.toContain("### Referenced files");
		expect(editor.getValue()).toContain("### Referenced file searches");
		expect(editor.getValue()).toContain('Searched [[Docs/Brief.md]] for "deadline"');
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith('Searching referenced file: Brief for "deadline"');
	});

	it("can read a section from a search result line in an oversized referenced file", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md", { size: 30000 });

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_search",
						name: "search_referenced_file",
						arguments: JSON.stringify({ reference: "Brief", query: "buyer" }),
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
						call_id: "call_section",
						name: "read_referenced_file_section",
						arguments: JSON.stringify({ reference: "Brief", line: 2005 }),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_3",
				text: "Your typical buyer is a VP of Marketing or Creative Director.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const app = buildApp(
			noteFile,
			{
				"Brief|Notes/Chat.md": briefFile,
			},
			{
				"Docs/Brief.md": [
					"# Intro",
					`${"Overview\n".repeat(2000)}`.trimEnd(),
					"## Ideal Client Profile",
					"- Clients are growth-oriented companies.",
					"- Typical buyer is a VP of Marketing or Creative Director.",
					"",
					"## Core Problems",
					"- The site is rigid.",
				].join("\n"),
			},
		);
		const editor = createEditor("# _You (1)_\n\nWho is the buyer in [[Brief]]?");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: app as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const thirdTurn = createTurnMock.mock.calls[2]?.[0];
		expect(JSON.parse(thirdTurn.inputItems[0].output)).toMatchObject({
			status: "success",
			path: "Docs/Brief.md",
			sectionHeading: "Ideal Client Profile",
		});
		expect(JSON.parse(thirdTurn.inputItems[0].output).content).toContain("Typical buyer is a VP of Marketing");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith('Searching referenced file: Brief for "buyer"');
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Reading referenced file section: Brief at line 2005");
		expect(editor.getValue()).toContain("Your typical buyer is a VP of Marketing or Creative Director.");
		expect(editor.getValue()).toContain("### Referenced files");
		expect(editor.getValue()).toContain("### Referenced file searches");
		expect(editor.getValue()).toContain('Searched [[Docs/Brief.md]] for "buyer"');
		expect(editor.getValue()).toContain("### Referenced file sections");
		expect(editor.getValue()).toContain('Read section "Ideal Client Profile" from [[Docs/Brief.md]]');
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
		expect(editor.getValue()).toContain("### Markdown file saves");
		expect(editor.getValue()).toContain("append [[Stories/story.md]]");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Reading referenced file: Brief");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Saving markdown file: Stories/story.md");
	});

	it("injects linked document context and auto-writes the bound file without explicit restatement", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const proposalFile = createFile("Docs/Proposal.md");

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "Docs/Proposal.md",
							operation: "replace",
							content: "# Proposal\n\nShorter copy.",
							instructions: null,
							reason: "Apply the requested revision.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Revised the proposal in `Docs/Proposal.md`.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const editor = createEditor(`---
document: "[[Docs/Proposal]]"
---
# _You (1)_

Make it shorter.`);

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Docs/Proposal|Notes/Chat.md": proposalFile,
				},
				{
					"Docs/Proposal.md": "# Proposal\n\nLonger draft.",
				},
			) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const firstTurn = createTurnMock.mock.calls[0]?.[0];
		expect(firstTurn.messages.some((message: { content: string }) => message.content.includes("Linked document mode is active"))).toBe(true);
		expect(firstTurn.messages.some((message: { content: string }) => message.content.includes("Longer draft."))).toBe(true);
		expect(firstTurn.toolChoice).toBe("required");
		expect(executeMarkdownWriteToolCallMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			undefined,
			expect.objectContaining({
				trustedPaths: new Set(["Docs/Proposal.md"]),
			}),
		);
		expect(editor.getValue()).toContain("Revised the proposal in [[Docs/Proposal]].");
	});

	it("loads linked document content for read-only turns without exposing the save tool", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const proposalFile = createFile("Docs/Proposal.md");
		createMock.mockResolvedValue({
			text: "Summary only.",
			sourcesAppendix: "",
		});

		const editor = createEditor(`---
document: "[[Docs/Proposal]]"
stream: false
---
# _You (1)_

Summarize the current draft.`);

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Docs/Proposal|Notes/Chat.md": proposalFile,
				},
				{
					"Docs/Proposal.md": "# Proposal\n\nCurrent contents.",
				},
			) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(createTurnMock).not.toHaveBeenCalled();
		const messages = createMock.mock.calls[0]?.[0];
		expect(messages.some((message: { content: string }) => message.content.includes("Current contents."))).toBe(true);
		expect(executeMarkdownWriteToolCallMock).not.toHaveBeenCalled();
		expect(editor.getValue()).toContain("Summary only.");
	});

	it("does not enable document mode without an explicit document property", async () => {
		const noteFile = createFile("Notes/Chat.md");
		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "Stories/story.md",
							operation: "create",
							content: "# Story",
							instructions: null,
							reason: "Create the draft.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Created the story.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const editor = createEditor("# _You (1)_\n\nWrite a story and save it to Stories/story.md.");

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const firstTurn = createTurnMock.mock.calls[0]?.[0];
		expect(firstTurn.messages.some((message: { content: string }) => message.content.includes("Linked document mode is active"))).toBe(
			false,
		);
		expect(editor.getValue()).not.toContain("document:");
		expect(editor.getValue()).toContain("Created the story.");
	});

	it("continues document drafting across short follow-up replies", async () => {
		const noteFile = createFile("document test/doc chat.md");
		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "document test/Story.md",
							operation: "replace",
							content: "# The Dragon with Allergies",
							instructions: null,
							reason: "Write the selected story into the document.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Wrote the story into the document.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const editor = createEditor(`---
document: '[[document test/Story]]'
---
help me create a story in a document

<hr class="__convo_gpt__">

# _AI (1)_
Give me the tone and style.

<hr class="__convo_gpt__">
# _You (2)_

#3`);

		await runChatCommand({
			app: buildApp(noteFile, {}, { "document test/Story.md": "" }) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(executeMarkdownWriteToolCallMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			undefined,
			expect.objectContaining({
				trustedPaths: new Set(["document test/Story.md"]),
			}),
		);
		expect(editor.getValue()).toContain("Wrote the story into the document.");
	});

	it("treats 'put ... at the bottom' as a document edit request", async () => {
		const noteFile = createFile("document test - existing doc/chat.md");
		const storyFile = createFile("document test - existing doc/short story 1.md");
		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "document test - existing doc/short story 1.md",
							operation: "replace",
							content: "# Short Story\n\n...\n\n## Review\n\nStrong opening hook.",
							instructions: null,
							reason: "Append a review to the story.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Added a review section to the bottom of `document test - existing doc/short story 1.md`.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const editor = createEditor(`---
document: "[[short story 1]]"
---
what do you think of the story

<hr class="__convo_gpt__">

# _AI (1)_
It works well.

<hr class="__convo_gpt__">
# _You (2)_

put a review of the story at the bottom of it`);

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"short story 1|document test - existing doc/chat.md": storyFile,
				},
				{
					"document test - existing doc/short story 1.md": "# Short Story\n\nOriginal story.",
				},
			) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(executeMarkdownWriteToolCallMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			undefined,
			expect.objectContaining({
				trustedPaths: new Set(["document test - existing doc/short story 1.md"]),
			}),
		);
		expect(editor.getValue()).toContain("Added a review section to the bottom of [[document test - existing doc/short story 1]].");
	});

	it("forces save_markdown_file after other tool calls when linked document auto-write is active", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const proposalFile = createFile("Docs/Proposal.md");
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
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "Docs/Proposal.md",
							operation: "replace",
							content: "# Proposal\n\nUpdated using the brief.",
							instructions: null,
							reason: "Apply the requested update.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_3",
				text: "Updated the proposal in `Docs/Proposal.md`.",
				sourcesAppendix: "",
				toolCalls: [],
			});

		const editor = createEditor(`---
document: "[[Docs/Proposal]]"
---
# _You (1)_

Update the proposal using [[Brief]].`);

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Docs/Proposal|Notes/Chat.md": proposalFile,
					"Brief|Notes/Chat.md": briefFile,
				},
				{
					"Docs/Proposal.md": "# Proposal\n\nOriginal draft.",
					"Docs/Brief.md": "Keep it short and concrete.",
				},
			) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(createTurnMock.mock.calls[0]?.[0].toolChoice).toBe("required");
		expect(createTurnMock.mock.calls[1]?.[0].toolChoice).toEqual({
			type: "function",
			name: "save_markdown_file",
		});
		expect(executeMarkdownWriteToolCallMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			undefined,
			expect.objectContaining({
				trustedPaths: new Set(["Docs/Proposal.md"]),
			}),
		);
		expect(editor.getValue()).toContain("Updated the proposal in [[Docs/Proposal]].");
	});

	it("falls back to stored frontmatter when the editor buffer omits document properties", async () => {
		const noteFile = createFile("chats/2026-04-10-3.md");
		const linkedFile = createFile("list of jokes.md");

		createTurnMock
			.mockResolvedValueOnce({
				responseId: "resp_1",
				text: "",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_write",
						name: "save_markdown_file",
						arguments: JSON.stringify({
							path: "list of jokes.md",
							operation: "append",
							content: "\n- Another joke",
							reason: "Append requested jokes.",
						}),
					},
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Added four jokes to [[list of jokes]].",
				sourcesAppendix: "",
				toolCalls: [],
			});

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"list of jokes.md|chats/2026-04-10-3.md": linkedFile,
				},
				{
					"chats/2026-04-10-3.md": [
						"---",
						"agent:",
						'document: "[[list of jokes.md]]"',
						"---",
						"can you add unique 4 jokes to the bottom of the file?",
					].join("\n"),
					"list of jokes.md": "- Existing joke",
				},
			) as never,
			editor: createEditor("can you add unique 4 jokes to the bottom of the file?") as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		const firstTurn = createTurnMock.mock.calls[0]?.[0];
		expect(firstTurn.includeMarkdownFileTool).toBe(true);
		expect(firstTurn.toolChoice).toBe("required");
		expect(firstTurn.messages.some((message: { content: string }) => message.content.includes("list of jokes.md"))).toBe(true);
		expect(executeMarkdownWriteToolCallMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			undefined,
			expect.objectContaining({
				trustedPaths: new Set(["list of jokes.md"]),
			}),
		);
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

	it("streams the final assistant phase after tool calls complete", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		createTurnMock.mockResolvedValueOnce({
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
			],
		});
		streamTurnMock.mockImplementationOnce(async (params: unknown, callbacks: { onText?: (delta: string) => void }) => {
			callbacks.onText?.("Final streamed answer.");
			return {
				responseId: "resp_2",
				text: "Final streamed answer.",
				sourcesAppendix: "",
				toolCalls: [],
			};
		});

		const editor = createEditor("# _You (1)_\n\nRead [[Brief]] and then answer.");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Brief|Notes/Chat.md": briefFile,
				},
				{
					"Docs/Brief.md": "Short brief.",
				},
			) as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(streamTurnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				inputItems: [
					expect.objectContaining({
						type: "function_call_output",
						call_id: "call_read",
					}),
				],
				previousResponseId: "resp_1",
			}),
			expect.anything(),
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
		expect(requestStatus.setStreaming).toHaveBeenCalledWith("openai@gpt-5.4 (temperature: 0.2)");
		expect(editor.getValue()).toContain("Final streamed answer.");
		expect(editor.getValue()).toContain("### Referenced files");
	});

	it("falls back to non-streaming tool continuation when streamed follow-up asks for another tool", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		const nestedFile = createFile("Docs/Nested.md");

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
				],
			})
			.mockResolvedValueOnce({
				responseId: "resp_3",
				text: "Finished after fallback.",
				sourcesAppendix: "",
				toolCalls: [],
			});
		streamTurnMock.mockImplementationOnce(async (params: unknown, callbacks: { onText?: (delta: string) => void }) => {
			callbacks.onText?.("Transient text that should be removed.");
			return {
				responseId: "resp_2",
				text: "Transient text that should be removed.",
				sourcesAppendix: "",
				toolCalls: [
					{
						type: "function_call",
						call_id: "call_nested",
						name: "read_referenced_file",
						arguments: JSON.stringify({ reference: "Nested" }),
					},
				],
			};
		});

		const editor = createEditor("# _You (1)_\n\nRead [[Brief]] and then answer.");

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Brief|Notes/Chat.md": briefFile,
					"Nested|Docs/Brief.md": nestedFile,
				},
				{
					"Docs/Brief.md": "Short brief. See [[Nested]].",
					"Docs/Nested.md": "Nested brief.",
				},
			) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(editor.getValue()).toContain("Finished after fallback.");
		expect(editor.getValue()).not.toContain("Transient text that should be removed.");
		expect(editor.getValue()).toContain("### Referenced files");
		expect(editor.getValue()).toContain("[[Docs/Nested.md]]");
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

	it("shows notices for streamed MCP server discovery and MCP tool calls", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const requestStatus = buildRequestStatus();

		streamMock.mockImplementation(async (_messages, callbacks) => {
			callbacks.onToolUse?.("Using MCP server: docs");
			callbacks.onToolUse?.("Using MCP tool: docs.search_docs");
			callbacks.onText("MCP-backed answer.");
			return {
				text: "MCP-backed answer.",
				sourcesAppendix: "",
				mcpNotices: [],
			};
		});

		const editor = createEditor("# _You (1)_\n\nAnswer using the docs MCP.");

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP server: docs");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP tool: docs.search_docs");
		expect(editor.getValue()).toContain("MCP-backed answer.");
		expect(editor.getValue()).toContain("### MCP usage");
		expect(editor.getValue()).toContain("- Server: docs");
		expect(editor.getValue()).toContain("- Tool: docs.search_docs");
	});

	it("appends streamed MCP tool usage discovered only after stream completion", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const requestStatus = buildRequestStatus();

		streamMock.mockImplementation(async (_messages, callbacks) => {
			callbacks.onToolUse?.("Using MCP server: weather");
			callbacks.onText("Weekly weather answer.");
			return {
				text: "Weekly weather answer.",
				sourcesAppendix: "",
				mcpNotices: ["Using MCP tool: weather.get_forecast"],
			};
		});

		const editor = createEditor("# _You (1)_\n\nWhat is the weather in El Segundo this week?");

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP server: weather");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP tool: weather.get_forecast");
		expect(editor.getValue()).toContain("### MCP usage");
		expect(editor.getValue()).toContain("- Server: weather");
		expect(editor.getValue()).toContain("- Tool: weather.get_forecast");
	});

	it("shows notices for non-streaming MCP usage", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const requestStatus = buildRequestStatus();

		createMock.mockResolvedValue({
			text: "Non-streaming MCP answer.",
			sourcesAppendix: "",
			mcpNotices: ["Using MCP server: docs", "Using MCP tool: docs.search_docs"],
		});

		const editor = createEditor(`---
stream: false
---
# _You (1)_

Use the docs MCP.`);

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP server: docs");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP tool: docs.search_docs");
		expect(editor.getValue()).toContain("Non-streaming MCP answer.");
		expect(editor.getValue()).toContain("### MCP usage");
		expect(editor.getValue()).toContain("- Server: docs");
		expect(editor.getValue()).toContain("- Tool: docs.search_docs");
	});

	it("appends a note when the response hits max_output_tokens", async () => {
		const noteFile = createFile("Notes/Chat.md");
		createMock.mockResolvedValue({
			text: "Cut off answer.",
			sourcesAppendix: "",
			mcpNotices: [],
			hitMaxOutputTokens: true,
		});

		const editor = createEditor(`---
stream: false
max_tokens: 10000
---
# _You (1)_

Give me a very long answer.`);

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(editor.getValue()).toContain("Cut off answer.");
		expect(editor.getValue()).toContain("_Note: response stopped after hitting max_output_tokens (10000)._");
	});

	it("appends MCP usage after tool-loop turns", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		const requestStatus = buildRequestStatus();

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
				],
				mcpNotices: ["Using MCP server: docs", "Using MCP tool: docs.search_docs"],
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Summarized with MCP context.",
				sourcesAppendix: "",
				toolCalls: [],
				mcpNotices: ["Using MCP tool: docs.search_docs"],
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
		const editor = createEditor("# _You (1)_\n\nRead [[Brief]] and answer with the docs MCP.");

		await runChatCommand({
			app: app as never,
			editor: editor as never,
			requestStatus,
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP server: docs");
		expect(requestStatus.notifyToolUse).toHaveBeenCalledWith("Using MCP tool: docs.search_docs");
		expect(editor.getValue()).toContain("Summarized with MCP context.");
		expect(editor.getValue()).toContain("### Referenced files");
		expect(editor.getValue()).toContain("### MCP usage");
		expect(editor.getValue()).toContain("- Server: docs");
		expect(editor.getValue()).toContain("- Tool: docs.search_docs");
	});

	it("includes reasoning and temperature in the request-start notification when set", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const requestStatus = buildRequestStatus();
		createMock.mockResolvedValue({
			text: "Hello.",
			sourcesAppendix: "",
			hitMaxOutputTokens: false,
			mcpNotices: [],
		});

		await runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: createEditor("# _You (1)_\n\nHello.") as never,
			requestStatus,
			settings: buildSettings({
				defaultReasoningEffort: "high",
				stream: false,
			}),
			view: { file: noteFile } as never,
		});

		expect(requestStatus.notifyRequestStart).toHaveBeenCalledWith(
			"Calling openai@gpt-5.4 (reasoning: high, temperature: 0.2)",
		);
		expect(requestStatus.setCalling).toHaveBeenCalledWith(
			"openai@gpt-5.4 (reasoning: high, temperature: 0.2)",
		);
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

	it("auto-retitles a generated chat after the first successful reply", async () => {
		const noteFile = createFile("chats/2026-04-10-1.md");
		const renameFile = vi.fn().mockResolvedValue(undefined);
		createMock
			.mockResolvedValueOnce({
				text: "Here is a kickoff outline.",
				sourcesAppendix: "",
			})
			.mockResolvedValueOnce({
				text: "Project kickoff outline",
				sourcesAppendix: "",
			});

		await runChatCommand({
			app: {
				...buildApp(noteFile, {}, {}),
				fileManager: { renameFile },
			} as never,
			editor: createEditor("# _You (1)_\n\nPlan a project kickoff outline.") as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(createMock).toHaveBeenCalledTimes(2);
		expect(renameFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: "chats/2026-04-10-1.md" }),
			"chats/2026-04-10 - Project kickoff outline.md",
		);
	});

	it("does not auto-retitle generated chats after the first exchange", async () => {
		const noteFile = createFile("chats/2026-04-10-1.md");
		const renameFile = vi.fn().mockResolvedValue(undefined);
		createMock.mockResolvedValue({
			text: "Second-turn answer.",
			sourcesAppendix: "",
		});

		await runChatCommand({
			app: {
				...buildApp(noteFile, {}, {}),
				fileManager: { renameFile },
			} as never,
			editor: createEditor(`# _You (1)_

Plan a project kickoff outline.

<hr class="__convo_gpt__">

# _AI (1)_
Here is a kickoff outline.

<hr class="__convo_gpt__">

# _You (2)_

Make it shorter.`) as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(createMock).toHaveBeenCalledTimes(1);
		expect(renameFile).not.toHaveBeenCalled();
	});

	it("keeps partial streamed text and suppresses the error footer when canceled", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const editor = createEditor("# _You (1)_\n\nTell me a story.");
		const requestStatus = buildRequestStatus();
		const requestManager = new PluginActiveRequestManager();
		let markStarted: (() => void) | null = null;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		streamMock.mockImplementationOnce(async (_messages, callbacks, options) => {
			callbacks.onText("Partial answer");
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

		const runPromise = runChatCommand({
			app: buildApp(noteFile, {}, {}) as never,
			editor: editor as never,
			requestManager,
			requestStatus,
			settings: buildSettings(),
			view: { file: noteFile } as never,
		});

		await started;
		expect(requestManager.cancelActiveRequest()).toBe(true);
		await runPromise;

		expect(editor.getValue()).toContain("Partial answer");
		expect(editor.getValue()).not.toContain("_Error: Request aborted_");
		expect(requestStatus.clear).toHaveBeenCalled();
	});

	it("prompts to stop when the tool round limit is reached and returns a stop message", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");

		createTurnMock
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_1", "call_1", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_2", "call_2", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_3", "call_3", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_4", "call_4", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_5", "call_5", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_6", "call_6", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_7", "call_7", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_8", "call_8", "Brief"));

		requestToolRoundLimitApprovalMock.mockResolvedValueOnce("stop");
		const requestStatus = buildRequestStatus();

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Brief|Notes/Chat.md": briefFile,
				},
				{
					"Docs/Brief.md": "Short brief.",
				},
			) as never,
			editor: createEditor("# _You (1)_\n\nKeep reading [[Brief]].") as never,
			requestStatus,
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(requestToolRoundLimitApprovalMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				maxRounds: 8,
				roundsCompleted: 8,
			}),
			expect.any(AbortSignal),
		);
		expect(requestStatus.setWaitingForContinueApproval).toHaveBeenCalled();
		expect(createTurnMock).toHaveBeenCalledTimes(8);
	});

	it("can continue after the tool round limit prompt", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");

		createTurnMock
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_1", "call_1", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_2", "call_2", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_3", "call_3", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_4", "call_4", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_5", "call_5", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_6", "call_6", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_7", "call_7", "Brief"))
			.mockResolvedValueOnce(buildReferencedReadToolTurn("resp_8", "call_8", "Brief"))
			.mockResolvedValueOnce({
				responseId: "resp_9",
				text: "Final answer after continuing.",
				sourcesAppendix: "",
				toolCalls: [],
				mcpNotices: [],
				hitMaxOutputTokens: false,
			});

		requestToolRoundLimitApprovalMock.mockResolvedValueOnce("continue");

		const editor = createEditor("# _You (1)_\n\nKeep reading [[Brief]].");

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Brief|Notes/Chat.md": briefFile,
				},
				{
					"Docs/Brief.md": "Short brief.",
				},
			) as never,
			editor: editor as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(requestToolRoundLimitApprovalMock).toHaveBeenCalledTimes(1);
		expect(createTurnMock).toHaveBeenCalledTimes(9);
		expect(editor.getValue()).toContain("Final answer after continuing.");
	});

	it("appends ai_log traces with raw requests, responses, and tool results", async () => {
		const noteFile = createFile("Notes/Chat.md");
		const briefFile = createFile("Docs/Brief.md");
		const fileContents: Record<string, string> = {
			"Docs/Brief.md": "Short brief.",
		};

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
				],
				mcpNotices: [],
				hitMaxOutputTokens: false,
			})
			.mockResolvedValueOnce({
				responseId: "resp_2",
				text: "Final answer.",
				sourcesAppendix: "",
				toolCalls: [],
				mcpNotices: ["Using MCP server: weather", "Using MCP tool: weather.get_forecast"],
				hitMaxOutputTokens: false,
			});

		await runChatCommand({
			app: buildApp(
				noteFile,
				{
					"Brief|Notes/Chat.md": briefFile,
				},
				fileContents,
			) as never,
			editor: createEditor("---\nai_log: Logs/ai-log.md\n---\n# _You (1)_\n\nRead [[Brief]] and answer.") as never,
			requestStatus: buildRequestStatus(),
			settings: buildSettings({ stream: false }),
			view: { file: noteFile } as never,
		});

		expect(fileContents["Logs/ai-log.md"]).toContain("Tool call: read_referenced_file");
		expect(fileContents["Logs/ai-log.md"]).toContain("Tool result: read_referenced_file");
		expect(fileContents["Logs/ai-log.md"]).toContain("- Source note: [[Notes/Chat]]");
		expect(fileContents["Logs/ai-log.md"]).toContain("Outcome: `success`");
	});

});

function buildApp(noteFile: TFile, linkMap: Record<string, TFile>, fileContents: Record<string, string>) {
	const createdFiles = new Map<string, TFile>();
	const createdFolders = new Set<string>();

	return {
		metadataCache: {
			getFirstLinkpathDest: (path: string, currentPath: string) => linkMap[`${path}|${currentPath}`] ?? null,
		},
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (path === noteFile.path) {
					return noteFile;
				}
				if (createdFolders.has(path)) {
					const folder = Object.create(TFolder.prototype) as TFolder;
					Object.assign(folder, {
						path,
						name: path.split("/").at(-1) ?? path,
						children: [],
					});
					return folder;
				}
				const created = createdFiles.get(path);
				if (created) {
					return created;
				}
				if (fileContents[path] !== undefined) {
					const existing = createFile(path, { size: fileContents[path].length });
					createdFiles.set(path, existing);
					return existing;
				}
				return Object.values(linkMap).find((file) => file.path === path) ?? null;
			},
			cachedRead: async (file: TFile) => fileContents[file.path] ?? "",
			read: async (file: TFile) => fileContents[file.path] ?? "",
			createFolder: async (path: string) => {
				createdFolders.add(path);
			},
			create: async (path: string, content: string) => {
				fileContents[path] = content;
				const file = createFile(path, { size: content.length });
				createdFiles.set(path, file);
				return file;
			},
			modify: async (file: TFile, content: string) => {
				fileContents[file.path] = content;
				file.stat.size = content.length;
			},
			process: async (file: TFile, updater: (content: string) => string) => {
				const next = updater(fileContents[file.path] ?? "");
				fileContents[file.path] = next;
				file.stat.size = next.length;
			},
		},
	};
}

function buildSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		apiKey: "test-key",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "openai@gpt-5.4",
		defaultReasoningEffort: "none",
		defaultTemperature: 0.2,
		defaultMaxTokens: 4096,
		stream: true,
		agentFolder: "Agents",
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

function createEditor(initialValue: string) {
	let value = initialValue;

	return {
		getValue: () => value,
		getScrollInfo: () => ({ top: 0 }),
		offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
		posToOffset: (pos: { ch: number }) => pos.ch,
		replaceRange: (text: string, start: { ch: number }, end?: { ch: number }) => {
			const from = start.ch;
			const to = end?.ch ?? from;
			value = `${value.slice(0, from)}${text}${value.slice(to)}`;
		},
		scrollIntoView: vi.fn(),
		setCursor: vi.fn(),
		setValue: (nextValue: string) => {
			value = nextValue;
		},
	};
}

function createFile(path: string, options: { size?: number } = {}): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	Object.assign(file, {
		path,
		name: path.split("/").at(-1) ?? path,
		basename: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""),
		extension: path.split(".").at(-1) ?? "",
		stat: {
			size: options.size ?? 0,
		},
	});
	return file;
}

function buildReferencedReadToolTurn(responseId: string, callId: string, reference: string) {
	return {
		responseId,
		text: "",
		sourcesAppendix: "",
		toolCalls: [
			{
				type: "function_call",
				call_id: callId,
				name: "read_referenced_file",
				arguments: JSON.stringify({ reference }),
			},
		],
		mcpNotices: [],
		hitMaxOutputTokens: false,
	};
}
