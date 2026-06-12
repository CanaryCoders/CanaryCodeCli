# cc

A fast, minimal terminal coding agent. It runs on the Bun runtime with an [OpenTUI](https://github.com/sst/opentui) TUI and flexible model support. The core stays small. You get the quality-of-life features that matter: plan mode, auto mode, thinking modes, web search, sub-agents, custom agents, MCP, skills, hooks, an AI permission engine, and project-context files.

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
- OpenCode Zen. Use [opencode](https://opencode.ai)'s model gateway inside cc: sign in once with `opencode auth login` (or set `OPENCODE_API_KEY`) and `/login-opencode` makes the whole Zen catalog (Claude, GPT, Qwen, Kimi, GLM, the free stealth models, …) available to `/model`.
- Extension toggles. `/extensions` lists every toggleable feature — `canaryllm`, `codex`, `opencode`, `websearch`, `skills`, `agents`, `mcp`, `hooks` — and `/extensions enable|disable <name>` flips one, persisted to `~/.cc/config.json` under `extensions.<name>`. A disabled extension contributes nothing: no tools, no prompt text, no startup work.
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

### `/config` command

In the TUI, `/config` inspects and edits `~/.cc/config.json` without leaving the session:

```text
/config                         # show the effective config
/config get model               # show raw and effective values for one path
/config set model sonnet
/config set thinking think-hard
/config unset thinking
```

`set` values are parsed as JSON when possible, so booleans, numbers, arrays, and objects can be written directly. Strings can be bare words or JSON strings. Display output redacts secret-looking fields such as `apiKey`; the raw file still preserves literal `${VAR}` references instead of writing interpolated secret values.

Common examples:

```text
/config set webSearch.provider brave
/config set webSearch.apiKey "${BRAVE_API_KEY}"
/config set extensions.opencode false
/config set mcpServers.fs {"command":"mcp-server-filesystem","args":["/path"]}
/config set providers.mycorp {"api":"openai-compat","baseUrl":"https://llm.mycorp.internal/v1","apiKey":"${MYCORP_KEY}","models":[{"id":"company-default"}]}
/config set permission.mode ai
/config set permission.model haiku
/config set permission.scope writes
/config set confirm writes
/config set ui.nerdFont true
/config set autoMaxTurns 40
/config set checkpointEvery 8
/config set compactAtTokens 120000
/config set maxConcurrent 4
/config set maxDepth 2
/config set models.reasoning opus
/config set models.coding sonnet
/config set models.subagent haiku
/config set models.permission haiku
/config set hooks.PreToolUse [{"matcher":"bash|write_file|edit_file","hooks":[{"type":"command","command":"./scripts/guard.sh","timeout":10}]}]
/config set autoUpdate.enabled false
/config reload                  # reload config from disk
/config reload mcp              # reload config and reconnect MCP servers
```

### UI

The TUI defaults to ASCII-safe icons. If your terminal uses a Nerd Font, enable richer glyphs with:

```json
{ "ui": { "nerdFont": true } }
```

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

### OpenCode Zen

[Zen](https://opencode.ai/docs/zen) is opencode's OpenAI-compatible model gateway (`https://opencode.ai/zen/v1`). cc ships a baked-in preset that stays inert until credentials appear; nothing is written to `config.json`:

1. Sign in once: `opencode auth login` → pick "opencode" (or set `OPENCODE_API_KEY` in your environment).
2. `cc login-opencode` (or `/login-opencode` in the TUI) picks the key up from opencode's credential store (`~/.local/share/opencode/auth.json`) and lists the Zen catalog; switch with `/model <id>`.

The model list mirrors opencode's local models.dev cache (with a static fallback), so it tracks Zen's catalog without a network call. `logout-opencode` hides the models for the session; the credentials themselves belong to opencode (`opencode auth logout` removes them). Note: cc only reads Zen API keys from opencode's store — it never touches the Anthropic/OpenAI subscription OAuth tokens opencode may also hold, since refreshing those from a second client would invalidate opencode's own sign-in.

### Extension toggles

Bare `/extensions` opens an interactive checkbox picker: ↑/↓ move, Space flips a checkbox, Enter applies every change at once (one session reassembly), Esc cancels. `/extensions enable|disable <name>` flips one directly. Either way a change persists as `extensions.<name>` in `~/.cc/config.json` and applies immediately.

A disabled extension contributes **nothing** — enforced by the registry kernel, not by the extension itself:
- no commands (absent from `/help`, autocomplete, slash dispatch, and `cc <subcommand>`)
- no startup work and no provider preset (provider presets are folded into config for enabled extensions only)
- no session pieces (no tools, no system-prompt section, no tool hooks)

Core plumbing (the six core tools, `ask_user`, `update_tasks`, the permission engine) is not toggleable.

### User extensions

Drop `.ts` or `.js` modules into `~/.cc/extensions/` (user-global, implicitly trusted) or `./.cc/extensions/` (project-level). Project extensions require approval on first load: the TUI prompts before first paint, distinguishing a first-ever approval from a file that changed since the last one; headless skips unapproved files with a note. Approvals are tracked by content hash in `~/.cc/trusted-extensions.json`.

An extension's **name is its filename stem** — any `name` field inside the module is overridden. This means the `extensions.<name>: false` config toggle is decidable before the file is even imported; a disabled file is never executed, but an inert stub keeps it listed in `/extensions` so it can be re-enabled. Name collisions with built-ins or with a user-global file are skipped with a note. A broken or invalid module is always skipped with a note; a user extension can never crash `cc`. Changed files take effect on the next launch (Bun module cache).

A minimal example:

```ts
// ~/.cc/extensions/greet.ts
export default {
  description: "demo extension",
  commands: [
    {
      name: "greet",
      description: "say hello from a user extension",
      run: async (ctx) => ctx.note("hello from the greet extension!"),
    },
  ],
};
```

User extensions have the same capabilities as built-ins: provider presets, startup discovery, login-style commands (`cc <name>` and `/<name>`), and full session extensions (tools, system-prompt section, pre/post tool hooks) via `session()`.

### MCP servers

```json
{
  "mcpServers": {
    "fs": { "command": "mcp-server-filesystem", "args": ["/path"] },
    "remote": { "url": "https://mcp.example.com/sse" }
  }
}
```

> **Token cost:** while a server is connected, every MCP tool's name,
> description, and input schema is sent with each request — popular servers
> add thousands of tokens per turn. For tools you use occasionally, a skill
> or a plain CLI invoked via `bash` is cheaper: the agent reads the docs only
> when it actually needs them.

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
- `failClosed`: `false` (default) or `true` — when the checker errors or can't run, treat the call as unsafe instead: headless blocks it, the TUI escalates to the human confirm box.

The checker runs one-shot and tool-free. It fails open by default, so a network or parse error counts as safe and a flaky checker degrades to running the tool rather than wedging the agent; set `failClosed` to flip that. Auto and `--yolo` skip the checker entirely — including the `failClosed` policy.

### Hooks

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|write_file|edit_file",
        "hooks": [
          { "type": "command", "command": "./scripts/guard.sh", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "./scripts/log.sh" }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }]
  }
}
```

Hooks follow Claude Code's matcher-group shape: event names map to arrays of groups, each group has an optional `matcher` and a `hooks` array of command hooks. `timeout` is seconds in this Claude-style shape. The older cc shorthand still works for compatibility (`{ "matcher": "bash", "command": "...", "timeout": 10000 }`, timeout in milliseconds).

Supported events are `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStop`, and `SessionEnd`. `matcher` is a regex on the cc tool name for tool events; omitting it matches all tools. Commands run through `bash -c` and receive Claude-style JSON on stdin with fields such as `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, and `tool_response`; legacy aliases (`event`, `tool`, `input`, `result`, `isError`) are also included. `PreToolUse` can block with Claude-style JSON stdout (`permissionDecision: "deny"`) or by exiting non-zero; the reason is sent back to the model. Other events are observational. Hooks run in every mode, including auto, and `Stop`/`SessionEnd` also run on TUI quit so external state trackers can observe shutdown.

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

