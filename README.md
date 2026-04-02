# Convo GPT

OpenAI-first markdown-native conversations inside Obsidian notes.

## Features

- Section-based chat format inside a markdown note
- OpenAI-only requests with per-note frontmatter overrides
- Agent prompts loaded from a configurable agent folder
- One-level note reference expansion for `[[Wiki Links]]` and markdown note links
- OpenAI native `web_search`
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

Merge precedence:

- Plugin settings provide the defaults.
- Agent frontmatter can override those defaults.
- The chat note frontmatter wins over both.

System prompt assembly order:

- Default system prompt from plugin settings
- Agent file body
- `system_commands` from the agent, then from the note

If `Agent folder` is blank, agents are effectively disabled. If a note still sets `agent: ...`, Convo GPT shows a notice and continues without the agent.

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
