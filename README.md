# cc

A fast, minimal terminal coding agent. Bun runtime, [Ink](https://github.com/vadimdemedes/ink) TUI, flexible model support. Tiny core, the Claude-Code quality-of-life features that matter — **plan mode, auto mode, thinking modes, web search** — plus **sub-agents, MCP, skills, and project-context files**.

Two front-ends, one engine: a headless `-p` print mode for scripting and an interactive TUI, both driving the same agent loop.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun add -g .          # installs the `cc` binary globally
```

Or run it straight from the repo without installing:

```bash
bun run src/index.ts -p "say hi"
# or
bun run dev
```

## Usage

```bash
cc -p "<prompt>"   # headless print mode — streams to stdout, exits
cc                 # interactive TUI (Ink) in the current directory
```

### Flags

| Flag | Description |
| --- | --- |
| `-p, --print <s>` | Run a single prompt headless |
| `--model <id>` | Override the configured model |
| `--think [level]` | Extended thinking: `off` \| `think` \| `think-hard` \| `ultrathink` (also triggered by a keyword in the prompt) |
| `--plan` | Planning mode: investigate read-only, emit a structured plan, stop |
| `--auto, --yolo` | Autonomous mode: run to completion, no confirmations (capped at `autoMaxTurns`, default 25) |
| `--no-tools` | Disable tools (read-only quick Q&A) |
| `--resume [id]` | Continue a saved session (most recent if id omitted); bare `--resume` with no prompt lists recent sessions |
| `-h, --help` | Show help |
| `--version` | Show version |

Stdin is folded into the prompt as context:

```bash
git diff | cc -p "write a commit message"
```

Resume a conversation:

```bash
cc --resume                   # list recent sessions
cc --resume -p "and now?"     # continue the most recent session
cc --resume 1a2b3c4d -p "…"   # continue a session by id (prefix ok)
```

## Features

- **Plan mode** — runs read-only (`read_file`, `list_dir`, `grep`, `web_search` allowed; write/edit/bash blocked) and emits a structured plan: steps, files to touch, risks.
- **Auto mode** — autonomous multi-turn execution with no per-step input, bounded by `autoMaxTurns`. `Esc` aborts.
- **Thinking modes** — map to Anthropic extended-thinking budgets (`off`/`think` 4k/`think-hard` 10k/`ultrathink` 32k). Non-Anthropic providers degrade gracefully.
- **Web search** — a read-only `web_search` tool with a pluggable HTTP backend (Brave / Tavily) configured in `webSearch`.
- **Sub-agents** — a `spawn_agent` tool delegates focused work to a child agent with its own fresh context; bounded by `maxConcurrent` / `maxDepth`.
- **MCP** — connect stdio + SSE MCP servers from config; their tools merge in namespaced as `mcp__<server>__<tool>`.
- **Skills** — progressive-disclosure capabilities from `~/.cc/skills/` and `./.cc/skills/`; only name+description load into the prompt, bodies are read on demand via `read_skill`.
- **Project context** — walking up to the repo root, prepends `CC.md` > `AGENTS.md` > `CLAUDE.md` (first found wins) to the system prompt.

## Tools

`read_file`, `write_file`, `edit_file`, `list_dir`, `bash`, `grep`, `web_search`, `spawn_agent`, `read_skill`, plus any MCP tools. Each tool carries a `readOnly` flag — plan mode filters on it.

## Configuration

Config lives at `~/.cc/config.json`. `${VAR}` references are interpolated from the environment. Sessions are stored in `~/.cc/sessions.db` (SQLite).

Model resolution order: `--model <id>` > config `model` > first available. `/model` lists and switches at runtime in the TUI.

### Custom providers

`cc` supports custom OpenAI-compatible and Anthropic-compatible gateways:

```json
{
  "model": "company-default",
  "providers": {
    "anthropic": {
      "api": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}"
    },
    "mycorp": {
      "api": "openai-compat",
      "baseUrl": "https://llm.mycorp.internal/v1",
      "apiKey": "${MYCORP_KEY}",
      "models": [
        { "id": "company-default" },
        { "id": "company-fast" }
      ]
    }
  }
}
```

### Web search

```json
{
  "webSearch": { "provider": "brave", "apiKey": "${BRAVE_API_KEY}" }
}
```

### MCP servers

```json
{
  "mcpServers": {
    "fs": { "command": "mcp-server-filesystem", "args": ["/path"] },
    "remote": { "url": "https://mcp.example.com/sse" }
  }
}
```

## Safety stance

`cc` is intentionally unsandboxed and has **no permission-approval engine** — that is a deliberate non-goal to keep the core small. In normal mode, tool calls run as you invoke them; `--auto`/`--yolo` additionally skips any pausing and runs to completion. Run it in a directory you trust, prefer `--plan` or `--no-tools` for untrusted work, and review what auto mode does. `Esc` (TUI) and `Ctrl+C` (headless) abort an in-flight run.

## Slash commands (TUI)

`/model`, `/think`, `/plan`, `/auto`, `/normal`, `/clear`, `/resume`, `/cost`, `/init`, `/help`, `/exit`.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run check       # same (types)
```

Bun runtime, ESNext modules, no build step — `.ts` runs directly. The core targets under ~2000 LOC; new dependencies are justified in `PROGRESS.md`.
