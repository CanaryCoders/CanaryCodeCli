# cc

Project context for `cc`. This file is prepended to the system prompt so the
agent knows how to work in this repo. Keep it short and high-signal.

## Overview

`cc` is a fast, minimal terminal coding agent. One agent loop drives two
front-ends: a headless `-p` print mode for scripting and an interactive OpenTUI TUI.
Core stays small (target ~2000 LOC); QoL features include plan/auto/thinking
modes, web search, sub-agents, custom agents, MCP, skills, hooks, an AI
permission engine, and project-context files. See `README.md` for full feature
docs.

## Stack

- Runtime: **Bun** (no build step — `.ts`/`.tsx` run directly).
- Language: **TypeScript**, ESNext modules, `strict` on, `verbatimModuleSyntax`
  (use `import type` for type-only imports; `.ts`/`.tsx` extensions in imports).
- TUI: **OpenTUI** (`@opentui/core`, `@opentui/react`) + React 19.
- Lint/format: **Biome**. Storage: SQLite via Bun (`~/.cc/sessions.db`).

## Layout (`src/`)

- `index.ts` — CLI entry / arg parsing; `agent.ts` — the core agent loop.
- `provider.ts`, `canary.ts` — model providers; `auth.ts` — ChatGPT/Codex OAuth.
- `tools.ts` — the core tool set (read_file, write_file, edit_file, list_dir,
  bash, grep). Frozen: new tools belong in extensions.
- `extension.ts` — the unified `Extension` interface + `SessionExtension` +
  `composeExtensions` kernel. One interface covers both lifecycles: outer
  (providerPresets, startup, commands) and per-session (via `session()`).
- `assemble.ts` — the one place sessions are assembled; both frontends call it.
- `extensions/` — one file per feature: `websearch`, `askuser`, `skills`,
  `agents` (incl. sub-agents), `mcp`, `hooks`, `permission`, `tasks`,
  `codex` (ChatGPT-subscription models), `opencode` (OpenCode Zen models via
  opencode's credentials); `registry.ts` is the single config-aware authority
  (built-in + user extension lists, toggle enforcement, startup, presets,
  command dispatch); `loader.ts` discovers and trust-checks user extensions
  from `~/.cc/extensions/` and `./.cc/extensions/`.
- `config.ts`, `session.ts`, `context.ts`, `commands.ts`, `thinking.ts`,
  `diff.ts`, `markdown.ts`, `fuzzy.ts` — supporting modules.
- `tui/` — OpenTUI components (`App.tsx`, `Message.tsx`, `Input.tsx`, …) routed
  through `primitives.tsx` (the `Box`/`Text` adapter layer) + `theme.ts`;
  `verbs.ts` (root) supplies the spinner's status verbs.

## Commands

- run (dev): `bun run dev` or `bun run src/index.ts`
- typecheck: `bun run typecheck`  (`tsc --noEmit`)
- lint: `bun run lint`  (`biome lint ./src`)
- format: `bun run format`  (`biome format --write ./src`)
- check (lint + types): `bun run check`
- test: `bun test`

Validate changes with `bun test && bun run check`.

## Conventions

- Biome formatting: 2-space indent, 80-col line width. Run `bun run format`.
- Keep the core lean; justify any new dependency in the PR or commit message.
- Every tool carries a `readOnly` flag — plan mode filters on it; preserve it
  when adding tools.
- Config lives at `~/.cc/config.json`; `${VAR}` references interpolate from env.
- Layering: core (`agent.ts`, `provider.ts`, `tools.ts`, `session.ts`) never
  imports from `extensions/` or `tui/`. Extensions import core +
  `extension.ts`, never each other and never frontends. Frontends import
  `assemble.ts`, never feature modules directly (narrow carve-outs: session
  lifecycle hook runners and small presentation helpers).
- Every system-prompt injection is a named extension's `systemPrompt()`;
  nothing else may append to the prompt.
- A feature that isn't configured must cost zero tokens and zero startup work.
