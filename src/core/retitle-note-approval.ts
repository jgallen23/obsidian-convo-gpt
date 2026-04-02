import { Modal, Setting, type App } from "obsidian";

export interface RetitleApprovalRequest {
	currentBasename: string;
	nextBasename: string;
}

export type RetitleApprover = (request: RetitleApprovalRequest) => Promise<boolean>;

export function requestRetitleApproval(app: App, request: RetitleApprovalRequest): Promise<boolean> {
	return new Promise((resolve) => {
		new RetitleApprovalModal(app, request, resolve).open();
	});
}

class RetitleApprovalModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly request: RetitleApprovalRequest,
		private readonly resolveApproval: (approved: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Approve note rename" });
		contentEl.createEl("p", { text: `Current title: ${this.request.currentBasename}` });
		contentEl.createEl("p", { text: `New title: ${this.request.nextBasename}` });

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Rename").setCta().onClick(() => {
					this.settle(true);
				}),
			)
			.addExtraButton((button) =>
				button.setIcon("cross").setTooltip("Cancel").onClick(() => {
					this.settle(false);
				}),
			);
	}

	override onClose(): void {
		if (!this.settled) {
			this.resolveApproval(false);
		}
	}

	private settle(approved: boolean): void {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.resolveApproval(approved);
		this.close();
	}
}
