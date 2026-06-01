// tui/Message.tsx — render one transcript item, with collapsed/expandable tool calls.
//
// The TUI transcript (App.tsx) is a flat list of typed `Item`s: the user's line,
// streamed assistant text, thinking, a tool call (with its eventual result), and
// notes. This module owns the item shapes and the renderer for a single item so
// App.tsx stays focused on the engine loop.
//
// Tool calls render collapsed to one line — `⚙ bash: npm test ✓` — using a
// per-tool summary of the most salient argument rather than raw JSON. Passing
// `expanded` (or an errored result) reveals the full input and the head of the
// tool's output. Errors always show their first line even when collapsed.

import { Box, Text } from "ink";
import { type Diff, type DiffLine, diffStat } from "../diff.ts";
import { codeLineFlags, parseMarkdown, type Span } from "../markdown.ts";
import {
  pickVerb,
  RESPONDING_VERBS,
  THINKING_VERBS,
  TOOL_VERB,
} from "../verbs.ts";
import {
  DIFF,
  GUTTER_RULE,
  ROLE,
  type Role,
  SPACING,
  TOOL_STATUS,
  tint,
  toolStatus,
} from "./theme.ts";

// ── Display items ───────────────────────────────────────────────────────────────

export type Item =
  | {
      id: number;
      kind: "banner";
      /** App name (e.g. "cc"). */
      appName: string;
      /** Version string (e.g. "0.0.1"). */
      version: string;
      /** Working directory (rendered `~`-abbreviated). */
      cwd: string;
      /** Active model label. */
      model: string;
      /** Active provider id (anthropic / openai-compat / …). */
      provider: string;
    }
  | { id: number; kind: "user"; text: string }
  | {
      id: number;
      kind: "assistant";
      text: string;
      /** This chunk continues an earlier-committed part of the same streamed block,
       * so its speaker gutter is rendered glyph-less to avoid a repeated marker. */
      continuation?: boolean;
    }
  | { id: number; kind: "thinking"; text: string; continuation?: boolean }
  | {
      id: number;
      kind: "tool";
      toolId: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      pending: boolean;
      /** write_file/edit_file carry a structured diff to preview under the line. */
      diff?: Diff;
    }
  | { id: number; kind: "note"; text: string; tone?: "info" | "error" };

/** Distributive `Omit` so each union member keeps its own shape (a plain
 * `Omit<Item, "id">` collapses to the members' common keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type ItemInput = DistributiveOmit<Item, "id">;

// ── Tool input summarising ───────────────────────────────────────────────────────

/** For each tool, the input field that best summarises the call on one line. */
const TOOL_SUMMARY_FIELD: Record<string, string> = {
  bash: "command",
  read_file: "path",
  write_file: "path",
  edit_file: "path",
  list_dir: "path",
  grep: "pattern",
  web_search: "query",
  read_skill: "name",
  spawn_agent: "task",
};

/** Pull the single most salient argument from a tool's input, e.g. the command
 * for `bash` or the path for `read_file`. Falls back to compact JSON for tools
 * with no known summary field (MCP tools, etc.). Returns "" when there's nothing
 * worth showing. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    const field = TOOL_SUMMARY_FIELD[name];
    if (field && typeof rec[field] === "string" && rec[field]) {
      return collapseWhitespace(rec[field] as string);
    }
  }
  return fmtInput(input);
}

/** Compact one-line rendering of a tool's full input arguments (JSON). */
function fmtInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s === "{}" || s === undefined || s === "null") return "";
  return s;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── Live status verb ───────────────────────────────────────────────────────────
//
// While a turn is in flight the spinner pairs with a short verb describing what's
// happening *right now*, derived from the live items (the most recent one is the
// best indicator). A pending tool maps to a literal tool verb ("running bash…",
// "grepping…"); streaming assistant text and idle reasoning draw from rotating
// mood pools (see verbs.ts), seeded by the live item's id so the verb is stable
// for the step and changes on the next rather than flickering each spinner frame.

