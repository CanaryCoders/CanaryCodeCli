// session-picker.ts — the interactive list a bare `cc --resume` opens.
//
// Runs on the launching terminal BEFORE the OpenTUI renderer mounts (the same
// window where extension trust confirms happen), so it needs no React: a few
// rows redrawn in place, raw-mode keys, and a clean erase when done. ↑/↓ (or
// j/k) move, Enter resumes the highlighted session, Esc/q cancels. The pure
// helpers (key parsing, row rendering, age formatting) are exported for tests;
// `pickSession` owns the tty side effects.

import type { SessionRow } from "./session.ts";

// CanaryCoders brand orange (see tui/theme.ts BRAND) as a raw ANSI truecolor
// sequence — this module renders before the TUI exists, so it can't use the
// TUI's color props.
const ORANGE = "\x1b[38;2;255;127;50m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export type PickerAction = "up" | "down" | "accept" | "cancel" | "none";

/** Map one raw stdin chunk onto a picker action. */
export function pickerActionForInput(bytes: string): PickerAction {
  if (bytes === "\x1b[A" || bytes === "\x1bOA" || bytes === "k") return "up";
  if (bytes === "\x1b[B" || bytes === "\x1bOB" || bytes === "j") return "down";
  if (bytes === "\r" || bytes === "\n") return "accept";
  // Bare Esc (no CSI tail), q, or Ctrl+C cancel.
  if (bytes === "\x1b" || bytes === "q" || bytes === "\x03") return "cancel";
  return "none";
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" for a session's updated_at. */
export function formatAge(updatedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Render the picker's lines (header + one row per session + hint), unpadded.
 * `sel` is the highlighted row; `color: false` keeps it plain for NO_COLOR. */
export function renderPickerLines(
  rows: SessionRow[],
  sel: number,
  width: number,
  color: boolean,
  now: number = Date.now(),
): string[] {
  const header = "Resume a session:";
  const hint = "↑/↓ move · Enter resume · Esc cancel";
  const lines = [color ? `${ORANGE}${header}${RESET}` : header];
  rows.forEach((s, i) => {
    const selected = i === sel;
    const marker = selected ? "❯ " : "  ";
    const meta = `${s.id.slice(0, 8)}  ${formatAge(s.updatedAt, now).padEnd(8)}  ${s.model}`;
    const title = s.title ?? "(untitled)";
    // Budget the title against the terminal width so a row never wraps (a
    // wrapped row would break the redraw-in-place cursor math).
    const room = Math.max(8, width - marker.length - meta.length - 2);
    const clipped =
      title.length > room ? `${title.slice(0, room - 1)}…` : title;
    const row = `${marker}${meta}  ${clipped}`;
    if (!color) {
      lines.push(row);
    } else if (selected) {
      lines.push(`${ORANGE}${row}${RESET}`);
    } else {
      lines.push(`${DIM}${row}${RESET}`);
    }
  });
  lines.push(color ? `${DIM}${hint}${RESET}` : hint);
  return lines;
}

/**
 * Show the picker and resolve with the chosen session, or null when cancelled.
 * Draws on stdout, reads raw keys from stdin, and erases itself before
 * resolving so the TUI (or the shell) gets a clean screen back.
 */
export function pickSession(rows: SessionRow[]): Promise<SessionRow | null> {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
  let sel = 0;
  let drawn = 0;

  const draw = () => {
    const lines = renderPickerLines(rows, sel, stdout.columns ?? 80, color);
    // Redraw in place: move back to the first picker line, then rewrite each
    // line clearing its old contents.
    if (drawn > 0) stdout.write(`\x1b[${drawn}A`);
    stdout.write(`${lines.map((l) => `\r\x1b[2K${l}`).join("\n")}\n`);
    drawn = lines.length;
  };
  const erase = () => {
    if (drawn === 0) return;
    stdout.write(`\x1b[${drawn}A\r\x1b[0J`);
    drawn = 0;
  };

  return new Promise((resolve) => {
    const finish = (result: SessionRow | null) => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(false);
        stdin.pause();
      } catch {}
      erase();
      stdout.write("\x1b[?25h"); // show cursor
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      switch (pickerActionForInput(chunk.toString())) {
        case "up":
          sel = (sel - 1 + rows.length) % rows.length;
          draw();
          break;
        case "down":
          sel = (sel + 1) % rows.length;
          draw();
          break;
        case "accept":
          finish(rows[sel] ?? null);
          break;
        case "cancel":
          finish(null);
          break;
        case "none":
          break;
      }
    };
    stdout.write("\x1b[?25l"); // hide cursor while the list redraws
    try {
      stdin.setRawMode?.(true);
    } catch {}
    stdin.resume();
    stdin.on("data", onData);
    draw();
  });
}
