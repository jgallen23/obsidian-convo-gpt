/* eslint-disable @typescript-eslint/no-unused-vars */
export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "";
}

export class TFolder {
	children: unknown[] = [];
	path = "";
	name = "";
}

export class Notice {
	constructor(_message?: string) {}
}

export class Modal {
	contentEl = {
		empty() {},
		createEl() {
			return {};
		},
	};

	constructor(_app?: unknown) {}

	open(): void {}

	close(): void {}
}

export class Setting {
	constructor(_containerEl?: unknown) {}

	setName(_value: string): this {
		return this;
	}

	setDesc(_value: string): this {
		return this;
	}

	addButton(_callback: (button: unknown) => unknown): this {
		return this;
	}

	addExtraButton(_callback: (button: unknown) => unknown): this {
		return this;
	}

	addText(_callback: (text: unknown) => unknown): this {
		return this;
	}

	addTextArea(_callback: (text: unknown) => unknown): this {
		return this;
	}

	addToggle(_callback: (toggle: unknown) => unknown): this {
		return this;
	}
}

export class MarkdownView {
	file: TFile | null = null;
}

export class Plugin {
	app = {};

	addStatusBarItem(): { setText: (text: string) => void } {
		return {
			setText(_text: string) {},
		};
	}

	addSettingTab(_tab: unknown): void {}

	addCommand(_command: unknown): void {}

	loadData(): Promise<unknown> {
		return Promise.resolve({});
	}

	saveData(_data: unknown): Promise<void> {
		return Promise.resolve();
	}
}

export class PluginSettingTab {
	containerEl = {
		empty() {},
		createEl() {
			return {};
		},
		querySelector() {
			return null;
		},
	};

	constructor(_app?: unknown, _plugin?: unknown) {}
}

export const Platform = {
	isMobile: false,
};
