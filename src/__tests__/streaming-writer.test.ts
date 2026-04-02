import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingWriter } from "../core/streaming-writer";

describe("StreamingWriter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("flushes complete lines during buffering and flushes the tail on stop", () => {
		const editor = createFakeEditor();
		const writer = new StreamingWriter(editor as never, { line: 0, ch: 0 }, 50);

		writer.start();
		writer.append("hello");
		vi.advanceTimersByTime(60);
		expect(editor.value).toBe("");

		writer.append("\nworld");
		vi.advanceTimersByTime(60);
		expect(editor.value).toBe("hello\n");

		writer.stop();
		expect(editor.value).toBe("hello\nworld");
	});

	it("stops auto-following after the user scrolls away", () => {
		const editor = createFakeEditor();
		const writer = new StreamingWriter(editor as never, { line: 0, ch: 0 }, 50);

		writer.start();
		writer.append("line 1\n");
		vi.advanceTimersByTime(60);
		expect(writer.isAutoFollowEnabled()).toBe(true);
		expect(editor.setCursor).toHaveBeenCalledTimes(1);

		editor.scrollTo(null, 0);
		writer.append("line 2\n");
		vi.advanceTimersByTime(60);

		expect(writer.isAutoFollowEnabled()).toBe(false);
		expect(editor.setCursor).toHaveBeenCalledTimes(1);
		expect(editor.value).toBe("line 1\nline 2\n");
	});
});

function createFakeEditor() {
	const state = {
		scrollTop: 0,
		value: "",
	};

	const editor = {
		get value() {
			return state.value;
		},
		getScrollInfo: vi.fn(() => ({ top: state.scrollTop, left: 0 })),
		offsetToPos: vi.fn((offset: number) => {
			const lines = state.value.slice(0, offset).split("\n");
			return {
				line: lines.length - 1,
				ch: lines.at(-1)?.length ?? 0,
			};
		}),
		posToOffset: vi.fn((pos: { line: number; ch: number }) => {
			const lines = state.value.split("\n");
			let offset = 0;
			for (let index = 0; index < pos.line; index += 1) {
				offset += (lines[index]?.length ?? 0) + 1;
			}
			return offset + pos.ch;
		}),
		replaceRange: vi.fn((text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
			const start = editor.posToOffset(from);
			const end = to ? editor.posToOffset(to) : start;
			state.value = `${state.value.slice(0, start)}${text}${state.value.slice(end)}`;
		}),
		scrollIntoView: vi.fn((range: { from: { line: number; ch: number } }) => {
			state.scrollTop = editor.posToOffset(range.from);
		}),
		scrollTo: vi.fn((_x: number | null | undefined, y: number | null | undefined) => {
			state.scrollTop = y ?? state.scrollTop;
		}),
		setCursor: vi.fn(),
	};

	return editor;
}
