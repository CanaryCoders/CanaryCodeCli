// fuzzy.ts — a tiny fzf-style fuzzy scorer for the `/` command autocomplete.
//
// The TUI's slash autocomplete (Complete.tsx) ranks commands and parameter
// values by how well they match what the user has typed. This is a small,
// dependency-free subsequence matcher: every query char must appear in the
// target in order, and matches score higher when they are contiguous, fall on a
// word boundary (start of string, or after a separator / camelCase hump), or
// sit near the start. Greedy leftmost matching — not provably optimal, but more
// than good enough for short command names and ids, and trivial to reason about.

/** A successful match: a relevance score (higher is better) and matched indices. */
export interface FuzzyMatch {
  score: number;
  /** Indices in the target string that the query matched, in order. */
  positions: number[];
}

// Scoring weights. Tuned so a boundary/contiguous match clearly outranks a
// scattered mid-word one, while every matched char still earns a base point.
const BASE = 1;
const BONUS_BOUNDARY = 8; // match at start-of-word (after separator / camelCase)
const BONUS_FIRST = 4; // extra when the match is the very first char
const BONUS_CONSECUTIVE = 6; // match immediately follows the previous match
const MAX_GAP_PENALTY = 3; // cap the per-gap distance penalty

const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":"]);

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

/** Whether the char at `i` begins a "word" (start, post-separator, or camel hump). */
function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1]!;
  if (SEPARATORS.has(prev)) return true;
  // camelCase: lower→Upper transition starts a new word.
  return isUpper(target[i]!) && !isUpper(prev);
}

/**
 * Score `query` against `target`, case-insensitively. Returns null when `query`
 * is not a subsequence of `target`. An empty query matches everything with
 * score 0 (so a bare `/` lists every command in registry order).
 */
export function fuzzyScore(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  if (q.length > t.length) return null;

  const positions: number[] = [];
  let score = 0;
  let from = 0; // next target index to search from
  let prev = -2; // index of the previously matched char (-2 = none yet)

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    for (let k = from; k < t.length; k++) {
      if (t[k] === ch) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;

    let pts = BASE;
    if (found === 0) pts += BONUS_FIRST + BONUS_BOUNDARY;
    else if (isBoundary(target, found)) pts += BONUS_BOUNDARY;
    if (found === prev + 1) pts += BONUS_CONSECUTIVE;
    else if (prev >= 0) pts -= Math.min(found - prev - 1, MAX_GAP_PENALTY);

    score += pts;
    positions.push(found);
    prev = found;
    from = found + 1;
  }

  return { score, positions };
}

/** A ranked candidate: the original item plus its match score and positions. */
export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Rank `items` by how well their `key` text matches `query`, best first.
 * Non-matching items are dropped. Ties keep input order (Array#sort is stable),
 * so a registry's natural ordering survives an empty/loose query.
 */
export function fuzzyRank<T>(query: string, items: T[], key: (item: T) => string): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const m = fuzzyScore(query, key(item));
    if (m) out.push({ item, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
