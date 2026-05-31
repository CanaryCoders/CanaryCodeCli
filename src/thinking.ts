// thinking.ts — extended-thinking levels, token budgets, and parsing.
//
// Maps a small set of named levels to Anthropic extended-thinking `budget_tokens`:
//
//   off (default) | think 4k | think hard 10k | ultrathink 32k
//
// A level can come from `--think <level>` / `/think <level>` (explicit) or from a
// keyword in the prompt itself ("think hard", "ultrathink"). Explicit wins. The
// budget is handed to the provider as `thinkingBudget`; providers that don't
// support thinking (openai-compat) drop it — `supportsThinking` lets the caller
// note that once instead of silently ignoring the request.

export type ThinkingLevel = "off" | "think" | "think-hard" | "ultrathink";

/** Token budget for each level. 0 means thinking disabled. */
const BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  think: 4_000,
  "think-hard": 10_000,
  ultrathink: 32_000,
};

/** Budget in tokens for a level (0 = disabled). */
export function budgetFor(level: ThinkingLevel): number {
  return BUDGETS[level];
}

/**
 * Parse an explicit level string (from `--think`/`/think`). Accepts the canonical
 * names plus common aliases. Returns `undefined` for an unrecognized value so the
 * caller can fall back to keyword detection or report a bad flag.
 */
export function parseLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (raw == null) return undefined;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  switch (s) {
    case "":
    case "off":
    case "none":
    case "no":
    case "0":
      return "off";
    case "think":
    case "on":
    case "low":
    case "1":
      return "think";
    case "think-hard":
    case "think-harder":
    case "hard":
    case "harder":
    case "high":
    case "megathink":
    case "2":
      return "think-hard";
    case "ultrathink":
    case "ultra":
    case "max":
    case "3":
      return "ultrathink";
    default:
      return undefined;
  }
}

/**
 * Detect a thinking keyword inside the prompt text, returning the strongest level
 * present (ultrathink > think hard > think). Returns "off" when none is found.
 * Matching is word-boundaried so ordinary words like "thinking" don't trigger it.
 */
export function levelFromKeywords(prompt: string): ThinkingLevel {
  const t = prompt.toLowerCase();
  if (/\bultrathink\b/.test(t) || /\bultra[-\s]?think\b/.test(t))
    return "ultrathink";
  if (
    /\bmegathink\b/.test(t) ||
    /\bthink\s+(hard(er)?|deeply|really\s+hard)\b/.test(t)
  ) {
    return "think-hard";
  }
  if (/\bthink\b/.test(t)) return "think";
  return "off";
}

export interface ThinkingResolution {
  level: ThinkingLevel;
  budget: number;
  /** Where the level was decided: explicit flag, prompt keyword, or the default. */
  source: "flag" | "keyword" | "default";
}

/**
 * Resolve the effective thinking level. An explicit flag/command value wins; a bad
 * flag value is ignored (treated as absent). Otherwise a prompt keyword is used.
 * Falls back to "off".
 */
export function resolveThinking(opts: {
  flag?: string;
  prompt?: string;
}): ThinkingResolution {
  const fromFlag = parseLevel(opts.flag);
  if (fromFlag !== undefined) {
    return { level: fromFlag, budget: budgetFor(fromFlag), source: "flag" };
  }
  if (opts.prompt) {
    const kw = levelFromKeywords(opts.prompt);
    if (kw !== "off")
      return { level: kw, budget: budgetFor(kw), source: "keyword" };
  }
  return { level: "off", budget: 0, source: "default" };
}

/**
 * Whether a provider can act on a thinking budget. Only the Anthropic Messages API
 * exposes extended thinking; openai-compat gateways have no portable equivalent,
 * so the budget is dropped (the caller should note this once).
 */
export function supportsThinking(providerId: string): boolean {
  return providerId === "anthropic";
}

/** Human-readable label, e.g. "think hard (10k)". For status lines / notes. */
export function describeLevel(level: ThinkingLevel): string {
  const budget = budgetFor(level);
  const name = level.replace(/-/g, " ");
  return budget > 0 ? `${name} (${Math.round(budget / 1000)}k)` : name;
}
