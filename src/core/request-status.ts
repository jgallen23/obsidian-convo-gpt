export interface StatusBarLike {
	setText(text: string): void;
}

export interface RequestStatusManager {
	clear(): void;
	notifyRequestStart(text: string): void;
	setCalling(model: string): void;
	setSaving(path: string): void;
	setStreaming(model: string): void;
	setWaitingForFileApproval(): void;
	setWebSearch(): void;
}

export class PluginRequestStatusManager implements RequestStatusManager {
	constructor(
		private readonly statusBarItem: StatusBarLike,
		private readonly isMobile: boolean,
		private readonly mobileNotifier: (text: string) => void,
	) {}

	clear(): void {
		this.statusBarItem.setText("");
	}

	notifyRequestStart(text: string): void {
		if (this.isMobile) {
			this.mobileNotifier(`Convo GPT: ${text}`);
		}
	}

	setCalling(model: string): void {
		this.setDesktopText(`Calling ${model}`);
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
