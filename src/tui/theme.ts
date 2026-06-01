// tui/theme.ts — the central palette + spacing tokens for the Ink TUI.
//
// Phase 4.8 ("the pretty pass") pulls every glyph, colour, and spacing decision
// into one place so the look lives here, not scattered across components. The
// values capture the conventions the TUI already grew organically — the cyan `›`
// user gutter, mode-coloured borders (normal=green / plan=cyan / auto=yellow), the
// green/red/yellow tool-status marks, and the green/red/cyan diff palette — and
// give the remaining 4.8 tasks (speaker gutters, framed input, footer pill,
// code/diff gutters) a shared vocabulary to draw from instead of re-deriving it.
//
// Colours are Ink colour names (strings). `NO_COLOR` degradation is a render-time
// concern handled by a later task; the constants here stay pure data so they can
// be read in tests and mapped to Ink `<Text>`/`<Box>` props at the call site.

import type { AgentMode } from "../agent.ts";

// ── Roles (transcript speakers) ────────────────────────────────────────────────
// Every transcript item gets a left-gutter glyph + colour so the eye instantly
// separates who/what produced each line. `assistant` is intentionally glyph-less:
// the model's prose stands on its own (markdown already styles it).

export type Role =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "note"
  | "error";

export interface RoleStyle {
  /** Left-gutter glyph; "" means no glyph. */
  glyph: string;
  /** Ink colour for the gutter glyph (undefined = terminal default). */
  color?: string;
  /** Whether the gutter glyph is rendered bold. */
  bold?: boolean;
  /** Whether the whole line is dimmed (thinking, notes). */
  dim?: boolean;
  /** Optional background colour painted behind the whole line (user highlight). */
  bg?: string;
}

export const ROLE: Record<Role, RoleStyle> = {
  // A filled dot marks the start of each distinct AI answer (Claude-Code style),
  // so consecutive answers/tool groups read as separate units at a glance.
  user: { glyph: "›", color: "cyan", bold: true, bg: "gray" },
  assistant: { glyph: "*", color: undefined, bold: true },
  // Keep thinking ASCII-only while retaining the two-cell gutter.
  thinking: { glyph: "~", color: undefined, dim: true },
  tool: { glyph: ">", color: undefined }, // coloured by status — see TOOL_STATUS
  note: { glyph: "i", color: "gray", dim: true },
  error: { glyph: "x", color: "red" },
};

// ── Modes (border + accent colour) ─────────────────────────────────────────────
// The active mode tints the input frame border, the plan box, and the footer pill.

const MODE_COLOR: Record<AgentMode, string> = {
  normal: "green",
  plan: "cyan",
  auto: "yellow",
};

/** Border/accent colour for a mode (input frame, plan box, footer pill). */
export function modeColor(mode: AgentMode): string {
  return MODE_COLOR[mode];
}

// ── Tool-call status ───────────────────────────────────────────────────────────
// The tool glyph and the trailing mark are coloured by where the call is in its
// lifecycle: pending (yellow `...`), ok (green `OK`), error (red `ERR`).

export type ToolStatus = "pending" | "ok" | "error";

export const TOOL_STATUS: Record<ToolStatus, { color: string; mark: string }> =
  {
    pending: { color: "yellow", mark: "..." },
    ok: { color: "green", mark: "OK" },
    error: { color: "red", mark: "ERR" },
  };

/** Resolve a tool call's status from its pending/error flags. */
export function toolStatus(pending: boolean, isError?: boolean): ToolStatus {
  return pending ? "pending" : isError ? "error" : "ok";
}

// ── Diff palette ───────────────────────────────────────────────────────────────
// Additions green, deletions red, hunk headers cyan; `gutter` tints the faint
// left rule that frames a diff (or markdown code fence) as a distinct block.

export const DIFF = {
  add: "green",
  del: "red",
  header: "cyan",
  gutter: "gray",
} as const;

/** The faint vertical rule drawn down the left of a diff/code block. */
export const GUTTER_RULE = "│";

// ── Spacing tokens ─────────────────────────────────────────────────────────────
// Centralised so spacing between turns / around the input frame stays uniform and
// the live region lines up byte-for-byte with the finalised `<Static>` scrollback.

export const SPACING = {
  /** Blank lines between finished turns in the scrollback. */
  turnGap: 1,
  /** Blank line between distinct *logical groups* (a new AI answer, a user
   * line, a standalone note) so each group reads as a separate unit rather
   * than one run-on wall of text. Continuation chunks of a single streamed
   * block stay glued (no gap) — see Message.tsx. */
  blockGap: 1,
  /** No gap between items that belong to the *same* logical group — e.g. the
   * tool calls a model fires right after (or between) its prose. They tuck
   * directly under the assistant text that introduced them so the eye reads
   * "this answer + the actions it took" as one block. */
  groupGap: 0,
  /** Top margin above the input frame. */
  inputGap: 1,
  /** Horizontal padding inside bordered boxes (input frame, plan, confirm). */
  boxPadX: 1,
} as const;

// ── Colour degradation ─────────────────────────────────────────────────────────
// `NO_COLOR` (https://no-color.org) means "drop colour, keep glyphs + spacing".
// The detection lives here so every component asks the palette one question; the
// actual stripping is applied by a later 4.8 task at each render site.

const NO_COLOR = Boolean(process.env.NO_COLOR);

/** Return `color` unless `NO_COLOR` is set, in which case undefined (default). */
export function tint(color: string | undefined): string | undefined {
  return NO_COLOR ? undefined : color;
}
