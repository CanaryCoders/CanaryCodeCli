# Changelog

Release notes for `canarycode`. Each tagged release gets a `## <version>` section here;
the release workflow publishes that section as the GitHub release notes, and
the CLI shows it via `canarycode changelog` / `/changelog` and the post-update
what's-new banner.

Format: [Keep a Changelog](https://keepachangelog.com) headings
(`## <version> - <date>`), newest first.

## 0.4.1 - 2026-11-23

- Model reasoning collapses to one line (`Thought for 34s (120 lines)`), expanded by a click, Enter in nav mode, or ctrl+r. While it streams, only its last three lines show, as plain text.
- The busy row says what is happening in plain words: the running tool and its target, `Thinking`, or `Writing the answer`, with the elapsed time and how to stop.

## 0.4.0 - 2026-11-23

Open-weight models on CanaryLLM (Kimi, GLM, and the local Qwen and Gemma
builds) now work as daily drivers, including the 32k-context local ones.

### Added

- **Context limits per model.** CanaryLLM discovery reads each model's context
  window, output limit and vision support from the catalogue. The completion
  cap, the compaction threshold and the size of a single tool result are
  derived from the window, so a 32k model compacts at about 18k tokens while a
  1M model keeps the configured `compactAtTokens`. Custom providers can set
  `contextWindow` and `maxOutputTokens` on a model by hand.
- **Tool schemas on demand.** When the tool schemas would take more than a
  fifth of the window, MCP tools are left out of the request and reached
  through `describe_tool` and `call_tool`. Three MCP servers used to add about
  22k tokens to every request.
- **Reasoning output on Chat Completions gateways.** `reasoning_content`
  deltas and a leading `<think>` block are shown as thinking, and `/think`
  levels are sent as `reasoning_effort`.
- **Retries.** Requests that fail with a network error or a 408, 429 or 5xx
  status are retried up to three times with backoff.
- **Context usage in the footer** (`ctx 42%`) once a known window is at least
  10% full, and `/model` lists models grouped by upstream, wrapped to the
  terminal, with their window size.
- `CANARYLLM_BASE_URL` points the built-in provider at another CanaryLLM
  instance.

### Changed

- Compaction first clears old tool output and only summarizes when that is not
  enough. A summary keeps the original request word for word and runs on the
  active model instead of the configured default.
- A request rejected for exceeding the context window is compacted and retried
  once instead of ending the run.
- `edit_file` accepts an `old` string that differs from the file only in
  whitespace, or that still carries `read_file` line numbers, when the match is
  unique. A miss names the closest line.
- Tool arguments are coerced toward the schema (`"50"` to `50`, `"true"` to
  `true`, a JSON string to an object) before the tool runs.
- An empty reply gets one follow-up prompt instead of ending the run.
- With only `CANARYLLM_API_KEY` set, the default model is a CanaryLLM model
  instead of an Anthropic one that has no key.
- `autoMaxTurns` defaults to 200 (was 25).
- An MCP server that does not answer within 15 seconds is skipped.

### Fixed

- `canarycode -p` no longer hangs when stdin is open but never written to
  (agent harnesses, CI, service units). It waits two seconds for piped input.
- An error reported by the gateway after the stream started is raised instead
  of being read as an empty reply.

## 0.3.1 - 2026-07-14

### Added

- **Background shells.** The `bash` tool can now start long-lived commands such
  as dev servers with `run_in_background: true`. Background processes stay alive
  across agent turns, retain combined stdout/stderr and exit status for polling
  through `bash_output`, and can be stopped with `bash_kill`. Any remaining
  process group is terminated when the session closes.

## 0.3.0 - 2026-07-09

### Added

- **Interactive checkpointing.** Claude Code sessions can now be checkpointed
  and reseeded, letting you roll a conversation back to an earlier point and
  continue from there.
- **`AskUserQuestion` alias.** The Claude Code loop recognizes the SDK's
  `AskUserQuestion` tool, and the TUI now requires a double `Esc` to dismiss a
  prompt so a question is never closed by accident.
- **File-edit previews for SDK tools.** `Write`/`Edit`/`MultiEdit` executed by
  the Claude Agent SDK now produce a unified diff — reconstructed by snapshotting
  the file before the write and diffing against disk — so the front-ends can
  preview those changes just like canarycode's own edit tools.

### Fixed

- **Native CLI binary resolution under compiled installs.** The Claude Agent
  SDK's native `claude` binary is now resolved from canarycode's own module
  graph and passed explicitly, fixing "Native CLI binary for
  &lt;platform&gt;-&lt;arch&gt; not found" when running as a compiled/standalone
  binary or after an `--omit=optional` install.

## 0.2.0 - 2026-07-07

### Added

- **Claude Code provider.** `canarycode` can now drive Anthropic's Claude Code
  through the Claude Agent SDK, so a Claude subscription (not just a raw API
  key) can power the agent loop. Select it like any other provider; see the
  README's provider section for setup.
- **Provider-factory seam.** Providers are now constructed through a single
  factory, making it straightforward to add new backends (Claude Code is the
  first to use it) without touching the core loop.
- **Provider-qualified model IDs.** Model identifiers can be qualified by
  provider (e.g. `anthropic/…`); the selected model is resolved and persisted
  so it survives across sessions.
- **Ctrl+G opens your `$EDITOR`.** A new external-editor action drops the
  current prompt into your configured editor and reads it back on save, with a
  matching footer chip advertising the shortcut.

### Fixed

- **Clipboard copy now works over SSH.** Copy actions fall back to an OSC 52
  escape sequence, so copying from a remote `canarycode` session lands text on
  your local clipboard.

## 0.1.2 - 2026-07-06

### Fixed

- **`install.sh` aborted with a 403 when resolving the latest release.** The
  installer looked up the newest tag through the `api.github.com` REST endpoint,
  which is rate-limited to 60 requests/hour per IP and returns HTTP 403 once
  exhausted — leaving a fresh `curl … | sh` to fail with "could not resolve the
  latest release tag". It now resolves the tag from the un-rate-limited
  `github.com/…/releases/latest` redirect, with the REST API kept as a fallback.
- **Fresh-install "no API key" error now says where to put the key.** Running
  `canarycode` with no key configured printed a bare "anthropic provider requires
  an apiKey" with no next step. The message now spells out both options — the
  recommended CanaryLLM path (`CANARYLLM_API_KEY=clk…`) and raw Anthropic
  (`ANTHROPIC_API_KEY`) — and points at `~/.canarycode/config.json`. The README
  gains a matching "First run" section.

## 0.1.1 - 2026-06-23

### Fixed

- **Nix flake installed a corrupted binary.** The flake's package (used by
  `nix run` and the Home Manager module) ran the prebuilt release binary through
  `autoPatchelfHook` and stdenv's default `strip`. The release binary is a Bun
  single-file executable — the app is an appended payload Bun locates via a
  baked-in byte offset — so rewriting it shifted that payload and the binary
  degraded to the bare Bun CLI (`canarycode` just printed the Bun version). The
  flake now installs the binary byte-for-byte unmodified and runs it inside an
  FHS env on Linux. The `install.sh` and GitHub-release binaries were **never**
  affected — only the Nix install path was. The release workflow also now pins
  Bun for reproducible builds. No source changes.

