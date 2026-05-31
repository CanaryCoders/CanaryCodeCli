// verbs.ts — the status verbs shown beside the busy spinner.
//
// While a turn is in flight the spinner pairs with a short present-tense verb
// describing what's happening *right now*. There are two kinds:
//
//   • Contextual tool verbs — when a tool is running, the verb names the tool
//     ("running bash…", "searching…"). These always win; they're literal.
//   • Mood pools — when the model is just thinking or streaming a reply, the verb
//     is drawn from a pool (a mix of plain and whimsical synonyms) and rotates per
//     step, so a long session feels alive without flickering mid-render.
//
// Rotation is seeded by a stable per-step number (the live item's id), so the verb
// holds steady for the duration of one step and changes on the next — never on
// every spinner frame.

/** Tool → present-tense contextual verb shown while that tool runs. */
export const TOOL_VERB: Record<string, string> = {
  bash: "running bash",
  web_search: "searching the web",
  grep: "grepping",
  read_file: "reading",
  list_dir: "listing",
  read_skill: "consulting a skill",
  write_file: "writing",
  edit_file: "editing",
  spawn_agent: "summoning a sub-agent",
};

/**
 * Verbs for "the model is reasoning between tools". A deliberate mix of plain
 * ("thinking", "reasoning") and whimsical ("noodling", "percolating") synonyms.
 */
export const THINKING_VERBS: string[] = [
  "thinking",
  "pondering",
  "reasoning",
  "cogitating",
  "mulling it over",
  "ruminating",
  "noodling",
  "deliberating",
  "contemplating",
  "percolating",
  "untangling",
  "chewing on it",
  "puzzling",
  "scheming",
  "conjuring",
  "musing",
  "wrangling",
  "synthesizing",
];

/** Verbs for "the model is streaming its reply". */
export const RESPONDING_VERBS: string[] = [
  "responding",
  "composing",
  "drafting",
  "writing",
  "articulating",
  "penning",
];

/** Pick a verb from `pool`, rotated by a stable `seed` (no flicker mid-render). */
export function pickVerb(pool: string[], seed: number): string {
  const i = ((seed % pool.length) + pool.length) % pool.length;
  return pool[i] as string;
}
