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

// ── Display items ───────────────────────────────────────────────────────────────

export type Item =
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** First `n` non-trivial lines of a tool result, with an "(+N more)" marker. */
function head(text: string, n: number): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  return { lines: all.slice(0, n).map((l) => truncate(l, 200)), more: Math.max(0, all.length - n) };
}

// ── Rendering ────────────────────────────────────────────────────────────────────

export function ItemView({
  item,
  expanded = false,
}: {
  item: Item;
  expanded?: boolean;
}): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan" bold>{"› "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return <Text>{item.text}</Text>;
    case "thinking":
      return <Text dimColor>{`💭 ${item.text}`}</Text>;
    case "tool":
      return <ToolView item={item} expanded={expanded} />;
    case "note":
      return <Text color={item.tone === "error" ? "red" : "gray"}>{item.text}</Text>;
  }
}

function ToolView({
  item,
  expanded,
}: {
  item: Extract<Item, { kind: "tool" }>;
  expanded: boolean;
}): React.ReactElement {
  const mark = item.pending ? "…" : item.isError ? "✗" : "✓";
  const color = item.pending ? "yellow" : item.isError ? "red" : "green";
  const summary = summarizeToolInput(item.name, item.input);
  const headline = summary ? `${item.name}: ${truncate(summary, 72)}` : item.name;

  // Errors always reveal their first line; expansion reveals input + output head.
  const showBody = !item.pending && item.result && (expanded || item.isError);
  const body = showBody ? head(item.result!, expanded ? 20 : 1) : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{`⚙ ${headline}`}</Text>
        <Text dimColor>{` ${mark}`}</Text>
      </Box>
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
    </Box>
  );
}