`/model`, `/think`, `/plan`, `/auto`, `/normal`, `/config`, `/extensions`, `/login-codex`, `/logout-codex`, `/login-opencode`, `/logout-opencode`, `/clear`, `/resume`, `/cost`, `/init`, `/update`, `/help`, `/exit`.

`/config` supports `/config` (show effective config), `/config get <path>`, `/config set <path> <value>`, `/config unset <path>`, `/config reload`, and `/config reload mcp` (reload config and reconnect MCP servers).

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome lint ./src
bun run format      # biome format --write ./src
bun run check       # biome check ./src && tsc --noEmit
bun test            # run the unit tests
```

`cc` uses the Bun runtime and ESNext modules with no build step. `.ts` runs directly. The core targets under ~2000 LOC; keep new dependencies minimal and intentional.

## Architecture & extending

`cc` follows a small-core design (inspired by [Pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)): the core is the agent loop (`src/agent.ts`), the provider layer (`src/provider.ts`), the core tool set (`src/tools.ts`, frozen), and session storage. Everything else — web search, skills, sub-agents, MCP, hooks, the AI permission engine, the task list — is an `Extension` (`src/extension.ts`): a named bundle covering two lifecycles in one interface.

**`Extension` interface** (`src/extension.ts`): `{ name, description, defaultEnabled?, providerPresets?(), startup?(config, "fast"|"live"), commands?, session?() }`. The outer lifecycle (`providerPresets`, `startup`, `commands`) runs once per process. The per-session lifecycle is produced by the `session()` factory, which returns a fresh `SessionExtension` for each agent assembly; this keeps session state (MCP connections, tool instances) from leaking across sessions.

**`src/extensions/registry.ts`** is the single config-aware authority. It holds the built-in extension list and the user-loaded list together. Whether an extension is enabled (via `extensions.<name>` in config, toggled by `/extensions`) is decided here and nowhere else — extensions never self-check their own toggle. A disabled extension contributes nothing: no commands, no startup work, no provider presets, no session pieces.

To add a built-in feature: write a module in `src/extensions/<name>.ts` exporting an `Extension` and add it to `BUILTIN_EXTENSIONS` in `registry.ts`. To remove one: delete its file and its entry. Extensions that are disabled or not configured contribute nothing — no tokens, no startup work, no prompt text.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0. Noncommercial use and forks are permitted under the terms of `LICENSE`; commercial use requires a separate commercial license from Canary Coders.
