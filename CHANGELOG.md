# Changelog

Release notes for `canarycode`. Each tagged release gets a `## <version>` section here;
the release workflow publishes that section as the GitHub release notes, and
the CLI shows it via `canarycode changelog` / `/changelog` and the post-update
what's-new banner.

Format: [Keep a Changelog](https://keepachangelog.com) headings
(`## <version> - <date>`), newest first.

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
