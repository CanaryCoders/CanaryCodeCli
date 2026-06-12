// tui/message-helpers.ts — pure, framework-agnostic helpers for the transcript
// renderer (Message.tsx). These hold no JSX and render nothing; they live apart
// from the component module so Message.tsx only exports components (clean
// fast-refresh boundaries) and so they can be unit-tested without a renderer.

import type { Message } from "../provider.ts";
import {
  pickVerb,
  RESPONDING_VERBS,
  THINKING_VERBS,
  TOOL_VERB,
} from "../verbs.ts";
import { charWidth } from "./input-helpers.ts";
import type { Item, ItemInput } from "./Message.tsx";

// ── display-width helpers ────────────────────────────────────────────────────────

/** Visible terminal-cell width of `s` (wcwidth-style: CJK/emoji count 2). */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Pad `row` with trailing spaces to exactly `width` visible columns (no-op for
 * rows already at/over it). Ink's `backgroundColor` paints only the glyphs a
 * `<Text>` actually draws, so a full-line highlight band needs its rows padded
 * out to the content width. */
export function padRow(row: string, width: number): string {
  const pad = width - visibleWidth(row);
  return pad > 0 ? row + " ".repeat(pad) : row;
}

/** Truncate `s` to at most `max` visible columns (CJK/emoji count 2), ending in
 * `…` when anything was cut. The char-count `truncate` under-counts wide chars,
 * which would let a CJK-heavy row escape a width-exact band. */
export function truncateWidth(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Word-wrap one logical line into rows no wider than `width` visible columns.
 * Wraps at spaces; a word wider than a whole row is hard-broken at the width.
 * Wide (CJK/emoji) chars count 2 columns. Rows come back unpadded. */
export function wrapWords(line: string, width: number): string[] {
  const w = Math.max(1, width);
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const word of line.split(" ")) {
    const joinW = cur ? 1 : 0;
    const wordW = visibleWidth(word);
    if (curW + joinW + wordW <= w) {
      cur = cur ? `${cur} ${word}` : word;
      curW += joinW + wordW;
      continue;
    }
    if (cur) {
      rows.push(cur);
      cur = "";
      curW = 0;
    }
    if (wordW <= w) {
      cur = word;
      curW = wordW;
      continue;
    }
    // The word alone is wider than a row — hard-break it at the width.
    for (const ch of word) {
      const cw = charWidth(ch);
      if (curW + cw > w) {
        rows.push(cur);
        cur = ch;
        curW = cw;
      } else {
        cur += ch;
        curW += cw;
      }
    }
  }
  rows.push(cur);
  return rows;
}

// ── Tool input summarising ───────────────────────────────────────────────────────

/** For each tool, the input field that best summarises the call on one line. */
const TOOL_SUMMARY_FIELD: Record<string, string> = {
  bash: "command",
  read_file: "path",
  write_file: "path",
  edit_file: "path",
  list_dir: "path",
  grep: "pattern",
  web_fetch: "url",
  github_read_file: "repo_url",
  web_search: "query",
  read_skill: "name",
  spawn_agent: "task",
};

/** Split canarycode's MCP namespace (`mcp__server__tool`) into display-friendly parts. */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  const match = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!match) return null;
  return { server: match[1]!, tool: match[2]! };
}

/** Human-facing tool label. MCP calls drop the mechanical `mcp__…__` prefix. */
export function displayToolName(name: string): string {
  const mcp = parseMcpToolName(name);
  return mcp ? `${mcp.server}.${mcp.tool}` : name;
}

/** Pull the single most salient argument from a tool's input, e.g. the command
 * for `bash` or the path for `read_file`. Falls back to a compact key/value list
 * instead of raw JSON so unknown/MCP tools stay readable. Returns "" when there's
 * nothing worth showing. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const field = TOOL_SUMMARY_FIELD[name];
    if (field && typeof rec[field] === "string" && rec[field]) {
      return collapseWhitespace(rec[field] as string);
    }
    return fmtArgs(rec);
  }
  return fmtInput(input);
}

/** Compact one-line rendering of a tool's full input arguments (JSON). */
export function fmtInput(input: unknown): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s === "{}" || s === undefined || s === "null") return "";
  return s;
}

function fmtArgs(rec: Record<string, unknown>): string {
  const parts = Object.entries(rec)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .filter((part) => !part.endsWith(": "));
  return parts.join(", ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return collapseWhitespace(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  return fmtInput(value);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A stable, data-derived React key for an item in a recomputed render list (a
 * markdown line, a diff row, a result line). The list is fully regenerated from
 * source text on every render and is strictly append-only/positional — there is
 * no domain id to key on — so we derive the key from the row's own content. The
 * leading ordinal disambiguates genuinely-identical rows (e.g. two blank lines)
 * without reintroducing a bare index key, and a short content slice keeps keys
 * stable across re-renders as the same text re-occupies the same position.
 */
export function rowKey(ordinal: number, content: string): string {
  return `${ordinal}:${content.slice(0, 32)}`;
}

/** First `n` non-trivial lines of a tool result, with an "(+N more)" marker. */
export function head(
  text: string,
  n: number,
): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  return {
    lines: all.slice(0, n).map((l) => truncate(l, 200)),
    more: Math.max(0, all.length - n),
  };
}

// ── Session resume ───────────────────────────────────────────────────────────────

/**
 * Convert a persisted Message transcript back into renderable scrollback items
 * (session resume). tool_use blocks pair with their tool_result by id, so a
 * resumed tool call shows its outcome; image blocks have no transcript
 * rendering and are skipped (the model still received them in the original
 * turn). Ids are assigned by the caller (the transcript owns the id counter).
 */
export function itemsFromMessages(messages: Message[]): ItemInput[] {
  const results = new Map<string, { content: string; is_error?: boolean }>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result")
        results.set(b.tool_use_id, {
          content: b.content,
          is_error: b.is_error,
        });
    }
  }
  const out: ItemInput[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          if (!b.text.trim()) break;
          out.push(
            m.role === "user"
              ? { kind: "user", text: b.text }
              : { kind: "assistant", text: b.text },
          );
          break;
        case "thinking":
          if (b.thinking.trim())
            out.push({ kind: "thinking", text: b.thinking });
          break;
        case "tool_use": {
          const r = results.get(b.id);
          out.push({
            kind: "tool",
            toolId: b.id,
            name: b.name,
            input: b.input,
            // Never resume into a spinner: an unmatched call (interrupted turn)
            // still renders as finished, just without a result.
            pending: false,
            result: r?.content,
            isError: r?.is_error,
          });
          break;
        }
        // tool_result renders via its tool_use; images are skipped.
      }
    }
  }
  return out;
}

// ── Live status verb ───────────────────────────────────────────────────────────

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

// ── Live-region clamping ───────────────────────────────────────────────────────

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
