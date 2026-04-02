import { Notice, TFile, TFolder, type App } from "obsidian";
import { parseNoteOverrides, stripFrontmatter } from "./frontmatter";
import { getBlankAgentFolderNotice } from "./agent-notices";
import type { AgentDefinition, PluginSettings } from "./types";

export async function resolveAgent(
	app: App,
	settings: PluginSettings,
	agentName: string | undefined,
): Promise<AgentDefinition | null> {
	if (!agentName) {
		return null;
	}

	const blankFolderMessage = getBlankAgentFolderNotice(settings.agentFolder, agentName);
	if (blankFolderMessage) {
		new Notice(blankFolderMessage);
		return null;
	}

	const folder = app.vault.getAbstractFileByPath(settings.agentFolder);
	if (!(folder instanceof TFolder)) {
		new Notice(`Convo GPT agent folder not found: ${settings.agentFolder}`);
		return null;
	}

	const agentFile = folder.children.find((child): child is TFile => child instanceof TFile && child.basename === agentName);
	if (!agentFile) {
		new Notice(`Convo GPT agent not found: ${agentName}`);
		return null;
	}

	const content = await app.vault.read(agentFile);
	const body = stripFrontmatter(content).trim();
	const frontmatter = parseNoteOverrides(app.metadataCache.getFileCache(agentFile)?.frontmatter ?? {});

	return {
		frontmatter,
		body,
		path: agentFile.path,
		file: agentFile,
	};
}