/** A short status verb for the busy spinner, derived from the live transcript. */
export function statusVerb(live: Item[]): string {
  const last = live[live.length - 1];
  if (!last) return `${pickVerb(THINKING_VERBS, 0)}…`;
  // A stable per-step seed: holds steady while this item is live, rolls on the next.
  const seed = last.id;
  if (last.kind === "tool" && last.pending) {
    return `${TOOL_VERB[last.name] ?? `running ${last.name}`}…`;
  }
  if (last.kind === "assistant") return `${pickVerb(RESPONDING_VERBS, seed)}…`;
  // A finished tool, a note, or thinking → the model is (about to be) speaking.
  return `${pickVerb(THINKING_VERBS, seed)}…`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Keep only the trailing `maxRows` *visual* lines of `text`, accounting for
 * wrapping at `width` columns. Used to cap the live (in-flight) streaming block
 * so the dynamic region never grows past the terminal viewport — overflowing it
 * is what desyncs Ink's redraw and duplicates lines into the scrollback. The
 * complete text is still committed to `<Static>` when the block finalises, so
 * trimming here only affects what's shown *while* it streams.
 */
export function tailLines(
  text: string,
  maxRows: number,
  width: number,
): { text: string; trimmed: boolean } {
  if (maxRows <= 0) return { text: "", trimmed: text.length > 0 };
  const w = Math.max(1, width);
  const segs = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]!;
    const rows = Math.max(1, Math.ceil(seg.length / w));
    if (used + rows > maxRows) {
      // This segment doesn't fit whole. If we've already kept something, drop it
      // entirely. Otherwise (a single trailing segment taller than the whole cap —
      // e.g. one long unbroken paragraph streamed with no newline yet) keep only
      // its last `remaining` visual rows: a single oversized segment that wrapped
      // past the viewport is exactly what overflows the dynamic region and ghosts.
      if (kept.length > 0) return { text: kept.join("\n"), trimmed: true };
      const remaining = maxRows - used;
      if (remaining <= 0) return { text: "", trimmed: true };
      return { text: seg.slice(-(remaining * w)), trimmed: true };
    }
    kept.unshift(seg);
    used += rows;
  }
  return { text, trimmed: false };
}

/**
 * Truncate every logical line of `text` to `width` columns so a live (redrawn)
 * block never *soft-wraps*. A wrapped line in the dynamic region is exactly what
 * Ink mis-erases — it under-counts the extra terminal rows the wrap occupies and
 * re-emits the line onto the stuck cursor row, smearing it horizontally. Keeping
 * each live line to a single terminal row makes Ink's per-line erase exact. The
 * complete, correctly-wrapped text is still committed to `<Static>` (printed once,
 * never redrawn) when the block finalises, so this only affects the live preview.
 *
 * Truncation is on the *raw* (pre-markdown) length, which only ever over-estimates
 * visible width (`**bold**` → 4 visible cols from 8 raw), so a clamped line can
 * never exceed `width` on screen — erring short, which is the safe direction.
 */
export function clampLineWidth(text: string, width: number): string {
  const w = Math.max(1, width);
  return text
    .split("\n")
    .map((line) => (line.length > w ? `${line.slice(0, w - 1)}…` : line))
    .join("\n");
}

/**
 * Length of the leading run of a streamed text block that is *stable* — i.e. safe
 * to commit to the permanent `<Static>` scrollback because it will never re-render
 * differently as more text arrives. This is the key to ghost-free streaming: only
 * the unstable tail stays in the dynamic region, so that region can't outgrow the
 * viewport (which is what desyncs Ink's redraw and duplicates lines).
 *
 * Stable = whole lines only (never a partial current line), and — for markdown —
 * never a line *inside* an open ``` code fence (the fence needs its closing marker
 * to render as one block). For plain `thinking` text it's simply everything up to
 * the last newline. Returns 0 when nothing is committable yet.
 */
