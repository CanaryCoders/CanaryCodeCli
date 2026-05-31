# cc

A fast, minimal terminal coding agent. Bun runtime, [Ink](https://github.com/vadimdemedes/ink) TUI, flexible model support. Tiny core, the Claude-Code quality-of-life features that matter — **plan mode, auto mode, thinking modes, web search** — plus **sub-agents, custom agents, MCP, skills, hooks, an AI permission engine, and project-context files**.

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
| `--json` | Stream structured JSON events (JSONL) on stdout — one event per line, for scripting |
| `--no-color` | Force raw markdown to stdout even on a TTY (also honoured: `NO_COLOR`) |
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

Pipe structured events into a script:

```bash
cc -p "list the files then read package.json" --json | jq -c 'select(.type=="tool_start")'
```

Each line is a JSON `AgentEvent`: `text`, `thinking`, `tool_start {id,name,input}`, `tool_end {id,name,isError,result,diff?}`, `usage`, `compaction`, `done {reason}`, or `{type:"error",message}`. Human formatting is suppressed in this mode; startup notes stay on stderr.

## Features

- **Plan mode** — runs read-only (`read_file`, `list_dir`, `grep`, `web_search` allowed; write/edit/bash blocked) and emits a structured plan: steps, files to touch, risks.
- **Auto mode** — autonomous multi-turn execution with no per-step input, bounded by `autoMaxTurns`. `Esc` aborts.
- **Thinking modes** — map to Anthropic extended-thinking budgets (`off`/`think` 4k/`think-hard` 10k/`ultrathink` 32k). Non-Anthropic providers degrade gracefully. Setting a level with `/think` persists it to `~/.cc/config.json` (the `thinking` key) so it's the default on the next launch; `--think` overrides it for one run without changing the saved default.
- **Web search** — a read-only `web_search` tool with a pluggable HTTP backend (Brave / Tavily) configured in `webSearch`.
- **Sub-agents** — a `spawn_agent` tool delegates focused work to a child agent with its own fresh context; bounded by `maxConcurrent` / `maxDepth`.
- **Custom agents** — file-defined personas in `~/.cc/agents/` and `./.cc/agents/` (frontmatter `name`/`description`/optional `model`/optional `tools` allowlist + a system-prompt body). Their name+description load into the prompt; `spawn_agent` dispatches to one by `agent` name, applying its persona, model, and tool restrictions.
- **AI permission engine** — opt-in (`permission.mode: "ai"`): a separate, cheap model classifies each gated mutating tool call as safe/unsafe before it runs. Safe runs silently; unsafe escalates to the human y/n/a box (TUI, showing the reason) or blocks the call (headless). Auto/`--yolo` bypass it.
- **Hooks** — shell commands fired on lifecycle events (`PreToolUse`/`PostToolUse`/`Stop`), matched by a regex on the tool name. A non-zero `PreToolUse` exit blocks the call (its output is the reason the model sees); the rest are observational. Hooks run in every mode.
- **MCP** — connect stdio + SSE MCP servers from config; their tools merge in namespaced as `mcp__<server>__<tool>`.
- **Skills** — progressive-disclosure capabilities from `~/.cc/skills/` and `./.cc/skills/`; only name+description load into the prompt, bodies are read on demand via `read_skill`.
- **Project context** — walking up to the repo root, prepends `CC.md` > `AGENTS.md` > `CLAUDE.md` (first found wins) to the system prompt. `/init` scaffolds a starter `CC.md`.
- **Diff preview** — every `write_file` / `edit_file` shows a unified diff of what changed (colourized on a TTY; collapsed `+N -M` summary in the TUI, expandable).
- **Markdown rendering** — assistant text is rendered as styled terminal output (bold, headings, lists, code fences); raw under a pipe / `--json` / `NO_COLOR`.
- **Command visibility** — the exact `bash` command (and every tool call) is always shown before it runs, never truncated.

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

### CanaryLLM (first-class)

[CanaryLLM](https://canaryllm.canarycoders.es) — a multi-provider gateway with OpenAI- and Anthropic-compatible endpoints — ships baked in as a `canaryllm` provider. It stays inert until you set `CANARYLLM_API_KEY`; once the key is present, `cc` discovers the gateway's chat models from the unauthenticated `GET /api/public/models` and makes them selectable via `--model <id>` / `/model`. No extra config needed:

```bash
export CANARYLLM_API_KEY=sk-...
cc --model <a-canary-model-id> -p "say hi"
```

The preset is an `openai-compat` provider pinned to `https://canaryllm.canarycoders.es/v1` (the spec's `servers` list is localhost-only, so the base URL is hard-set). To use the Anthropic-compatible path instead, declare your own provider against `/v1/messages` with `"api": "anthropic"`.

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

### Custom agents

Drop a markdown file in `~/.cc/agents/<name>.md` (global) or `./.cc/agents/<name>.md` (project, overrides global). The frontmatter configures it; the body is the agent's system prompt:

```markdown
---
name: test-writer
description: Writes thorough unit tests for a given module.
model: haiku                        # optional — defaults to the parent's model
tools: read_file, grep, write_file  # optional — defaults to the full inherited set
---
You are a meticulous test engineer. Given a module, write comprehensive tests…
```

The model delegates to it via `spawn_agent` with `{ "agent": "test-writer", "task": "…" }`.

### AI permission engine

```json
{ "permission": { "mode": "ai", "model": "haiku", "scope": "writes" } }
```

- `mode`: `"off"` (default, falls back to the deterministic `confirm` gate) or `"ai"`.
- `model`: the checker model id (any configured model; defaults to a cheap one).
- `scope`: `"bash"` or `"writes"` (bash + write_file + edit_file).

The checker is one-shot and tool-free; it **fails open** (a network/parse error is treated as safe so a flaky checker degrades to running the tool rather than wedging the agent). Auto/`--yolo` skip it.

### Hooks

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "bash|write_file|edit_file", "command": "./scripts/guard.sh" }],
    "PostToolUse": [{ "matcher": ".*", "command": "./scripts/log.sh" }],
    "Stop":        [{ "command": "echo done" }]
  }
}
```

`matcher` is a regex on the tool name (omitted = all tools). The command runs via `bash -c` and receives a JSON payload on stdin (`{ event, tool, input }`, plus `result`/`isError` for `PostToolUse`). A non-zero `PreToolUse` exit **blocks** the call — its output becomes the reason the model sees. `PostToolUse`/`Stop` are fire-and-forget. Each hook is timeout-bounded (default 10s). Hooks run in every mode, including auto.

## Safety stance

`cc` is intentionally unsandboxed. By default there is no automatic gating — tool calls run as you invoke them; `--auto`/`--yolo` additionally skips any pausing and runs to completion. Run it in a directory you trust, prefer `--plan` or `--no-tools` for untrusted work, and review what auto mode does. `Esc` (TUI) and `Ctrl+C` (headless) abort an in-flight run.

For tighter control there are three opt-in gates that compose in a single pre-tool pipeline (`PreToolUse` hooks → AI permission check → human confirm): the **hooks** for deterministic policy, the **AI permission engine** for model-judged safety, and the **confirm gate** below for a human checkpoint. Auto/`--yolo` bypass the AI + human gates (hooks still run).

For a lighter-weight check than the AI engine, the TUI supports an opt-in **confirm gate** via the `confirm` config key (used only when `permission.mode` is `"off"` — the AI engine supersedes it):

```json
{ "confirm": "writes" }
```

- `"off"` (default) — run everything.
- `"bash"` — pause and show the full command before each `bash` run.
- `"writes"` — pause before `bash`, `write_file`, and `edit_file` (showing the command or a diff preview), with `[y]es · [n]o · [a]lways (this session)`.

Auto mode and `--yolo` bypass the gate; plan mode never reaches mutating tools. Headless is non-interactive, so `confirm` is ignored there — use `--auto` to grant write/bash access unattended, or `permission.mode: "ai"` to gate it automatically.

## Slash commands (TUI)

`/model`, `/think`, `/plan`, `/auto`, `/normal`, `/clear`, `/resume`, `/cost`, `/init`, `/help`, `/exit`.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run check       # same (types)
```

Bun runtime, ESNext modules, no build step — `.ts` runs directly. The core targets under ~2000 LOC; new dependencies are justified in `PROGRESS.md`.
