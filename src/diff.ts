// diff.ts — a tiny, dependency-free unified-diff helper for write/edit previews.
//
// When the agent runs `write_file` or `edit_file` the user must see exactly what
// changed, not just `⚙ write_file: path ✓`. This computes a line-level diff
// between the prior and new contents and renders it in the familiar unified
// (`@@ -a,b +c,d @@`) format so both front-ends can show it: headless prints it
// (colourized on a TTY), the TUI renders it under the collapsed tool line.
//
// The engine is a classic LCS (longest-common-subsequence) over lines — provably
// minimal, trivial to reason about, no deps. A size guard keeps the O(n·m) table
// bounded: pathologically large inputs degrade to a whole-file replace rather
// than allocating gigabytes.

/** One line of a diff: kept context, an addition (`+`), or a deletion (`-`). */
export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
}

/** A contiguous run of changes plus surrounding context, with 1-based starts. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Structured diff: the hunks plus added/removed line totals. */
export interface Diff {
  hunks: Hunk[];
  added: number;
  removed: number;
}

// Above this LCS table size (cells) we skip the DP and emit a whole-file
// replace — keeps memory bounded on huge or pathological inputs.
const MAX_LCS_CELLS = 4_000_000;

/** Split into lines, dropping a single trailing newline so it isn't a phantom "" line. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split("\n");
}

/**
 * Line-level diff via LCS. Returns the ordered op list (context/del/add) where
 * deletions precede additions at each change point — the conventional ordering.
 */
function diffOps(a: string[], b: string[]): DiffLine[] {
  // Bail to a whole-file replace if the DP table would be too large.
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++]! });
  while (j < m) ops.push({ type: "add", text: b[j++]! });
  return ops;
}

/**
 * Compute a structured diff between two texts, grouped into hunks with up to
 * `context` lines of surrounding context (default 3). Adjacent change regions
 * within `2*context` lines are merged into one hunk, as in real unified diffs.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  context = 3,
): Diff {
  const ops = diffOps(toLines(oldText), toLines(newText));

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }

  // Indices of the changed ops, so we know which context lines to keep.
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++)
    if (ops[k]!.type !== "context") changeIdx.push(k);
  if (changeIdx.length === 0) return { hunks: [], added: 0, removed: 0 };

  // Merge change indices into [start, end] op-ranges padded by `context`,
  // joining ranges whose padded windows touch or overlap.
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  // Walk the ops once, tracking 1-based old/new line numbers, to slice hunks.
  const hunks: Hunk[] = [];
  let oldNo = 1;
  let newNo = 1;
  let r = 0;
  const lineNoAt: { old: number; new: number }[] = new Array(ops.length);
  for (let k = 0; k < ops.length; k++) {
    lineNoAt[k] = { old: oldNo, new: newNo };
    const t = ops[k]!.type;
    if (t === "context") {
      oldNo++;
      newNo++;
    } else if (t === "del") oldNo++;
    else newNo++;
  }

  for (r = 0; r < ranges.length; r++) {
    const { start, end } = ranges[r]!;
    const lines = ops.slice(start, end + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const op of lines) {
      if (op.type !== "add") oldCount++;
      if (op.type !== "del") newCount++;
    }
    hunks.push({
      oldStart: lineNoAt[start]!.old,
      oldLines: oldCount,
      newStart: lineNoAt[start]!.new,
      newLines: newCount,
      lines,
    });
  }

  return { hunks, added, removed };
}

const PREFIX: Record<DiffLine["type"], string> = {
  context: " ",
  add: "+",
  del: "-",
};

export interface RenderOptions {
  /** Cap the number of body lines emitted; the rest collapse to a `…` marker. */
  maxLines?: number;
  /** Wrap +/- lines in ANSI green/red (for a TTY). Default false. */
  color?: boolean;
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

/**
 * Render a structured diff to unified-diff text. Each hunk gets an `@@` header
 * followed by its ` `/`+`/`-` lines. With `maxLines`, output is truncated and a
 * `…(+N more lines)` marker appended so very large diffs stay readable.
 */
export function renderDiff(diff: Diff, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const max = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : Infinity;
  // Total emittable lines across all hunks (each hunk = 1 header + its lines).
  const totalLines = diff.hunks.reduce((s, h) => s + h.lines.length + 1, 0);
  let emitted = 0; // headers + body lines actually written

  for (const h of diff.hunks) {
    if (emitted >= max) break;
    const header = opts.color
      ? `${CYAN}${hunkHeader(h)}${RESET}`
      : hunkHeader(h);
    out.push(header);
    emitted++;
    for (const line of h.lines) {
      if (emitted >= max) break;
      const raw = PREFIX[line.type] + line.text;
      if (opts.color && line.type === "add") out.push(`${GREEN}${raw}${RESET}`);
      else if (opts.color && line.type === "del")
        out.push(`${RED}${raw}${RESET}`);
      else out.push(raw);
      emitted++;
    }
  }

  const remaining = totalLines - emitted;
  if (remaining > 0) out.push(`…(+${remaining} more lines)`);

  return out.join("\n");
}

/** A compact `+N -M` summary for collapsed tool lines. */
export function diffStat(diff: Diff): string {
  return `+${diff.added} -${diff.removed}`;
}
