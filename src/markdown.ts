// markdown.ts — a tiny, dependency-free markdown to terminal styling helper.
//
// Assistant text is markdown, but `**bold**`, `# headings`, lists, and code
// fences print literally in a raw terminal. This tokenizes the common subset the
// model actually emits and maps it to terminal styling, producing a neutral
// "span" model that both front-ends consume:
//   - the TUI (Message.tsx) maps each span to an Ink `<Text>` (bold/italic/...),
//   - headless maps each span to ANSI escapes via `renderAnsi` (TTY only).
//
// It is deliberately NOT a full CommonMark engine — it handles ~90% of what the
// model emits and passes anything unknown through verbatim. It is also
// streaming-safe: it never throws on a half-open `**` or an unterminated fence —
// unbalanced inline markers stay literal until their closer arrives, and lines
// after an unclosed fence render as code.

/** An inline run of text with terminal styling. Field names match Ink `<Text>`
 * props so the TUI can spread them; `renderAnsi` maps them to SGR codes. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Dim (faint) — used for code blocks, quotes, and link URLs. */
  dim?: boolean;
  /** An Ink colour name (e.g. "cyan"); `renderAnsi` maps the common ones. */
  color?: string;
}

/** One rendered line: a list of styled spans (an empty line = one empty span). */
export interface MdLine {
  spans: Span[];
}

// ── Inline parsing ─────────────────────────────────────────────────────────────────

/** The styling carried into a nested inline span (bold containing italic, etc.). */
type Style = Omit<Span, "text">;

const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9]/.test(c);

/**
 * Parse one line of inline markdown into styled spans under a base style.
 * Recognises (in priority order): inline `code`, `**bold**`/`__bold__`,
 * `~~strike~~`, `*italic*`/`_italic_`, and `[text](url)` links. Underscore
 * emphasis is word-boundary-guarded so `snake_case` is left alone. Any marker
 * without a closer on this line is emitted literally (streaming-safe).
 */
