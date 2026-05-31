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
import { diffStat, type Diff, type DiffLine } from "../diff.ts";
import { codeLineFlags, parseMarkdown, type Span } from "../markdown.ts";
import {
  DIFF,
  GUTTER_RULE,
  ROLE,
  SPACING,
  TOOL_STATUS,
  tint,
  toolStatus,
  type Role,
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
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string }
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
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
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
export function fmtInput(input: unknown): string {
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
// best indicator). A pending tool maps to a tool-specific verb ("running bash…",
// "searching…"); streaming assistant text is "responding…"; everything else
// (waiting on the model, a just-finished tool, a fresh turn) is "thinking…".

/** Tool → present-tense verb shown beside the spinner while the tool runs. */
const TOOL_VERB: Record<string, string> = {
  bash: "running bash",
  web_search: "searching",
  grep: "searching",
  read_file: "reading",
  list_dir: "listing",
  read_skill: "reading",
  write_file: "writing",
  edit_file: "editing",
  spawn_agent: "delegating",
};

/** A short status verb for the busy spinner, derived from the live transcript. */
export function statusVerb(live: Item[]): string {
  const last = live[live.length - 1];
  if (!last) return "thinking…";
  if (last.kind === "tool" && last.pending) {
    return `${TOOL_VERB[last.name] ?? `running ${last.name}`}…`;
  }
  if (last.kind === "assistant") return "responding…";
  // A finished tool, a note, or thinking → the model is (about to be) speaking.
  return "thinking…";
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
    const rows = Math.max(1, Math.ceil(segs[i]!.length / w));
    if (used + rows > maxRows && kept.length > 0) {
      return { text: kept.join("\n"), trimmed: true };
    }
    kept.unshift(segs[i]!);
    used += rows;
  }
  return { text, trimmed: false };
}

/** First `n` non-trivial lines of a tool result, with an "(+N more)" marker. */
function head(text: string, n: number): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  return { lines: all.slice(0, n).map((l) => truncate(l, 200)), more: Math.max(0, all.length - n) };
}

// ── Block gutter rule ──────────────────────────────────────────────────────────────
//
// A faint left rule (`│ `) drawn down the side of a block — diffs and markdown code
// fences — so each reads as a distinct unit rather than text inline with prose.
// Content lives in a flex column beside the rule so wrapped lines stay tucked under
// it; the rule colour passes through `tint` for `NO_COLOR` safety.

function RuleRow({ children }: { children: React.ReactNode }): React.ReactElement {
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
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = parseMarkdown(text);
  // Code-fence/indented lines get a faint left gutter rule so the block reads as a
  // distinct unit (`codeLineFlags` aligns 1:1 with `lines`).
  const code = codeLineFlags(text);
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
export function abbreviateCwd(cwd: string): string {
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
export function BannerView({
  appName,
  version,
  cwd,
  model,
  provider,
}: Extract<Item, { kind: "banner" }>): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={tint("gray")} paddingX={1}>
      <Text bold dimColor>{`${appName} v${version}`}</Text>
      <Text dimColor>{`  ${abbreviateCwd(cwd)}  ·  ${model} · ${provider}`}</Text>
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
  role,
  colorOverride,
  marginTop = 0,
  children,
}: {
  role: Role;
  /** Override the gutter glyph colour (tool calls colour it by status). */
  colorOverride?: string;
  marginTop?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const s = ROLE[role];
  const glyph = s.glyph ? `${s.glyph} ` : "  ";
  return (
    <Box flexDirection="row" marginTop={marginTop}>
      <Text color={tint(colorOverride ?? s.color)} bold={s.bold} dimColor={s.dim}>
        {glyph}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

// ── Rendering ────────────────────────────────────────────────────────────────────

export function ItemView({
  item,
  expanded = false,
  showExpandHint = false,
}: {
  item: Item;
  expanded?: boolean;
  /** Render a one-time `ctrl+r to expand` hint (the session's first tool call). */
  showExpandHint?: boolean;
}): React.ReactElement {
  switch (item.kind) {
    case "banner":
      return <BannerView {...item} />;
    case "user":
      // A user line starts a new turn → one blank line above it separates turns
      // (continuation/within-turn items below carry no top margin).
      return (
        <Gutter role="user" marginTop={SPACING.turnGap}>
          <Text>{item.text}</Text>
        </Gutter>
      );
    case "assistant":
      return (
        <Gutter role="assistant">
          <Markdown text={item.text} />
        </Gutter>
      );
    case "thinking":
      return (
        <Gutter role="thinking">
          <Text dimColor italic>{item.text}</Text>
        </Gutter>
      );
    case "tool": {
      const statusColor = TOOL_STATUS[toolStatus(item.pending, item.isError)].color;
      return (
        <Gutter role="tool" colorOverride={statusColor}>
          <ToolView item={item} expanded={expanded} showHint={showExpandHint} />
        </Gutter>
      );
    }
    case "note":
      return (
        <Gutter role={item.tone === "error" ? "error" : "note"}>
          <Text color={tint(item.tone === "error" ? "red" : "gray")}>{item.text}</Text>
        </Gutter>
      );
  }
}

function ToolView({
  item,
  expanded,
  showHint = false,
}: {
  item: Extract<Item, { kind: "tool" }>;
  expanded: boolean;
  /** Show the one-time `ctrl+r to expand` affordance hint (collapsed only). */
  showHint?: boolean;
}): React.ReactElement {
  const mark = item.pending ? "…" : item.isError ? "✗" : "✓";
  const color = item.pending ? "yellow" : item.isError ? "red" : "green";
  const summary = summarizeToolInput(item.name, item.input);
  // `bash` shows the FULL command, wrapped, never truncated — "what shell command
  // ran" is the thing the user most wants to verify. Every other tool keeps the
  // 72-char one-line summary. Ink `<Text>` wraps by default, so leaving bash's
  // command un-truncated lets it flow onto the next line instead of `…`-eliding.
  const shown = summary ? (item.name === "bash" ? summary : truncate(summary, 72)) : "";
  const headline = shown ? `${item.name}: ${shown}` : item.name;

  // Errors always reveal their first line; expansion reveals input + output head.
  const showBody = !item.pending && item.result && (expanded || item.isError);
  const body = showBody ? head(item.result!, expanded ? 20 : 1) : null;

  // write_file/edit_file carry a diff: always preview it (collapsed = first hunk).
  const showDiff = !item.pending && !item.isError && item.diff && item.diff.hunks.length > 0;

  return (
    <Box flexDirection="column">
      <Text color={tint(color)}>
        {headline}
        <Text dimColor>{` ${mark}`}</Text>
        {showHint && !expanded ? <Text dimColor>{"  (ctrl+r to expand)"}</Text> : null}
      </Text>
      {expanded && summary ? (
        <Text dimColor>{`  ${truncate(fmtInput(item.input), 200)}`}</Text>
      ) : null}
      {body
        ? body.lines.map((line, i) => (
            <Text key={i} color={item.isError ? "red" : undefined} dimColor={!item.isError}>
              {`  ${line}`}
            </Text>
          ))
        : null}
      {body && body.more > 0 ? <Text dimColor>{`  …(+${body.more} more lines)`}</Text> : null}
      {showDiff ? <DiffView diff={item.diff!} expanded={expanded} /> : null}
    </Box>
  );
}

// ── Diff preview ───────────────────────────────────────────────────────────────────

const DIFF_PREFIX: Record<DiffLine["type"], string> = { context: " ", add: "+", del: "-" };
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
      rows.push({ text: DIFF_PREFIX[line.type] + line.text, color: DIFF_COLOR[line.type] });
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