export function stablePrefixLen(
  text: string,
  kind: "assistant" | "thinking",
): number {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return 0; // no complete line yet
  if (kind === "thinking") return lastNl + 1;
  // Markdown: walk complete lines, tracking ``` fence parity. The commit point is
  // the offset after the last complete line that sits *outside* an open fence.
  const lines = text.split("\n");
  let fenceOpen = false;
  let offset = 0;
  let safe = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*```/.test(lines[i]!)) fenceOpen = !fenceOpen;
    offset += lines[i]!.length + 1; // + the newline
    if (!fenceOpen) safe = offset;
  }
  return safe;
}

/** First `n` non-trivial lines of a tool result, with an "(+N more)" marker. */
function head(text: string, n: number): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  return {
    lines: all.slice(0, n).map((l) => truncate(l, 200)),
    more: Math.max(0, all.length - n),
  };
}

// ── Block gutter rule ──────────────────────────────────────────────────────────────
//
// A faint left rule (`│ `) drawn down the side of a block — diffs and markdown code
// fences — so each reads as a distinct unit rather than text inline with prose.
// Content lives in a flex column beside the rule so wrapped lines stay tucked under
// it; the rule colour passes through `tint` for `NO_COLOR` safety.

function RuleRow({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text color={tint(DIFF.gutter)} dimColor>{`${GUTTER_RULE} `}</Text>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────

/** Map a markdown `Span`'s styling onto Ink `<Text>` props. */
function spanProps(span: Span): {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dimColor?: boolean;
  color?: string;
} {
  return {
    bold: span.bold,
    italic: span.italic,
    underline: span.underline,
    strikethrough: span.strikethrough,
    dimColor: span.dim,
    color: span.color,
  };
}

/**
 * Render assistant text as markdown: each parsed line is a `<Text>` row whose
 * styled spans become nested `<Text>` runs. Streaming-safe — `parseMarkdown`
 * re-parses the accumulated text on every render and never throws on a partial
 * marker, so the live region can grow delta-by-delta.
 */
function Markdown({ text }: { text: string }): React.ReactElement {
  // Drop a single trailing newline: streaming commits each block at a line
  // boundary (its text ends with "\n"), and `"…\n".split("\n")` yields a trailing
  // empty element that would render as a spurious blank row between chunks. The
  // newline is a separator, not content, so trimming one keeps prose tight while
  // leaving genuine `\n\n` paragraph gaps intact.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = parseMarkdown(body);
  // Code-fence/indented lines get a faint left gutter rule so the block reads as a
  // distinct unit (`codeLineFlags` aligns 1:1 with `lines`).
  const code = codeLineFlags(body);
  return (
    <Box flexDirection="column">
      {lines.map((line, li) => {
        const spans = line.spans.map((span, si) => (
          <Text key={si} {...spanProps(span)}>
            {span.text}
          </Text>
        ));
        return code[li] ? (
          <RuleRow key={li}>
            <Text>{spans}</Text>
          </RuleRow>
        ) : (
          <Text key={li}>{spans}</Text>
        );
      })}
    </Box>
  );
}

// ── Launch banner ──────────────────────────────────────────────────────────────

/** Abbreviate a home-relative path with `~` (e.g. `/Users/me/src` → `~/src`). */
function abbreviateCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/**
 * The one-time launch banner: app name + version, the `~`-abbreviated cwd, and the
 * active model/provider — a slim, dim rounded box. Rendered as the first `<Static>`
 * scrollback item so it scrolls away naturally as the session grows.
 */
function BannerView({
  appName,
  version,
  cwd,
  model,
  provider,
}: Extract<Item, { kind: "banner" }>): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={tint("gray")} paddingX={1}>
      <Text bold dimColor>{`${appName} v${version}`}</Text>
      <Text
        dimColor
      >{`  ${abbreviateCwd(cwd)}  ·  ${model} · ${provider}`}</Text>
    </Box>
  );
}

// ── Speaker gutter ─────────────────────────────────────────────────────────────────
//
// Every transcript item renders behind a two-cell left gutter (the role glyph + a
// space, or two spaces when glyph-less) so the eye instantly separates who/what
// produced each line. Content lives in a flex column beside the gutter, so when a
// long line wraps the continuation stays tucked under the gutter instead of
// reflowing to the screen edge. Colours pass through `tint` so `NO_COLOR` keeps the
// glyphs + spacing but drops the colour.

function Gutter({
  speaker,
  colorOverride,
  marginTop = 0,
  glyphless = false,
  highlight = false,
  children,
}: {
  speaker: Role;
  /** Override the gutter glyph colour (tool calls colour it by status). */
  colorOverride?: string;
  marginTop?: number;
  /** Suppress the glyph (a two-space gutter) — used for continuation chunks of a
   * streamed block whose first chunk already carried the marker. */
  glyphless?: boolean;
  /** Paint the role's highlight background behind the whole row (user lines), so
   * they stand out from tool calls and AI output. */
  highlight?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const s = ROLE[speaker];
  const glyph = !glyphless && s.glyph ? `${s.glyph} ` : "  ";
  const bg = highlight ? tint(s.bg) : undefined;
  return (
    <Box flexDirection="row" marginTop={marginTop}>
      <Text
        color={tint(colorOverride ?? s.color)}
        backgroundColor={bg}
        bold={s.bold}
        dimColor={s.dim}
      >
        {glyph}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {bg ? <Text backgroundColor={bg}>{children}</Text> : children}
      </Box>
    </Box>
  );
}

// ── Rendering ────────────────────────────────────────────────────────────────────

/**
 * Items that belong to the *same* logical group as the assistant answer that
 * introduced them — the model's prose plus the actions it took. Within a group
 * items tuck together (no blank line); a new group (or a different speaker) gets
 * the usual `blockGap` separation so each answer reads as its own unit.
 */
const GROUP_KINDS = new Set<Item["kind"]>(["assistant", "thinking", "tool"]);

/** Top gap for an item, given what precedes it. Items that continue the same AI
 * answer/action group glue together (groupGap); a fresh group is offset by a
 * blank line so the `⏺` dot starts a visibly separate block. */
function topGap(item: Item, prevKind?: Item["kind"]): number {
  // A continuation chunk of a streamed block is always glued to its head.
  if (
    (item.kind === "assistant" || item.kind === "thinking") &&
    item.continuation
  )
    return 0;
  // A tool/thinking sub-item tucks under the assistant text (or sibling tool)
  // that began the group — no blank line within the group.
  if (
    (item.kind === "tool" || item.kind === "thinking") &&
    prevKind &&
    GROUP_KINDS.has(prevKind)
  )
    return SPACING.groupGap;
  return SPACING.blockGap;
}

export function ItemView({
  item,
  prevKind,
  expanded = false,
  showExpandHint = false,
  compact = false,
  width,
}: {
  item: Item;
  /** Kind of the immediately preceding transcript item, for group spacing. */
  prevKind?: Item["kind"];
  expanded?: boolean;
  /** Render a one-time `ctrl+r to expand` hint (the session's first tool call). */
  showExpandHint?: boolean;
  /** Live (in-flight, redrawn) rendering: bound a tool to a single headline row so
   * it can't overflow the dynamic region and desync Ink. The full command/output
   * still renders once the item lands in `<Static>`. */
  compact?: boolean;
  /** Live content width (columns minus the deepest gutter). In `compact` mode the
   * tool headline and note text are truncated to this so they occupy exactly one
   * terminal row — a wrapped live line is what Ink mis-erases into stray fragments. */
  width?: number;
}): React.ReactElement {
  switch (item.kind) {
    case "banner":
      return <BannerView {...item} />;
    case "user":
      // A user line starts a new turn → one blank line above it. It also carries a
      // subtle highlight background so it's instantly distinguishable from tool
      // calls and AI output (Claude-Code style).
      return (
        <Gutter speaker="user" marginTop={SPACING.turnGap} highlight>
          <Text>{item.text}</Text>
        </Gutter>
      );
    case "assistant":
      // A `⏺` dot + blank line marks the start of each distinct AI answer; a
      // continuation chunk of the same streamed message stays glued (no gap, no
      // repeated dot).
      return (
        <Gutter
          speaker="assistant"
          glyphless={item.continuation}
          marginTop={topGap(item, prevKind)}
        >
          <Markdown text={item.text} />
        </Gutter>
      );
    case "thinking":
      return (
        <Gutter
          speaker="thinking"
          glyphless={item.continuation}
          marginTop={topGap(item, prevKind)}
        >
          <Text dimColor italic>
            {item.text}
          </Text>
        </Gutter>
      );
    case "tool": {
      const statusColor =
        TOOL_STATUS[toolStatus(item.pending, item.isError)].color;
      return (
        <Gutter
          speaker="tool"
          colorOverride={statusColor}
          marginTop={topGap(item, prevKind)}
        >
          <ToolView
            item={item}
            expanded={expanded}
            showHint={showExpandHint}
            compact={compact}
            width={width}
          />
        </Gutter>
      );
    }
    case "note": {
      // While live (compact), truncate to one row so the note can't wrap and
      // desync the redrawn region; the full note lands in `<Static>` on finalise.
      const text =
        compact && width ? truncate(item.text, width) : item.text;
      return (
        <Gutter
          speaker={item.tone === "error" ? "error" : "note"}
          marginTop={prevKind === "note" ? SPACING.groupGap : SPACING.blockGap}
        >
          <Text color={tint(item.tone === "error" ? "red" : "gray")}>
            {text}
          </Text>
        </Gutter>
      );
    }
  }
}

function ToolView({
  item,
  expanded,
  showHint = false,
  compact = false,
  width,
}: {
  item: Extract<Item, { kind: "tool" }>;
  expanded: boolean;
  /** Show the one-time `ctrl+r to expand` affordance hint (collapsed only). */
  showHint?: boolean;
  /** Live rendering: bound to a single headline row (no full bash command, no
   * body, no diff) so the redrawn dynamic region can't overflow and desync Ink.
   * The full version renders once the item lands in `<Static>`. */
  compact?: boolean;
  /** Live content width — the compact headline is truncated to it (mark included)
   * so the whole row fits the terminal and never wraps. */
  width?: number;
}): React.ReactElement {
  const mark = item.pending ? "…" : item.isError ? "✗" : "✓";
  const color = item.pending ? "yellow" : item.isError ? "red" : "green";
  const summary = summarizeToolInput(item.name, item.input);
  // `bash` shows the FULL command, wrapped, never truncated — "what shell command
  // ran" is the thing the user most wants to verify. Every other tool keeps the
  // 72-char one-line summary. Ink `<Text>` wraps by default, so leaving bash's
  // command un-truncated lets it flow onto the next line instead of `…`-eliding.
  // EXCEPT while the call is *live* (compact): a long, wrapping headline in the
  // redrawn dynamic region overflows it and smears into duplicate lines, so we
  // truncate to one row there — the full command appears once it's in `<Static>`.
  const shown = summary
    ? item.name === "bash" && !compact
      ? summary
      : truncate(summary, 72)
    : "";
  const headline = shown ? `${item.name}: ${shown}` : item.name;

  // Live (compact): render exactly one row — the headline plus its status mark,
  // truncated to the live content width (the 72-char summary cap above ignores the
  // `name: ` prefix, the mark, and the terminal width, so on a normal-width
  // terminal the row still wraps without this final clamp). A wrapped live row is
  // what Ink mis-erases into the stray single-character fragments; the full, rich
  // tool view (command, body, diff, hint) renders once the item lands in `<Static>`.
  if (compact) {
    const line = `${headline} ${mark}`;
    return (
      <Box flexDirection="column">
        <Text color={tint(color)}>{width ? truncate(line, width) : line}</Text>
      </Box>
    );
  }

  // Errors always reveal their first line; expansion reveals input + output head.
  // Suppressed while live (compact) — the body lands in `<Static>` on finalise.
  const showBody =
    !compact && !item.pending && item.result && (expanded || item.isError);
  const body = showBody ? head(item.result!, expanded ? 20 : 1) : null;

  // write_file/edit_file carry a diff: always preview it (collapsed = first hunk).
  // Held back while live (compact) so a tall diff can't overflow the live region.
  const showDiff =
    !compact &&
    !item.pending &&
    !item.isError &&
    item.diff &&
    item.diff.hunks.length > 0;

  return (
    <Box flexDirection="column">
      <Text color={tint(color)}>
        {headline}
        <Text dimColor>{` ${mark}`}</Text>
        {showHint && !expanded ? (
          <Text dimColor>{"  (ctrl+r to expand)"}</Text>
        ) : null}
      </Text>
      {expanded && summary ? (
        <Text dimColor>{`  ${truncate(fmtInput(item.input), 200)}`}</Text>
      ) : null}
      {body
        ? body.lines.map((line, i) => (
            <Text
              key={i}
              color={tint(item.isError ? "red" : undefined)}
              dimColor={!item.isError}
            >
              {`  ${line}`}
            </Text>
          ))
        : null}
      {body && body.more > 0 ? (
        <Text dimColor>{`  …(+${body.more} more lines)`}</Text>
      ) : null}
      {showDiff ? <DiffView diff={item.diff!} expanded={expanded} /> : null}
    </Box>
  );
}

// ── Diff preview ───────────────────────────────────────────────────────────────────

const DIFF_PREFIX: Record<DiffLine["type"], string> = {
  context: " ",
  add: "+",
  del: "-",
};
const DIFF_COLOR: Record<DiffLine["type"], string | undefined> = {
  context: undefined,
  add: "green",
  del: "red",
};

interface DiffRow {
  text: string;
  color?: string;
}

/** Flatten a diff's hunks into renderable rows (headers + `+`/`-`/context lines). */
function diffRows(hunks: Diff["hunks"]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const h of hunks) {
    rows.push({
      text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      color: "cyan",
    });
    for (const line of h.lines) {
      rows.push({
        text: DIFF_PREFIX[line.type] + line.text,
        color: DIFF_COLOR[line.type],
      });
    }
  }
  return rows;
}

/**
 * Render a write/edit diff under the tool line: a `+N -M` stat plus the diff
 * body, green/red/cyan-coloured. Collapsed shows only the first hunk capped to a
 * few lines; verbose (`expanded`) shows every hunk up to a larger cap. Anything
 * beyond the cap collapses to a `…(+N more lines)` marker.
 */
export function DiffView({
  diff,
  expanded,
}: {
  diff: Diff;
  expanded: boolean;
}): React.ReactElement {
  const cap = expanded ? 40 : 12;
  const totalRows = diff.hunks.reduce((s, h) => s + h.lines.length + 1, 0);
  const hunks = expanded ? diff.hunks : diff.hunks.slice(0, 1);
  const rows = diffRows(hunks).slice(0, cap);
  const hidden = totalRows - rows.length;

  // The whole diff renders behind a faint left gutter rule (stat header + body +
  // overflow marker) so it reads as one distinct block, not coloured text inline
  // with the tool's output.
  return (
    <Box flexDirection="column">
      <RuleRow>
        <Text dimColor>{diffStat(diff)}</Text>
      </RuleRow>
      {rows.map((r, i) => (
        <RuleRow key={i}>
          <Text color={tint(r.color)}>{truncate(r.text, 200)}</Text>
        </RuleRow>
      ))}
      {hidden > 0 ? (
        <RuleRow>
          <Text dimColor>{`…(+${hidden} more lines)`}</Text>
        </RuleRow>
      ) : null}
    </Box>
  );
}
