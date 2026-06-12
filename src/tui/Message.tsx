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

import { useRef, useState } from "react";
import { type Diff, type DiffLine, diffStat } from "../diff.ts";
import { type MdLine, parseMarkdownBlocks, type Span } from "../markdown.ts";
import { Card } from "./Card.tsx";
import { useIcon } from "./Icon.tsx";
import { ActionChip } from "./Interactive.tsx";
import {
  displayToolName,
  fmtInput,
  head,
  padRow,
  rowKey,
  summarizeToolInput,
  truncate,
  truncateWidth,
} from "./message-helpers.ts";
import { Box, Text } from "./primitives.tsx";
import { useTuiRuntime } from "./runtime.tsx";
import { getHighlightedCode } from "./syntax-highlight.ts";
import {
  BRAND,
  CARD,
  DIFF,
  GUTTER_RULE_ICON,
  INTERACTIVE,
  ROLE,
  type Role,
  SPACING,
  SURFACE,
  TOOL_STATUS,
  tint,
  toolStatus,
} from "./theme.ts";

// ── Display items ───────────────────────────────────────────────────────────────

export type Item =
  | {
      id: number;
      kind: "banner";
      /** App name (e.g. "canarycode"). */
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
  const rule = useIcon(GUTTER_RULE_ICON);
  return (
    <Box flexDirection="row">
      {/* flexShrink=0: Ink boxes default to flexShrink=1, so when the content's
          max-content width over-constrains the row, Yoga shrinks this fixed cell
          fractionally (e.g. 2 → 1.96). The fractional layout then rounds the text
          node a column WIDER than the space it actually has, and the wrapped text
          spills one character past the terminal edge. Pinning the fixed cells
          keeps every width integral. */}
      <Box width={2} flexShrink={0}>
        <Text color={tint(DIFF.gutter)} dimColor>{`${rule} `}</Text>
      </Box>
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
 * styled spans become nested `<Text>` runs. Streaming-safe —
 * `parseMarkdownWithFlags` re-parses the accumulated text on every render and
 * never throws on a partial marker, so the live region can grow delta-by-delta.
 * Exported for the other markdown-bearing surfaces (the plan review box).
 */
function LineSpans({
  line,
  dim,
  bold,
  selectable = true,
}: {
  line: MdLine;
  dim?: boolean;
  bold?: boolean;
  selectable?: boolean;
}): React.ReactElement {
  const spans = line.spans.map((span, si) => (
    <Text
      key={rowKey(si, span.text)}
      {...spanProps(span)}
      {...(dim ? { dimColor: true, italic: true } : {})}
      {...(bold ? { bold: true } : {})}
    >
      {span.text}
    </Text>
  ));
  return (
    <Text
      wrap="wrap"
      selectable={selectable}
      selectionBg={tint(INTERACTIVE.selectionBg)}
      selectionFg={tint(INTERACTIVE.selectionFg)}
    >
      {spans}
    </Text>
  );
}

function CodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}): React.ReactElement {
  const runtime = useTuiRuntime();
  const highlighted = getHighlightedCode(code, language, runtime.clear);
  const title = language ? ` ${language} ` : " code ";
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <RuleRow>
        <Text color={tint(DIFF.gutter)} dimColor>
          {title}
        </Text>
      </RuleRow>
      {highlighted.map((spans, li) => (
        <RuleRow key={rowKey(li, spans.map((span) => span.text).join(""))}>
          <Text
            wrap="truncate"
            selectable
            selectionBg={tint(INTERACTIVE.selectionBg)}
            selectionFg={tint(INTERACTIVE.selectionFg)}
          >
            {spans.map((span, si) => (
              <Text key={rowKey(si, span.text)} {...spanProps(span)}>
                {span.text}
              </Text>
            ))}
          </Text>
        </RuleRow>
      ))}
    </Box>
  );
}

function TableBlock({
  headers,
  rows,
  widths,
}: Extract<
  ReturnType<typeof parseMarkdownBlocks>[number],
  { kind: "table" }
>): React.ReactElement {
  const separator = widths.map((width) => "─".repeat(width)).join("─┼─");
  const renderCells = (
    cells: MdLine[],
    keyPrefix: string,
    bold = false,
  ): React.ReactElement => (
    <RuleRow key={keyPrefix}>
      <Text
        selectable
        selectionBg={tint(INTERACTIVE.selectionBg)}
        selectionFg={tint(INTERACTIVE.selectionFg)}
      >
        {cells.map((cell, col) => (
          <Text key={`${keyPrefix}:${col}`} {...(bold ? { bold: true } : {})}>
            {col > 0 ? " │ " : ""}
            {cell.spans.map((span, si) => (
              <Text key={rowKey(si, span.text)} {...spanProps(span)}>
                {span.text}
              </Text>
            ))}
          </Text>
        ))}
      </Text>
    </RuleRow>
  );

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {renderCells(headers, "table:header", true)}
      <RuleRow>
        <Text color={tint(DIFF.gutter)} dimColor>
          {separator}
        </Text>
      </RuleRow>
      {rows.map((row, i) => renderCells(row, `table:row:${i}`))}
    </Box>
  );
}

