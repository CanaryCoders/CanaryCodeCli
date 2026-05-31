# cc

Project context for `cc`. This file is prepended to the system prompt so the
agent knows how to work in this repo. Keep it short and high-signal.

## Overview

`cc` is a fast, minimal terminal coding agent. One agent loop drives two
front-ends: a headless `-p` print mode for scripting and an interactive Ink TUI.
Core stays small (target ~2000 LOC); QoL features include plan/auto/thinking
modes, web search, sub-agents, custom agents, MCP, skills, hooks, an AI
permission engine, and project-context files. See `README.md` for full feature
docs.

## Stack

- Runtime: **Bun** (no build step — `.ts`/`.tsx` run directly).
- Language: **TypeScript**, ESNext modules, `strict` on, `verbatimModuleSyntax`
  (use `import type` for type-only imports; `.ts`/`.tsx` extensions in imports).
- TUI: **Ink 5** + React 18 (`ink-spinner`, `ink-text-input`).
- Lint/format: **Biome**. Storage: SQLite via Bun (`~/.cc/sessions.db`).

## Layout (`src/`)

- `index.ts` — CLI entry / arg parsing; `agent.ts` — the core agent loop.
- `provider.ts`, `canary.ts` — model providers (OpenAI-compat / Anthropic).
- `tools.ts`, `verbs.ts` — tool definitions; `websearch.ts`, `mcp.ts`,
  `skills.ts`, `subagents.ts`, `agents.ts` — capabilities.
- `permission.ts`, `hooks.ts` — the pre-tool gating pipeline.
- `config.ts`, `session.ts`, `context.ts`, `commands.ts`, `thinking.ts`,
  `diff.ts`, `markdown.ts`, `fuzzy.ts` — supporting modules.
- `tui/` — Ink components (`App.tsx`, `Message.tsx`, `Input.tsx`, …) + `theme.ts`.

## Commands

- run (dev): `bun run dev` or `bun run src/index.ts`
- typecheck: `bun run typecheck`  (`tsc --noEmit`)
- lint: `bun run lint`  (`biome lint ./src`)
- format: `bun run format`  (`biome format --write ./src`)
- check (lint + types): `bun run check`

There is no test suite. Validate changes with `bun run check`.

## Conventions

- Biome formatting: 2-space indent, 80-col line width. Run `bun run format`.
- Keep the core lean; justify any new dependency in `PROGRESS.md`.
- Every tool carries a `readOnly` flag — plan mode filters on it; preserve it
  when adding tools.
- Config lives at `~/.cc/config.json`; `${VAR}` references interpolate from env.
- Track notable progress/decisions in `PROGRESS.md`.
