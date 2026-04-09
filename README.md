# Convo GPT

OpenAI-first markdown-native conversations inside Obsidian notes.

## Features

- Section-based chat format inside a markdown note
- OpenAI-only requests with per-note frontmatter overrides
- Agent prompts loaded from a configurable agent folder
- On-demand linked file reads for chat notes and agent prompts, with configurable supported extensions
- On-demand HTTP fetch tool for explicit `http(s)` URLs with custom headers and basic API-call support
- Markdown file save tool for creating or updating other notes with approval
- Linked document mode for proposal/email/article style drafting against a bound markdown file
- OpenAI native `web_search`
- Bottom-of-answer appendices for web sources, referenced files, and fetch calls when used
- Jump links at the end of every assistant response

## Development

1. Run `npm install`.
2. Run `npm run dev` to rebuild the root `main.js` on change for local vault development.
3. Reload Obsidian after each rebuild.

## Install into a vault

```bash
npm run install:vault -- /path/to/your/vault
```

The install script always runs the production build first, then copies `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` into `.obsidian/plugins/convo-gpt/` inside the given vault.

## Agents

Agents are markdown files that Convo GPT can load as an extra system prompt layer for a note.

To use agents:

1. Set `Agent folder` in the plugin settings to the folder where you keep agent notes.
2. Add `agent: your-agent-name` to the frontmatter of the chat note.
3. Create a markdown file in the configured agent folder whose basename matches that value.

Example chat note:

```md
---
agent: writing-coach
document: [[Drafts/Proposal]]
model: openai@gpt-5.4
---

# _You 1_

Help me rewrite this paragraph.
```

Example agent file at `Agents/writing-coach.md`:

```md
---
model: openai@gpt-5.4
temperature: 0.4
max_tokens: 3000
openai_native_web_search: false
system_commands:
  - Prefer concise edits.
  - Explain major changes briefly.
---

You are a writing coach working inside an Obsidian note.
Focus on clarity, rhythm, and specific revision suggestions.
```

How agent resolution works:

- The plugin looks only in the configured `Agent folder`.
- The file match is basename-based, so `agent: writing-coach` matches `writing-coach.md`.
- The agent file body becomes a system prompt.
- Supported agent frontmatter overrides are `model`, `temperature`, `max_tokens`, `stream`, `system_commands`, `baseUrl`, and `openai_native_web_search`.

## Linked documents

Chat notes can be bound to one markdown document that acts as the live drafting target for that note.

How document mode activates:

- Set `document: [[Drafts/Proposal]]` in the chat note frontmatter to bind the note to a document explicitly.
- If `document` is not set yet, the plugin will infer and persist it from the first explicit markdown save target the user names, such as `Stories/story.md` or `[[Stories/story]]`.
- If the chat note itself is named like `Something chat.md`, the plugin can infer a sibling linked document on first use even without an explicit target.

How the linked document is named:

- When inferring a linked document from a chat note, the plugin tries to name the document from the user's first request instead of defaulting to `doc.md`.
- Example: `help me create a story in a document` can infer `[[Story]]`.
- Example: `help me write an email in a document that asks a new lead to book a call with me` can infer a document name based on that request instead of `doc`.
- If the request does not produce a usable title, the chat-note basename is used as a fallback.

How document mode behaves:

- On every chat turn, Convo GPT reads the latest contents of the linked document and includes them in the request context.
- If the latest user message is asking for document changes, Convo GPT updates that bound file directly without asking for approval again.
- Short follow-up replies in an ongoing drafting flow, such as `#3`, `funny and short`, or similar selection-style replies, continue document drafting instead of falling back to plain chat.
- Clearly read-only requests such as summaries, discussion, or review should not write to the document.
- For create, write, draft, compose, or update requests, document mode is intended to save to the linked document in the same turn rather than only returning pasteable text in chat.

How document mode presents results:

- Assistant replies that mention the linked document path are rewritten as clickable wiki links such as `[[Drafts/Proposal]]` instead of raw file paths like ``Drafts/Proposal.md``.
- Writes without approval are limited to the bound linked document. Other markdown file writes still follow the normal approval flow.

Example:

```md
---
document: [[Drafts/Proposal]]
---

# _You (1)_

Draft a short proposal for a consulting kickoff.
```

In that note:

- The linked file `Drafts/Proposal.md` is loaded fresh on every turn.
- A drafting request updates that file directly.
- The assistant response should refer to the result as `[[Drafts/Proposal]]`.

Merge precedence:

- Plugin settings provide the defaults.
- Agent frontmatter can override those defaults.
- The chat note frontmatter wins over both.

System prompt assembly order:

- Default system prompt from plugin settings
- Agent file body
- `system_commands` from the agent, then from the note

If `Agent folder` is blank, agents are effectively disabled. If a note still sets `agent: ...`, Convo GPT shows a notice and continues without the agent.

## Tools

Convo GPT can expose a small set of model tools during a chat turn when the current message calls for them.

### Referenced file reads

- The plugin can read linked files from the current chat note or active agent prompt on demand instead of inlining them up front.
- Supported extensions are configurable in plugin settings. The default list is `md, txt, csv, json, yaml`.
- When referenced files are used, the assistant appends a `### Referenced files` block at the bottom of the answer with clickable `[[wiki links]]`.

### Fetch

- The fetch tool is only exposed when the current user message includes an explicit `http://` or `https://` URL.
- It supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `HEAD`.
- Requests can include custom headers such as `Authorization` and `Content-Type`.
- Response bodies are returned to the model as text and may be truncated.
- When fetch is used successfully, the assistant appends a `### Fetch calls` block at the bottom of the answer with method, URL, and status code.

### Markdown file saves

- The markdown save tool lets the model create, replace, append to, or inspect another vault markdown file.
- The tool is only exposed when the user explicitly names the markdown target, such as `story.md`, `Stories/story.md`, or `[[Stories/story]]`.
- Linked document mode is the exception: if the chat note is already bound to a `document`, edit requests can save to that bound file without the user restating the path.
- Writes require explicit user approval before they are applied.
- If the user asks to save without naming a target, the model should ask where to save instead of inferring a previous destination.
- The tool is intended for `.md` files only.

## Settings

Notable plugin settings:

- `Agent folder`: folder used to resolve markdown-based agents by basename.
- `Enable OpenAI native web search`: enables provider-native `web_search` when the selected model supports it.
- `Enable fetch tool`: allows the model to make outbound HTTP or HTTPS requests for explicit URLs.
- `Enable markdown file save tool`: allows the model to request markdown file writes with approval.
- `Enable referenced file read tool`: allows the model to read linked files on demand.
- `Referenced file extensions`: comma-separated list of readable linked file extensions.

## Quality checks

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run check`

## Build output

- `npm run build` creates `dist/`.
- `dist/` contains `main.js`, `manifest.json`, and `styles.css`.
- Copy or symlink the contents of `dist/` into your Obsidian plugin folder when packaging or installing outside the repo.

## Release

1. Update `manifest.json.minAppVersion` if compatibility changes.
2. Run `npm version patch`, `npm version minor`, or `npm version major`.
3. Attach the contents of `dist/` to the GitHub release.

## Author

- Author: [Greg Allen](https://github.com/jgallen23)
