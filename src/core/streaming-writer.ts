import type { Editor, EditorPosition, EditorRange } from "obsidian";

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const AUTO_FOLLOW_SCROLL_THRESHOLD = 4;
const MAX_BUFFER_SIZE = 10000;

export class StreamingWriter {
	private bufferedText = "";
	private currentCursor: EditorPosition;
	private autoFollow = true;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private lastAutoScrollTop: number | null = null;

	constructor(
		private readonly editor: Editor,
		initialCursor: EditorPosition,
		private readonly flushInterval = DEFAULT_FLUSH_INTERVAL_MS,
	) {
		this.currentCursor = initialCursor;
	}

	start(): void {
		if (!this.flushTimer) {
			this.flushTimer = setInterval(() => this.flush(), this.flushInterval);
		}
	}

	append(text: string): void {
		this.bufferedText += text;
		if (this.bufferedText.length >= MAX_BUFFER_SIZE) {
			this.forceFlush();
		}
	}

	flush(): void {
		if (this.bufferedText.length === 0) {
			return;
		}

		const lastNewline = this.bufferedText.lastIndexOf("\n");
		if (lastNewline === -1) {
			return;
		}

		const toFlush = this.bufferedText.slice(0, lastNewline + 1);
		this.bufferedText = this.bufferedText.slice(lastNewline + 1);
		this.writeText(toFlush);
	}

	stop(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		this.forceFlush();
	}

	forceFlush(): void {
		if (this.bufferedText.length === 0) {
			return;
		}

		this.writeText(this.bufferedText);
		this.bufferedText = "";
	}

	getCursor(): EditorPosition {
		return this.currentCursor;
	}

	setCursor(cursor: EditorPosition): void {
		this.currentCursor = cursor;
	}

	isAutoFollowEnabled(): boolean {
		return this.autoFollow;
	}

	private writeText(text: string): void {
		if (!text) {
			return;
		}

		if (this.autoFollow && this.userScrolledAway()) {
			this.autoFollow = false;
		}

		this.editor.replaceRange(text, this.currentCursor);
		const nextCursor = this.editor.offsetToPos(this.editor.posToOffset(this.currentCursor) + text.length);
		this.currentCursor = nextCursor;

		if (this.autoFollow) {
			this.editor.setCursor(nextCursor);
			this.editor.scrollIntoView(asCaretRange(nextCursor), false);
			this.lastAutoScrollTop = this.editor.getScrollInfo().top;
		}
	}

	private userScrolledAway(): boolean {
		if (this.lastAutoScrollTop === null) {
			return false;
		}

		return Math.abs(this.editor.getScrollInfo().top - this.lastAutoScrollTop) > AUTO_FOLLOW_SCROLL_THRESHOLD;
	}
}

function asCaretRange(pos: EditorPosition): EditorRange {
	return {
		from: pos,
		to: pos,
	};
}