## 0.1.0 - 2026-06-12

First public release.

### Highlights

- **Interactive TUI** built on OpenTUI + React: scrollable transcript with
  mouse support, text selection, keyboard navigation mode, copy commands,
  themed cards, markdown rendering with syntax highlighting, and a help
  overlay.
- **Headless print mode** (`canarycode -p "<prompt>"`) for scripting, with `--json`
  JSONL event streaming and stdin folded into the prompt as context.
- **Providers**: Anthropic-compatible and OpenAI-compatible APIs, CanaryLLM,
  OpenAI Codex (ChatGPT subscription) login, and OpenCode Zen models.
- **Modes**: read-only plan mode, autonomous auto mode, and extended thinking
  levels (`/think off|think|think-hard|ultrathink`).
- **Extensions**: web search, skills, custom agents and sub-agents, MCP
  servers, lifecycle hooks, a permission engine with an optional AI safety
  checker, and user extensions loaded from `~/.canarycode/extensions/`.
- **Sessions**: SQLite-backed persistence with `--resume`/`--continue`, an
  interactive session picker, and mid-turn input queueing.
- **Project context**: `CANARYCODE.md`/`AGENTS.md`/`CLAUDE.md` files are prepended to
  the system prompt; `/init` generates a starter file.
- **Self-update**: `canarycode update` / `/update` downloads, checksum-verifies, and
  atomically swaps the release binary; a background check surfaces new
  versions at startup, and `/changelog` shows what changed.
- **Install anywhere**: `install.sh` for prebuilt binaries, or Nix flake with
  a Home Manager module.
