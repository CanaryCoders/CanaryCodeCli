# cc

A fast, minimal terminal coding agent. It runs on the Bun runtime with an [Ink](https://github.com/vadimdemedes/ink) TUI and flexible model support. The core stays small. You get the quality-of-life features that matter: plan mode, auto mode, thinking modes, web search, sub-agents, custom agents, MCP, skills, hooks, an AI permission engine, and project-context files.

One engine drives two front-ends. A headless `-p` print mode handles scripting. An interactive TUI handles live work. Both run the same agent loop.

## Install

### Quick install (prebuilt binary)

A single self-contained binary — no Bun or Node required:

```bash
curl -fsSL https://raw.githubusercontent.com/CanaryCoders/CanaryCodeCli/main/install.sh | sh
```

It downloads the binary for your platform from the latest [GitHub Release](https://github.com/CanaryCoders/CanaryCodeCli/releases), verifies its checksum, and installs it to `~/.local/bin` (override with `CC_INSTALL_DIR`, or pin a version with `CC_VERSION=v0.1.0`). Update later with `cc update`.

### Nix

Run without installing:

```bash
nix run github:CanaryCoders/CanaryCodeCli
```

Or add it to a Home Manager config (flake input named `cc`):

```nix
{
  inputs.cc.url = "github:CanaryCoders/CanaryCodeCli";

  # in your home-manager configuration:
  imports = [ cc.homeManagerModules.default ];
  programs.cc = {
    enable = true;
    # optional — renders a read-only ~/.cc/config.json:
    # settings = { model = "opus"; thinking = "off"; };
  };
}
```

Nix installs are immutable, so self-update is disabled automatically — bump the flake input to upgrade.

### From source

You need [Bun](https://bun.sh).

```bash
bun install
bun add -g .          # installs the `cc` binary globally
```

Run it from the repo without installing:

```bash
bun run src/index.ts -p "say hi"
# or
bun run dev
```

## Updating

Binary installs (via `install.sh`) self-update. On startup `cc` checks GitHub Releases at most once a day in the background; when a newer version is available the TUI banner shows a notice. Apply it with:

```bash
cc update     # or /update inside the TUI
```

Auto-update never mutates anything on its own — it only checks and notifies. Disable the check entirely with `autoUpdate.enabled: false` in `~/.cc/config.json` or by setting `CC_DISABLE_UPDATE=1`. Source checkouts (update with `git`) and Nix installs never self-update.

## Usage

```bash
cc -p "<prompt>"   # headless print mode: streams to stdout, then exits
cc                 # interactive TUI in the current directory
```

### Flags

| Flag | Description |
| --- | --- |
| `-p, --print <s>` | Run a single prompt headless |
| `--model <id>` | Override the configured model |
| `--think [level]` | Extended thinking: `off`, `think`, `think-hard`, or `ultrathink` (a keyword in the prompt triggers this too) |
| `--plan` | Planning mode: investigate read-only, emit a structured plan, then stop |
| `--auto, --yolo` | Autonomous mode: run to completion with no confirmations (capped at `autoMaxTurns`, default 25) |
| `--no-tools` | Disable tools for read-only quick Q&A |
| `--resume [id]` | Continue a saved session (most recent when you omit the id). Bare `--resume` with no prompt lists recent sessions |
| `--json` | Stream structured JSON events (JSONL) on stdout, one event per line, for scripting |
| `--no-color` | Force raw markdown to stdout even on a TTY (also honors `NO_COLOR`) |
| `-h, --help` | Show help |
| `--version` | Show version |

Stdin folds into the prompt as context:

```bash
git diff | cc -p "write a commit message"
```

Resume a conversation:

```bash
cc --resume                   # list recent sessions
cc --resume -p "and now?"     # continue the most recent session
cc --resume 1a2b3c4d -p "…"   # continue a session by id (prefix is fine)
```

Pipe structured events into a script:

```bash
cc -p "list the files then read package.json" --json | jq -c 'select(.type=="tool_start")'
```

Each line is a JSON `AgentEvent`: `text`, `thinking`, `tool_start {id,name,input}`, `tool_end {id,name,isError,result,diff?}`, `usage`, `compaction`, `done {reason}`, or `{type:"error",message}`. JSON mode suppresses human formatting. Startup notes stay on stderr.

## Features

- Plan mode. Runs read-only and allows `read_file`, `list_dir`, `grep`, and `web_search`. It blocks write, edit, and bash. It emits a structured plan with steps, files to touch, and risks.
- Auto mode. Runs autonomous multi-turn execution with no per-step input, bounded by `autoMaxTurns`. `Esc` aborts.
- Thinking modes. They map to Anthropic extended-thinking budgets: `off`, `think` at 4k, `think-hard` at 10k, `ultrathink` at 32k. Non-Anthropic providers degrade gracefully. Setting a level with `/think` writes it to `~/.cc/config.json` under the `thinking` key, so it becomes the default on the next launch. `--think` overrides it for one run without changing the saved default.
- Web search. A read-only `web_search` tool works with no key by default through a free DuckDuckGo backend. You can configure Brave or Tavily backends under `webSearch`.
- Sub-agents. A `spawn_agent` tool delegates focused work to a child agent with its own fresh context, bounded by `maxConcurrent` and `maxDepth`.
- Custom agents. You define personas as files in `~/.cc/agents/` and `./.cc/agents/`. Frontmatter sets `name`, `description`, an optional `model`, and an optional `tools` allowlist. The body is the system prompt. Each name and description loads into the prompt. `spawn_agent` dispatches to one by `agent` name and applies its persona, model, and tool restrictions.
- AI permission engine. Opt in with `permission.mode: "ai"`. A separate cheap model classifies each gated mutating tool call as safe or unsafe before it runs. Safe calls run silently. Unsafe calls escalate to the human y/n/a box in the TUI with the reason, or block the call when headless. Auto and `--yolo` skip it.
- Hooks. Shell commands fire on lifecycle events: `PreToolUse`, `PostToolUse`, and `Stop`. A regex on the tool name matches them. A non-zero `PreToolUse` exit blocks the call and its output becomes the reason the model sees. The rest observe only. Hooks run in every mode.
- MCP. Connect stdio and SSE MCP servers from config. Their tools merge in namespaced as `mcp__<server>__<tool>`.
- Skills. Progressive-disclosure capabilities live in `~/.cc/skills/` and `./.cc/skills/`. Only the name and description load into the prompt. The agent reads bodies on demand through `read_skill`.
- Tasks. The agent tracks its own todo list through `update_tasks`. The TUI renders it live as a panel. Headless prints a compact checklist to stderr. The list is read-only and ephemeral.
- Ask user. The `ask_user` tool lets the agent ask you multiple-choice questions and wait for your answer. The TUI shows the choices. Headless auto-picks each question's recommended option.
- Project context. Walking up to the repo root, it prepends the first file it finds in this order: `CC.md`, then `AGENTS.md`, then `CLAUDE.md`. `/init` scaffolds a starter `CC.md`.
- Diff preview. Every `write_file` and `edit_file` shows a unified diff of the change. It colorizes on a TTY. The TUI collapses it to a `+N -M` summary you can expand.
- Markdown rendering. Assistant text renders as styled terminal output with bold, headings, lists, and code fences. Under a pipe, `--json`, or `NO_COLOR` it stays raw.
- Command visibility. The exact `bash` command and every tool call shows before it runs, with no truncation.

## Tools

`read_file`, `write_file`, `edit_file`, `list_dir`, `bash`, `grep`, `web_search`, `spawn_agent`, `read_skill`, `update_tasks`, `ask_user`, plus any MCP tools. Each tool carries a `readOnly` flag. Plan mode filters on it.

## Configuration

Config lives at `~/.cc/config.json`. `${VAR}` references interpolate from the environment. Sessions store at `~/.cc/sessions.db` in SQLite.

Model resolution order: `--model <id>`, then config `model`, then the first available model. `/model` lists and switches at runtime in the TUI.

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

### CanaryLLM

[CanaryLLM](https://canaryllm.canarycoders.es) is a multi-provider gateway with OpenAI- and Anthropic-compatible endpoints. It ships baked in as a `canaryllm` provider. It stays inert until you set `CANARYLLM_API_KEY`. Once the key is present, `cc` discovers the gateway's chat models from the unauthenticated `GET /api/public/models` and makes them selectable through `--model <id>` and `/model`. You need no extra config:

```bash
export CANARYLLM_API_KEY=sk-...
cc --model <a-canary-model-id> -p "say hi"
```

The preset is an `openai-compat` provider pinned to `https://canaryllm.canarycoders.es/v1`. The spec's `servers` list is localhost-only, so the base URL is hard-set. To use the Anthropic-compatible path instead, declare your own provider against `/v1/messages` with `"api": "anthropic"`.

### Web search

Web search works with no API key. It defaults to a free DuckDuckGo backend that scrapes the no-JS results page and is subject to DuckDuckGo rate limits. For higher reliability and volume, point it at a keyed provider:

```json
{
  "webSearch": { "provider": "brave", "apiKey": "${BRAVE_API_KEY}" }
}
```

`provider` accepts `"duckduckgo"` (default, keyless), `"brave"`, or `"tavily"`. When DuckDuckGo returns a challenge page from a rate limit, retry shortly or switch to a keyed provider.

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

Drop a markdown file in `~/.cc/agents/<name>.md` for a global agent or `./.cc/agents/<name>.md` for a project agent. The project file overrides the global one. The frontmatter configures the agent. The body is the agent's system prompt:

```markdown
---
name: test-writer
description: Writes thorough unit tests for a given module.
model: haiku                        # optional, defaults to the parent's model
tools: read_file, grep, write_file  # optional, defaults to the full inherited set
---
You are a meticulous test engineer. Given a module, write comprehensive tests…
```

The model delegates to it through `spawn_agent` with `{ "agent": "test-writer", "task": "…" }`.

### AI permission engine

```json
{ "permission": { "mode": "ai", "model": "haiku", "scope": "writes" } }
```

- `mode`: `"off"` (default, falls back to the deterministic `confirm` gate) or `"ai"`.
- `model`: the checker model id (any configured model, defaults to a cheap one).
- `scope`: `"bash"` or `"writes"` (bash plus write_file plus edit_file).

The checker runs one-shot and tool-free. It fails open, so a network or parse error counts as safe and a flaky checker degrades to running the tool rather than wedging the agent. Auto and `--yolo` skip it.

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

`matcher` is a regex on the tool name. Omitting it matches all tools. The command runs through `bash -c` and receives a JSON payload on stdin (`{ event, tool, input }`, plus `result` and `isError` for `PostToolUse`). A non-zero `PreToolUse` exit blocks the call and its output becomes the reason the model sees. `PostToolUse` and `Stop` are fire-and-forget. Each hook is timeout-bounded with a 10s default. Hooks run in every mode, including auto.

## Safety stance

`cc` runs unsandboxed by design. By default there is no automatic gating. Tool calls run as you invoke them. `--auto` and `--yolo` skip any pausing and run to completion. Run it in a directory you trust. Prefer `--plan` or `--no-tools` for untrusted work, and review what auto mode does. `Esc` in the TUI and `Ctrl+C` in headless abort an in-flight run.

For tighter control, three opt-in gates compose in a single pre-tool pipeline: `PreToolUse` hooks, then the AI permission check, then the human confirm. Hooks give you deterministic policy. The AI permission engine gives you model-judged safety. The confirm gate below gives you a human checkpoint. Auto and `--yolo` bypass the AI and human gates, and hooks still run.

For a lighter check than the AI engine, the TUI supports an opt-in confirm gate through the `confirm` config key. It applies only when `permission.mode` is `"off"`, since the AI engine supersedes it:

```json
{ "confirm": "writes" }
```

- `"off"` (default) runs everything.
- `"bash"` pauses and shows the full command before each `bash` run.
- `"writes"` pauses before `bash`, `write_file`, and `edit_file`, showing the command or a diff preview, with `[y]es · [n]o · [a]lways (this session)`.

Auto mode and `--yolo` bypass the gate. Plan mode never reaches mutating tools. Headless is non-interactive, so it ignores `confirm`. Use `--auto` to grant write and bash access unattended, or `permission.mode: "ai"` to gate it automatically.

## Slash commands (TUI)

`/model`, `/think`, `/plan`, `/auto`, `/normal`, `/clear`, `/resume`, `/cost`, `/init`, `/help`, `/exit`.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome lint ./src
bun run format      # biome format --write ./src
bun run check       # biome check ./src && tsc --noEmit
bun test            # run the unit tests
```

`cc` uses the Bun runtime and ESNext modules with no build step. `.ts` runs directly. The core targets under ~2000 LOC. New dependencies are justified in `PROGRESS.md`.