export function Markdown({
  text,
  dim,
}: {
  text: string;
  /** Render dimmed + italic — used for thinking blocks. */
  dim?: boolean;
}): React.ReactElement {
  // Drop a single trailing newline: streaming commits each block at a line
  // boundary (its text ends with "\n"), and `"…\n".split("\n")` yields a trailing
  // empty element that would render as a spurious blank row between chunks. The
  // newline is a separator, not content, so trimming one keeps prose tight while
  // leaving genuine `\n\n` paragraph gaps intact.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const blocks = parseMarkdownBlocks(body);
  return (
    <Box flexDirection="column">
      {blocks.map((block, bi) => {
        if (block.kind === "code") {
          return (
            <CodeBlock
              key={`code:${bi}:${block.language ?? ""}:${block.code.slice(0, 16)}`}
              code={block.code}
              language={block.language}
            />
          );
        }
        if (block.kind === "table") {
          return <TableBlock key={`table:${bi}`} {...block} />;
        }
        return (
          <Box key={`lines:${bi}`} flexDirection="column">
            {block.lines.map((line, li) => (
              <LineSpans
                key={rowKey(li, line.spans.map((s) => s.text).join(""))}
                line={line}
                dim={dim}
              />
            ))}
          </Box>
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
 * active model/provider — a slim filled chip in the same soft-block family as the
 * cards. Rendered as the first scrollback item so it scrolls away naturally.
 */
function BannerView({
  appName,
  version,
  cwd,
  model,
  provider,
}: Extract<Item, { kind: "banner" }>): React.ReactElement {
  return (
    <Box
      backgroundColor={tint(SURFACE.banner)}
      paddingX={SPACING.boxPadX}
      paddingY={SPACING.boxPadY}
      width="100%"
    >
      {/* The wordmark wears the CanaryCoders brand orange. */}
      <Text bold color={tint(BRAND.orange)}>{`${appName} v${version}`}</Text>
      <Text
        dimColor
      >{`  ${abbreviateCwd(cwd)}  ·  ${model} · ${provider}`}</Text>
      <Text color={tint(BRAND.orange)}>{"  ·  canarycoders.es"}</Text>
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
  children,
}: {
  speaker: Role;
  /** Override the gutter glyph colour (tool calls colour it by status). */
  colorOverride?: string;
  marginTop?: number;
  /** Suppress the glyph (a two-space gutter) — used for continuation chunks of a
   * streamed block whose first chunk already carried the marker. */
  glyphless?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const s = ROLE[speaker];
  const icon = useIcon(s.icon);
  const glyph = !glyphless && icon ? icon : " ";
  return (
    <Box flexDirection="row" marginTop={marginTop}>
      {/* Leave enough room for Nerd Font glyphs that terminals render as two
          cells; otherwise the glyph visually eats the following space.
          flexShrink=0: see RuleRow — a shrinkable fixed cell makes the layout
          fractional and the wrapped content spill past the terminal edge. */}
      <Box width={2} marginRight={1} flexShrink={0}>
        <Text
          color={tint(colorOverride ?? s.color)}
          bold={s.bold}
          dimColor={s.dim}
        >
          {glyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

function CopyActions({
  onCopy,
  label,
}: {
  onCopy?: () => void;
  label: string;
}): React.ReactElement | null {
  if (!onCopy) return null;
  return (
    <Box>
      <ActionChip label={`[${label}]`} color="gray" onAction={onCopy} />
    </Box>
  );
}

// ── Keyboard focus indicator ─────────────────────────────────────────────────────
//
// In nav mode the keyboard-focused block gets a left accent gutter bar (`▎`) so the
// eye lands on it without a mouse. Tool cards swap their own background instead (see
// ToolView); this is for the box-less user/assistant/thinking/note blocks. When the
// item isn't focused the bar is a transparent two-cell spacer so the content never
// shifts horizontally as focus moves. The accent passes through `tint` for NO_COLOR.

function FocusBar({
  focused,
  children,
}: {
  focused: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="row">
      {/* flexShrink=0: a shrinkable fixed cell makes the layout fractional and the
          wrapped content spill past the terminal edge (see RuleRow). */}
      <Box width={2} flexShrink={0}>
        {focused ? (
          <Text color={tint(CARD.user.color)} bold>
            {"▎"}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

// ── User card ────────────────────────────────────────────────────────────────────
//
// The user's message is the start of a turn, rendered as a cyan titled card so it
// stands clearly apart from the assistant's answer and the tool calls. Each input
// line is its own wrapping row inside the card; the box owns the width, so long
// lines wrap to the card's content edge rather than the terminal's.

function UserView({
  text,
  onCopy,
}: {
  text: string;
  onCopy?: () => void;
}): React.ReactElement {
  // Hover is tracked here (not in Card) so Card stays a pure layout component.
  // Over/out bubble up from the card's children, so hovering the text or the chip
  // itself keeps `hovered` true — the chip doesn't flicker as you reach for it.
  const [hovered, setHovered] = useState(false);
  return (
    <Card
      color={CARD.user.color}
      bg={CARD.user.bg}
      title={CARD.user.title}
      marginTop={SPACING.turnGap}
      headerRight={
        hovered ? <CopyActions onCopy={onCopy} label="copy" /> : null
      }
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      {text.split("\n").map((line, i) => (
        <Text
          key={rowKey(i, line)}
          wrap="wrap"
          selectable
          selectionBg={tint(INTERACTIVE.selectionBg)}
          selectionFg={tint(INTERACTIVE.selectionFg)}
        >
          {line}
        </Text>
      ))}
    </Card>
  );
}

const NOTE_TEXT_ICON_RE = /^[▣◇⎇⌁⌘≡◉⛉]/u;

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
  columns = 80,
  focusedToolId,
  itemFocused = false,
  onFocusTool,
  onToggleTool,
  onCopyItem,
}: {
  item: Item;
  /** Kind of the immediately preceding transcript item, for group spacing. */
  prevKind?: Item["kind"];
  expanded?: boolean;
  /** Render a one-time `click/enter expands · ctrl+r expands all` hint (the
   * session's first tool call). */
  showExpandHint?: boolean;
  /** Live (in-flight, redrawn) rendering: bound a tool to a single headline row so
   * it can't overflow the dynamic region and desync Ink. The full command/output
   * still renders once the item lands in `<Static>`. */
  compact?: boolean;
  /** Live content width (columns minus the deepest gutter). In `compact` mode the
   * tool headline and note text are truncated to this so they occupy exactly one
   * terminal row — a wrapped live line is what Ink mis-erases into stray fragments. */
  width?: number;
  /** Terminal width — the rows that paint a full-width highlight band (user
   * lines, diff +/− lines) wrap and pad themselves to it. */
  columns?: number;
  focusedToolId?: number | null;
  /** Keyboard nav focus for a NON-tool item (tools use `focusedToolId`). When
   * true, the user/assistant/thinking/note block shows a left accent gutter bar so
   * the keyboard-focused block is visibly distinguished. */
  itemFocused?: boolean;
  onFocusTool?: (id: number) => void;
  onToggleTool?: (id: number) => void;
  onCopyItem?: (item: Item, kind?: "default" | "command" | "output") => void;
}): React.ReactElement {
  switch (item.kind) {
    case "banner":
      return <BannerView {...item} />;
    case "user":
      // A user message starts a new turn → one blank line above its cyan card.
      return (
        <FocusBar focused={itemFocused}>
          <UserView text={item.text} onCopy={() => onCopyItem?.(item)} />
        </FocusBar>
      );
    case "assistant":
      // The model's answer is plain prose — no box, so no copy chip: it isn't a
      // card like the user/tool blocks. Copying an LLM answer is selection-based
      // (drag-select → auto-copies on release). Inset by one column so it lines up
      // with the boxed content around it.
      return (
        <FocusBar focused={itemFocused}>
          <Box
            flexDirection="column"
            paddingX={SPACING.boxPadX}
            marginTop={Math.max(1, topGap(item, prevKind))}
          >
            <Markdown text={item.text} />
          </Box>
        </FocusBar>
      );
    case "thinking":
      // Thinking is plain dim+italic prose, same layout as the assistant answer so
      // it reads as a quieter part of the same thread rather than a separate block.
      // Like the assistant answer, it's selection-copied, not chip-copied.
      return (
        <FocusBar focused={itemFocused}>
          <Box
            flexDirection="column"
            paddingX={SPACING.boxPadX}
            marginTop={Math.max(1, topGap(item, prevKind))}
          >
            <Markdown text={item.text} dim />
          </Box>
        </FocusBar>
      );
    case "tool":
      // Every tool call is its own titled card (its own colour), so the actions a
      // turn took read as a distinct stack under the answer that triggered them.
      return (
        <ToolView
          item={item}
          expanded={expanded}
          showHint={showExpandHint}
          compact={compact}
          width={width}
          columns={columns}
          marginTop={Math.max(1, topGap(item, prevKind))}
          focused={focusedToolId === item.id}
          onFocus={() => onFocusTool?.(item.id)}
          onToggle={() => onToggleTool?.(item.id)}
          onCopyCommand={() => onCopyItem?.(item, "command")}
          onCopyOutput={() => onCopyItem?.(item, "output")}
        />
      );
    case "note": {
      // While live (compact), truncate to one row so the note can't wrap and
      // desync the redrawn region; the full note lands in scrollback on finalise.
      const text = compact && width ? truncate(item.text, width) : item.text;
      const marginTop =
        prevKind === "note" ? SPACING.groupGap : SPACING.blockGap;
      const cardMarginTop = Math.max(1, marginTop);
      // Error notes get a red card for emphasis; ordinary info notes stay flat and
      // dim behind their gutter glyph so routine context doesn't add box clutter.
      if (item.tone === "error") {
        return (
          <FocusBar focused={itemFocused}>
            <Card
              color={CARD.error.color}
              bg={CARD.error.bg}
              title={CARD.error.title}
              marginTop={cardMarginTop}
            >
              <Text color={tint(CARD.error.color)} wrap="wrap">
                {text}
              </Text>
            </Card>
          </FocusBar>
        );
      }
      const carriesIcon = NOTE_TEXT_ICON_RE.test(text);
      return (
        <FocusBar focused={itemFocused}>
          <Gutter speaker="note" glyphless={carriesIcon} marginTop={marginTop}>
            <Text color={tint("gray")}>{text}</Text>
          </Gutter>
        </FocusBar>
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
  columns = 80,
  marginTop = 0,
  focused = false,
  onFocus,
  onToggle,
  onCopyCommand,
  onCopyOutput,
}: {
  item: Extract<Item, { kind: "tool" }>;
  expanded: boolean;
  /** Show the one-time `click/enter expands · ctrl+r expands all` affordance hint
   * (collapsed only). */
  showHint?: boolean;
  /** Live rendering: bound to a single headline row (no card, no body, no diff) so
   * the redrawn live region can't overflow. The full card renders once the item
   * lands in the scrollback. */
  compact?: boolean;
  /** Live content width — the compact headline is truncated to it (mark included)
   * so the whole row fits the terminal and never wraps. */
  width?: number;
  /** Terminal width — the card title and diff preview are sized against it. */
  columns?: number;
  /** Blank rows above the card (group spacing from the caller). */
  marginTop?: number;
  focused?: boolean;
  onFocus?: () => void;
  onToggle?: () => void;
  onCopyCommand?: () => void;
  onCopyOutput?: () => void;
}): React.ReactElement {
  const status = toolStatus(item.pending, item.isError);
  const glyph = useIcon(ROLE.tool.icon);
  const mark = useIcon(TOOL_STATUS[status].icon);
  const statusColor = TOOL_STATUS[status].color;
  const summary = summarizeToolInput(item.name, item.input);
  const name = displayToolName(item.name);
  // The block accent/fill is the soft tool tone for an ordinary call and the soft
  // error tone for a failure, so a failed tool jumps out while still reading as a
  // tool. The status mark (…/✓/✗) carries pending-vs-ok.
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);
  const setPressedState = (next: boolean): void => {
    pressedRef.current = next;
    setPressed(next);
  };
  const cardColor = item.isError ? CARD.error.color : CARD.tool.color;
  const baseCardBg = item.isError ? CARD.error.bg : CARD.tool.bg;
  const cardBg = pressed
    ? "#161a22"
    : focused || hovered
      ? "#2a3444"
      : baseCardBg;

  // `bash` shows the FULL command; every other tool keeps the short summary. Both
  // are truncated for the title so it always fits on the border run.
  const shown = summary
    ? item.name === "bash"
      ? truncate(summary, Math.max(8, columns - 16))
      : truncate(summary, 72)
    : "";
  const headline = shown ? `${glyph} ${name} · ${shown}` : `${glyph} ${name}`;

  // Live (compact): one flat coloured row (glyph + headline + mark), truncated to
  // the live content width so it never wraps. The full card renders on finalise.
  if (compact) {
    const line = `${headline} ${mark}`;
    return (
      <Box flexDirection="column">
        <Text color={tint(statusColor)}>
          {width ? truncate(line, width) : line}
        </Text>
      </Box>
    );
  }

  // Title carries the headline + status mark, truncated to the card's inner width
  // (terminal minus the 2 border + 2 padding cells, with a little slack).
  const title = truncate(`${headline} ${mark}`, Math.max(8, columns - 6));

  // Show a 1–2 line preview of the tool's output by default, expanding to a deeper
  // head when verbose. Errors render their lines in red; success previews are dim.
  const body =
    !item.pending && item.result ? head(item.result, expanded ? 20 : 2) : null;

  // write_file/edit_file carry a diff: always preview it (collapsed = first hunk).
  const showDiff =
    !item.pending && !item.isError && item.diff && item.diff.hunks.length > 0;

  return (
    <Card
      color={cardColor}
      bg={cardBg}
      title={title}
      marginTop={marginTop}
      cursor="pointer"
      headerRight={
        hovered ? (
          <Box>
            <ActionChip
              label="[copy command]"
              color="gray"
              onAction={() => onCopyCommand?.()}
            />
            <Text dimColor> </Text>
            <ActionChip
              label="[copy output]"
              color="gray"
              onAction={() => onCopyOutput?.()}
            />
          </Box>
        ) : null
      }
      onMouseOver={() => {
        setHovered(true);
        onFocus?.();
      }}
      onMouseOut={() => {
        setHovered(false);
        setPressedState(false);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        setPressedState(true);
        event.stopPropagation();
      }}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        const wasPressed = pressedRef.current;
        setPressedState(false);
        event.stopPropagation();
        if (wasPressed) onToggle?.();
      }}
    >
      {expanded && summary ? (
        <Text
          dimColor
          wrap="truncate"
          selectable
          selectionBg={tint(INTERACTIVE.selectionBg)}
          selectionFg={tint(INTERACTIVE.selectionFg)}
        >
          {truncate(fmtInput(item.input), 200)}
        </Text>
      ) : null}
      {body
        ? body.lines.map((line, i) => (
            <Text
              key={rowKey(i, line)}
              color={tint(item.isError ? "red" : undefined)}
              dimColor={!item.isError}
              wrap="truncate"
              selectable
              selectionBg={tint(INTERACTIVE.selectionBg)}
              selectionFg={tint(INTERACTIVE.selectionFg)}
            >
              {line}
            </Text>
          ))
        : null}
      {body && body.more > 0 ? (
        <Text dimColor>{`…(+${body.more} more lines)`}</Text>
      ) : null}
      {showDiff ? (
        // Inside the card: terminal minus 2 border + 2 padding + the 2-cell rule.
        <DiffView
          diff={item.diff!}
          expanded={expanded}
          width={Math.max(1, columns - 6)}
        />
      ) : null}
      {showHint && !expanded ? (
        <Text dimColor>{"click/enter expands · ctrl+r expands all"}</Text>
      ) : null}
    </Card>
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
  add: DIFF.add,
  del: DIFF.del,
};
const DIFF_BG: Record<DiffLine["type"], string | undefined> = {
  context: undefined,
  add: DIFF.addBg,
  del: DIFF.delBg,
};

interface DiffRow {
  text: string;
  color?: string;
  /** Background painted across the full row width (`+`/`−` lines only). */
  bg?: string;
}

/** Flatten a diff's hunks into renderable rows (headers + `+`/`-`/context lines). */
function diffRows(hunks: Diff["hunks"]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const h of hunks) {
    rows.push({
      text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      color: DIFF.header,
    });
    for (const line of h.lines) {
      rows.push({
        text: DIFF_PREFIX[line.type] + line.text,
        color: DIFF_COLOR[line.type],
        bg: DIFF_BG[line.type],
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
  width = 75,
}: {
  diff: Diff;
  expanded: boolean;
  /** Content width for one diff row (what's left after the caller's gutters and
   * the 2-cell rule). `+`/`−` rows are truncated *and padded* to it, so their
   * background paints a full-width band that can never soft-wrap (a wrapped row
   * would desync Ink when this renders in the dynamic region, e.g. the confirm
   * gate). */
  width?: number;
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
        <RuleRow key={rowKey(i, r.text)}>
          <Text color={tint(r.color)} backgroundColor={tint(r.bg)}>
            {r.bg
              ? padRow(truncateWidth(r.text, width), width)
              : truncateWidth(r.text, width)}
          </Text>
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
