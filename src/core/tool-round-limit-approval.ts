import { Modal, Setting, type App } from "obsidian";

export interface ToolRoundLimitApprovalRequest {
	maxRounds: number;
	roundsCompleted: number;
}

export type ToolRoundLimitDecision = "continue" | "stop";

export function requestToolRoundLimitApproval(
	app: App,
	request: ToolRoundLimitApprovalRequest,
	signal?: AbortSignal,
): Promise<ToolRoundLimitDecision> {
	if (signal?.aborted) {
		return Promise.resolve("stop");
	}

	return new Promise((resolve) => {
		const modal = new ToolRoundLimitApprovalModal(app, request, (decision) => {
			signal?.removeEventListener("abort", abort);
			resolve(decision);
		});
		const abort = () => {
			modal.close();
		};
		signal?.addEventListener("abort", abort, { once: true });
		modal.open();
	});
}

class ToolRoundLimitApprovalModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly request: ToolRoundLimitApprovalRequest,
		private readonly resolveDecision: (decision: ToolRoundLimitDecision) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Continue tool calls?" });
		contentEl.createEl("p", {
			text: `Convo GPT has completed ${this.request.roundsCompleted} tool rounds without producing a final answer.`,
		});
		contentEl.createEl("p", {
			text: `Choose whether to continue for up to ${this.request.maxRounds} more tool rounds or stop now.`,
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText(`Continue ${this.request.maxRounds} more rounds`).setCta().onClick(() => {
					this.settle("continue");
				}),
			)
			.addExtraButton((button) =>
				button.setIcon("cross").setTooltip("Stop").onClick(() => {
					this.settle("stop");
				}),
			);
	}

	override onClose(): void {
		if (!this.settled) {
			this.resolveDecision("stop");
		}
	}

	private settle(decision: ToolRoundLimitDecision): void {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.resolveDecision(decision);
		this.close();
	}
}
