import { APIUserAbortError } from "openai";

export class ConvoAbortError extends Error {
	constructor() {
		super("Request aborted");
		this.name = "ConvoAbortError";
	}
}

export interface ActiveRequestHandle {
	finish(): void;
	signal: AbortSignal;
}

export interface ActiveRequestManager {
	beginActiveRequest(): ActiveRequestHandle | null;
	cancelActiveRequest(): boolean;
}

export class PluginActiveRequestManager implements ActiveRequestManager {
	private activeController: AbortController | null = null;

	beginActiveRequest(): ActiveRequestHandle | null {
		if (this.activeController) {
			return null;
		}

		const controller = new AbortController();
		this.activeController = controller;

		return {
			signal: controller.signal,
			finish: () => {
				if (this.activeController === controller) {
					this.activeController = null;
				}
			},
		};
	}

	cancelActiveRequest(): boolean {
		if (!this.activeController) {
			return false;
		}

		this.activeController.abort();
		return true;
	}
}

export function isConvoAbortError(error: unknown): boolean {
	if (error instanceof ConvoAbortError || error instanceof APIUserAbortError) {
		return true;
	}

	return error instanceof Error && (error.name === "AbortError" || error.message === "Request aborted");
}

export function throwIfCanceled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new ConvoAbortError();
	}
}

export async function waitForCancelable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) {
		return promise;
	}

	throwIfCanceled(signal);

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(new ConvoAbortError());
		};

		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