function parseInline(text: string, base: Style = {}): Span[] {
  const spans: Span[] = [];
  let buf = "";
  const flush = () => {
    if (buf) spans.push({ text: buf, ...base });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);

    // Inline code — content is NOT re-parsed (verbatim between backticks).
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        spans.push({
          text: text.slice(i + 1, close),
          ...base,
          color: "yellow",
        });
        i = close + 1;
        continue;
      }
    }

    // Bold: ** (unguarded) or __ (word-boundary-guarded so a__b stays literal).
    if (two === "**" || two === "__") {
      const guarded = two === "__" && isWordChar(text[i - 1]);
      const close = guarded ? -1 : text.indexOf(two, i + 2);
      if (close > i + 1 && !(two === "__" && isWordChar(text[close + 2]))) {
        flush();
        spans.push(
          ...parseInline(text.slice(i + 2, close), { ...base, bold: true }),
        );
        i = close + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (two === "~~") {
      const close = text.indexOf("~~", i + 2);
      if (close > i + 1) {
        flush();
        spans.push(
          ...parseInline(text.slice(i + 2, close), {
            ...base,
            strikethrough: true,
          }),
        );
        i = close + 2;
        continue;
      }
    }

    // Italic: * (unguarded) or _ (word-boundary-guarded). Single marker only —
    // a double marker was already handled as bold above.
    if ((c === "*" || c === "_") && text[i + 1] !== c) {
      const guarded = c === "_" && isWordChar(text[i - 1]);
      const close = guarded ? -1 : text.indexOf(c, i + 1);
      if (close > i + 1 && !(c === "_" && isWordChar(text[close + 1]))) {
        flush();
        spans.push(
          ...parseInline(text.slice(i + 1, close), { ...base, italic: true }),
        );
        i = close + 1;
        continue;
      }
    }

    // Link: [text](url) — show the text styled, the URL dimmed in parens.
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        spans.push(
          ...parseInline(m[1]!, { ...base, underline: true, color: "blue" }),
        );
        spans.push({ text: ` (${m[2]})`, ...base, dim: true });
        i += m[0]!.length;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  // A wholly-empty line still needs one (empty) span so it renders as a blank row.
  return spans.length > 0 ? spans : [{ text: "", ...base }];
}

// ── Block parsing ──────────────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)([.)])\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
const INDENT_CODE = /^(?: {4}|\t)/;

/**
 * Parse a markdown document into styled lines AND per-line code flags in a
 * single fence/indent walk. Block constructs handled: fenced & indented code
 * (dim), `#`–`######` headings (bold cyan), `>` quotes (dim with a `│` gutter),
 * `-`/`*`/`+` bullets (`•`), numbered lists, and plain paragraphs
 * (inline-styled). Unknown lines pass through as plain text.
 *
 * `code[i]` is true when line `i` is code — a ``` fence delimiter, a line
 * inside a fence, or an indented code line. Both arrays align 1:1 with
 * `src.split("\n")` (each row consumes exactly one source line), so
 * `lines.length === code.length` always holds and renderers can index either
 * directly.
 *
 * The code flag matches what the line actually renders as: under the old
 * mirrored loop an indented bullet/quote rendered as a list item but was still
 * flagged as code, and the single pass fixes that inconsistency.
 */
export function parseMarkdownWithFlags(src: string): {
  lines: MdLine[];
  code: boolean[];
} {
  const lines: MdLine[] = [];
  const code: boolean[] = [];
  let inFence = false;

  for (const raw of src.split("\n")) {
    // Fence delimiters toggle code mode; the ``` line itself renders dim and
    // counts as part of the code block.
    if (FENCE.test(raw)) {
      inFence = !inFence;
      lines.push({ spans: [{ text: raw, dim: true }] });
      code.push(true);
      continue;
    }
    if (inFence) {
      lines.push({ spans: [{ text: raw, dim: true }] });
      code.push(true);
      continue;
    }

    const h = HEADING.exec(raw);
    if (h) {
      lines.push({ spans: parseInline(h[2]!, { bold: true, color: "cyan" }) });
      code.push(false);
      continue;
    }

    const q = QUOTE.exec(raw);
    if (q) {
      lines.push({
        spans: [
          { text: "│ ", dim: true },
          ...parseInline(q[1]!, { dim: true }),
        ],
      });
      code.push(false);
      continue;
    }

    // Bullet before bold: `* item` (marker + space) won't match `**bold**`.
    const b = BULLET.exec(raw);
    if (b) {
      lines.push({ spans: [{ text: `${b[1]}• ` }, ...parseInline(b[2]!, {})] });
      code.push(false);
      continue;
    }

    const n = NUMBERED.exec(raw);
    if (n) {
      lines.push({
        spans: [{ text: `${n[1]}${n[2]}${n[3]} ` }, ...parseInline(n[4]!, {})],
      });
      code.push(false);
      continue;
    }

    // Indented (non-blank) lines are code blocks: render dim, verbatim.
    if (INDENT_CODE.test(raw) && raw.trim() !== "") {
      lines.push({ spans: [{ text: raw, dim: true }] });
      code.push(true);
      continue;
    }

    lines.push({ spans: parseInline(raw, {}) });
    code.push(false);
  }

  return { lines, code };
}

/**
 * Styled lines only — a view over `parseMarkdownWithFlags` for callers that
 * don't need the code flags (e.g. `renderAnsi`).
 */
export function parseMarkdown(src: string): MdLine[] {
  return parseMarkdownWithFlags(src).lines;
}

/**
 * Per-line flags marking which lines of `src` are code (fenced or indented) — a
 * view over `parseMarkdownWithFlags` for callers that don't need the styled
 * lines. The TUI draws a faint left gutter rule down code blocks so they read
 * as a distinct unit. The array aligns 1:1 with both `src.split("\n")` and
 * `parseMarkdown`'s output (each consumes exactly one line per row), so the
 * renderer can index it directly.
 */
export function codeLineFlags(src: string): boolean[] {
  return parseMarkdownWithFlags(src).code;
}

// ── ANSI rendering (headless) ────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const COLOR_SGR: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  gray: "90",
  grey: "90",
};

/** Wrap a span's text in the ANSI SGR codes for its styling (reset after). */
function spanToAnsi(span: Span): string {
  const codes: string[] = [];
  if (span.bold) codes.push("1");
  if (span.dim) codes.push("2");
  if (span.italic) codes.push("3");
  if (span.underline) codes.push("4");
  if (span.strikethrough) codes.push("9");
  if (span.color && COLOR_SGR[span.color]) codes.push(COLOR_SGR[span.color]!);
  if (codes.length === 0) return span.text;
  return `\x1b[${codes.join(";")}m${span.text}${RESET}`;
}

/**
 * Render markdown to an ANSI-styled string for a TTY. Caller is responsible for
 * only using this when colour is wanted (stdout is a TTY, not `--json`/piped,
 * `NO_COLOR` unset) — piped output should keep the raw markdown so it composes.
 */
export function renderAnsi(src: string): string {
  return parseMarkdown(src)
    .map((line) => line.spans.map(spanToAnsi).join(""))
    .join("\n");
}
