// tui/theme.ts — the central palette + spacing tokens for the Ink TUI.
//
// Phase 4.8 ("the pretty pass") pulls every glyph, colour, and spacing decision
// into one place so the look lives here, not scattered across components. The
// values capture the conventions the TUI already grew organically — the orange `›`
// user gutter, mode-coloured borders (normal=brand orange / plan=cyan / auto=yellow), the
// green/red/yellow tool-status marks, and the green/red/cyan diff palette — and
// give the remaining 4.8 tasks (speaker gutters, framed input, footer pill,
// code/diff gutters) a shared vocabulary to draw from instead of re-deriving it.
//
// Colours are Ink colour names (strings). `NO_COLOR` degradation is a render-time
// concern handled by a later task; the constants here stay pure data so they can
// be read in tests and mapped to Ink `<Text>`/`<Box>` props at the call site.

import type { AgentMode } from "../agent.ts";
import type { IconName } from "../icons.ts";

// ── Brand ──────────────────────────────────────────────────────────────────────
// The CanaryCoders signature orange (canarycoders.es theme accent). Used for the
// banner wordmark, the user gutter, and the normal-mode accent so the default
// look carries the brand; plan/auto keep their semantic cyan/yellow.

export const BRAND = {
  /** CanaryCoders signature orange. */
  orange: "#ff7f32",
} as const;

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
  /** Semantic left-gutter icon. */
  icon: IconName;
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
  user: { icon: "prompt", color: BRAND.orange, bold: true, bg: "gray" },
  assistant: { icon: "assistant", color: undefined, bold: true },
  thinking: { icon: "thinking", color: undefined, dim: true },
  tool: { icon: "tool", color: undefined }, // coloured by status — see TOOL_STATUS
  note: { icon: "note", color: "gray", dim: true },
  error: { icon: "error", color: "red" },
};

// ── Cards (boxed transcript units) ──────────────────────────────────────────────
// Each conversational unit — the user's message, the assistant's answer, every
// tool call — renders as a soft filled block so the eye reads the transcript as a
// stack of distinct units (OpenCode / badlogic-pi style). Each block carries a
// muted background fill plus a gentle accent on its border + title; the colours
// are deliberately desaturated truecolor (not the bright ANSI 16) so the bars
// stay soft rather than neon. `tint` strips both fill and accent under NO_COLOR,
// and the fills are scoped to the blocks — the CLI's own root background is never
// painted, so a transparent terminal stays transparent around the cards.
//
// These are fixed muted tones (they don't track the terminal theme); tweak the
// hex values here to taste.

export type CardKind = "user" | "assistant" | "tool" | "error";

export interface CardStyle {
  /** Soft accent for the border + title (muted truecolor hex). */
  color: string;
  /** Muted background fill painted behind the whole block. */
  bg: string;
  /** Title rendered into the top border. */
  title: string;
}

export const CARD: Record<CardKind, CardStyle> = {
  // The user's own messages carry a softened CanaryCoders orange accent.
  user: { color: "#e8915a", bg: "#34281e", title: "you" },
  assistant: { color: "#9ece9a", bg: "#222a28", title: "assistant" },
  tool: { color: "#89a8d8", bg: "#1f2733", title: "tool" },
  error: { color: "#e09aa0", bg: "#34232a", title: "error" },
};

// Soft neutral fills for the non-conversational chrome — the launch banner and
// the input bar — so they read as the same family of filled blocks as the cards
// without competing for a speaker colour. Muted truecolor; stripped under
// NO_COLOR. The CLI's own root background is still never painted.
export const SURFACE = {
  /** Fill behind the launch banner chip. */
  banner: "#222530",
  /** Fill behind the prompt input bar. */
  input: "#262a36",
} as const;

export const INTERACTIVE = {
  /** Foreground used when an inline action is hovered. */
  hoverFg: "white",
  /** Foreground used while an inline action is pressed. */
  activeFg: "yellow",
  /** Subtle row fill for hovered selectable rows. */
  hoverBg: "#2a2e42",
  /** Darker row fill while pressed. */
  activeBg: "#161a22",
  /** Selection colours for transcript text. */
  selectionBg: "#3b4261",
  selectionFg: "white",
} as const;

// ── Modes (border + accent colour) ─────────────────────────────────────────────
// The active mode tints the input frame border, the plan box, and the footer pill.

const MODE_COLOR: Record<AgentMode, string> = {
  // Normal mode wears the brand accent; plan/auto keep semantic colours.
  normal: BRAND.orange,
  plan: "cyan",
  auto: "yellow",
};

/** Border/accent colour for a mode (input frame, plan box, footer pill). */
export function modeColor(mode: AgentMode): string {
  return MODE_COLOR[mode];
}

// ── Tool-call status ───────────────────────────────────────────────────────────
// The `⚙` glyph and the trailing mark are coloured by where the call is in its
// lifecycle: pending (yellow `…`), ok (green `✓`), error (red `✗`).

export type ToolStatus = "pending" | "ok" | "error";

export const TOOL_STATUS: Record<
  ToolStatus,
  { color: string; icon: IconName }
> = {
  pending: { color: "yellow", icon: "toolPending" },
  ok: { color: "green", icon: "toolOk" },
  error: { color: "red", icon: "toolError" },
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
  /** Muted backgrounds painted across the full row of +/− lines, so a diff line
   * reads as a band (Claude-Code style) rather than coloured text floating in
   * the terminal background. Hex degrades via chalk on non-truecolor terminals
   * and is stripped entirely under NO_COLOR (`tint`). */
  addBg: "#1c3a1c",
  delBg: "#3a1c1c",
} as const;

/** The faint vertical rule drawn down the left of a diff/code block. */
export const GUTTER_RULE_ICON: IconName = "rule";

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
  /** Horizontal padding inside filled blocks / bordered boxes. */
  boxPadX: 1,
  /** Vertical padding inside filled blocks (cards, input bar, banner) so content
   * gets a row of breathing room above and below the fill. */
  boxPadY: 1,
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
