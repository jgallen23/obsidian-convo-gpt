export function getBlankAgentFolderNotice(agentFolder: string, agentName: string): string | null {
	if (agentFolder.trim().length > 0) {
		return null;
	}

	return `Convo GPT agent folder is not configured; skipping agent "${agentName}".`;
}
