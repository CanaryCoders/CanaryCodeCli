# Changelog

Release notes for `canarycode`. Each tagged release gets a `## <version>` section here;
the release workflow publishes that section as the GitHub release notes, and
the CLI shows it via `canarycode changelog` / `/changelog` and the post-update
what's-new banner.

Format: [Keep a Changelog](https://keepachangelog.com) headings
(`## <version> - <date>`), newest first.

## 0.1.1 - 2026-06-23

### Fixed

- **Prebuilt binaries now actually run.** The v0.1.0 release assets were built
  with Bun 1.3.14, whose `bun build --compile` regressed: the standalone
  executable ignored its embedded entrypoint and behaved as if `BUN_BE_BUN=1`,
  so running `canarycode` just launched the Bun CLI. The release workflow now
  pins Bun to 1.3.13 (last version verified to compile a working binary), and
  the published binaries and the Nix flake (`nix run`, the Home Manager module)
  install a real `canarycode` again. No source changes — reinstall to upgrade.

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
