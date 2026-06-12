// icons.ts — semantic icon names resolved to ASCII-safe or nerd-font glyphs.
//
// Keep icon selection out of rendering code: callers ask for a meaning
// ("toolOk", "prompt", "plan") and pass whether nerd-font glyphs are enabled.
// Defaults are plain ASCII so every terminal renders usable output.

export type IconName =
  | "assistant"
  | "thinking"
  | "tool"
  | "note"
  | "error"
  | "prompt"
  | "queued"
  | "checkpoint"
  | "warning"
  | "plan"
  | "verbose"
  | "choiceSelected"
  | "choiceEmpty"
  | "writeCustom"
  | "taskPending"
  | "taskProgress"
  | "taskDone"
  | "toolPending"
  | "toolOk"
  | "toolError"
  | "rule";

type IconSet = Record<IconName, string>;

const ASCII_ICONS: IconSet = {
  assistant: "o",
  thinking: "*",
  tool: ">",
  note: "i",
  error: "x",
  prompt: ">",
  queued: ">",
  checkpoint: "||",
  warning: "!",
  plan: "=",
  verbose: ">",
  choiceSelected: "(*)",
  choiceEmpty: "( )",
  writeCustom: "edit",
  taskPending: "[ ]",
  taskProgress: "[*]",
  taskDone: "[x]",
  toolPending: "...",
  toolOk: "ok",
  toolError: "x",
  rule: "|",
};

const NERD_FONT_ICONS: IconSet = {
  assistant: "󰚩",
  thinking: "󰌵",
  tool: "󰒓",
  note: "󰋼",
  error: "󰅚",
  prompt: "❯",
  queued: "󰜎",
  checkpoint: "󰙧",
  warning: "",
  plan: "󰧮",
  verbose: "󰞷",
  choiceSelected: "",
  choiceEmpty: "",
  writeCustom: "",
  taskPending: "",
  taskProgress: "󰦖",
  taskDone: "",
  toolPending: "…",
  toolOk: "",
  toolError: "",
  rule: "│",
};

export function iconFor(name: IconName, nerdFont = false): string {
  return (nerdFont ? NERD_FONT_ICONS : ASCII_ICONS)[name];
}

// Animated "busy" spinner frames, cycled by `useSpinnerFrame`. Braille dots —
// standard Unicode that virtually every modern terminal renders — give the
// smoothest motion, so they're used regardless of the nerd-font setting.
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export function spinnerFrames(): readonly string[] {
  return SPINNER_FRAMES;
}
