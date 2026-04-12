let debugLoggingEnabled = false;

export function setConvoDebugLoggingEnabled(enabled: boolean): void {
	debugLoggingEnabled = enabled;
}

export function logConvoDebug(event: string, details?: Record<string, unknown>): void {
	if (!debugLoggingEnabled) {
		return;
	}

	if (details) {
		console.info("[Convo GPT debug]", event, details);
		return;
	}

	console.info("[Convo GPT debug]", event);
}
