// tui/syntax-highlight.ts — tiny async Shiki adapter with a sync cache.
//
// Markdown rendering is synchronous, while Shiki loads grammars/themes async. This
// module keeps that boundary narrow: callers ask for cached tokens; on a miss we
// kick off highlighting in the background and invoke `onReady` so the TUI can
// repaint. The first paint stays fast/plain, subsequent paints are highlighted.

import type { BundledLanguage, ThemedToken } from "shiki";
import { codeToTokens } from "shiki";
import type { Span } from "../markdown.ts";

const THEME = "tokyo-night";
const MAX_CODE_CHARS = 60_000;
const MAX_LINE_LENGTH = 500;

const cache = new Map<string, Span[][]>();
const pending = new Set<string>();

function cacheKey(code: string, language?: string): string {
  return `${language ?? "text"}\0${code}`;
}

function normalizeLanguage(language?: string): BundledLanguage | "text" {
  if (!language) return "text";
  const lower = language.toLowerCase();
  if (lower === "ts") return "typescript";
  if (lower === "tsx") return "tsx";
  if (lower === "js") return "javascript";
  if (lower === "jsx") return "jsx";
  if (lower === "sh" || lower === "shell") return "bash";
  if (lower === "yml") return "yaml";
  if (lower === "md") return "markdown";
  return lower as BundledLanguage;
}

function tokenToSpan(token: ThemedToken): Span {
  return {
    text: token.content,
    color: token.color,
    bold: Boolean(token.fontStyle && token.fontStyle & 2),
    italic: Boolean(token.fontStyle && token.fontStyle & 1),
    underline: Boolean(token.fontStyle && token.fontStyle & 4),
  };
}

function plainCode(code: string): Span[][] {
  const lines = code.split("\n");
  return lines.map((line) => [{ text: line, dim: true }]);
}

export function getHighlightedCode(
  code: string,
  language: string | undefined,
  onReady: () => void,
): Span[][] {
  if (code.length > MAX_CODE_CHARS) return plainCode(code);
  const key = cacheKey(code, language);
  const cached = cache.get(key);
  if (cached) return cached;
  if (!pending.has(key)) {
    pending.add(key);
    codeToTokens(code, {
      lang: normalizeLanguage(language),
      theme: THEME,
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
      tokenizeTimeLimit: 100,
    })
      .then((result) => {
        cache.set(
          key,
          result.tokens.map((line) =>
            line.length > 0 ? line.map(tokenToSpan) : [{ text: "" }],
          ),
        );
        onReady();
      })
      .catch(() => {
        cache.set(key, plainCode(code));
        onReady();
      })
      .finally(() => pending.delete(key));
  }
  return plainCode(code);
}
