import { describe, expect, it } from "vitest";
import { ConvoAbortError, PluginActiveRequestManager, isConvoAbortError, waitForCancelable } from "../core/active-request-manager";

describe("PluginActiveRequestManager", () => {
	it("cancels the active request and allows a later request to start after finish", () => {
		const manager = new PluginActiveRequestManager();
		const first = manager.beginActiveRequest();

		expect(first).not.toBeNull();
		expect(manager.beginActiveRequest()).toBeNull();
		expect(manager.cancelActiveRequest()).toBe(true);
		expect(first?.signal.aborted).toBe(true);

		first?.finish();

		const second = manager.beginActiveRequest();
		expect(second).not.toBeNull();
	});

	it("reports when there is no active request to cancel", () => {
		const manager = new PluginActiveRequestManager();

		expect(manager.cancelActiveRequest()).toBe(false);
	});

	it("rejects cancelable waits with a ConvoAbortError", async () => {
		const manager = new PluginActiveRequestManager();
		const active = manager.beginActiveRequest();

		expect(active).not.toBeNull();

		const pending = waitForCancelable(new Promise<void>(() => undefined), active!.signal);
		manager.cancelActiveRequest();

		await expect(pending).rejects.toBeInstanceOf(ConvoAbortError);
		expect(isConvoAbortError(new ConvoAbortError())).toBe(true);
	});
});
