export interface StatusBarLike {
	setText(text: string): void;
}

export interface NoticeLike {
	hide(): void;
}

export interface RequestStatusManager {
	clear(): void;
	notifyRequestStart(text: string): void;
	notifyToolUse(text: string): void;
	setCalling(model: string): void;
	setWaitingForRenameApproval(): void;
	setSaving(path: string): void;
	setStreaming(model: string): void;
	setWaitingForFileApproval(): void;
	setWebSearch(): void;
}

export class PluginRequestStatusManager implements RequestStatusManager {
	private activeRequestNotice: NoticeLike | null = null;

	constructor(
		private readonly statusBarItem: StatusBarLike,
		private readonly isMobile: boolean,
		private readonly noticeFactory: (text: string, duration?: number) => NoticeLike,
	) {}

	clear(): void {
		this.statusBarItem.setText("");
		this.activeRequestNotice?.hide();
		this.activeRequestNotice = null;
	}

	notifyRequestStart(text: string): void {
		this.activeRequestNotice?.hide();
		this.activeRequestNotice = this.noticeFactory(`Convo GPT: ${text}`, 0);
	}

	notifyToolUse(text: string): void {
		this.noticeFactory(`Convo GPT: ${text}`);
	}

	setCalling(model: string): void {
		this.setDesktopText(`Calling ${model}`);
	}

	setWaitingForRenameApproval(): void {
		this.setDesktopText("Waiting for rename approval");
	}

	setSaving(path: string): void {
		this.setDesktopText(`Saving to ${path}`);
	}

	setStreaming(model: string): void {
		this.setDesktopText(`Streaming ${model}`);
	}

	setWaitingForFileApproval(): void {
		this.setDesktopText("Waiting for file approval");
	}

	setWebSearch(): void {
		this.setDesktopText("Searching the web");
	}

	private setDesktopText(text: string): void {
		if (this.isMobile) {
			return;
		}

		this.statusBarItem.setText(text);
	}
}
