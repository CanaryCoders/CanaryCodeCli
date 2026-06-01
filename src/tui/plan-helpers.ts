// tui/plan-helpers.ts — non-component helpers for Plan.tsx.
//
// Split out of Plan.tsx so that module exports only React components, keeping
// the fast-refresh boundary intact (react-doctor/only-export-components).

/** The accept/edit/reject choices, surfaced so App.tsx and tests share one source. */
export type PlanChoice = "accept" | "edit" | "reject";

/** Map a pressed key to a plan choice (lowercased), or null if it isn't one. */
export function planChoiceForKey(input: string): PlanChoice | null {
  switch (input.toLowerCase()) {
    case "a":
      return "accept";
    case "e":
      return "edit";
    case "r":
      return "reject";
    default:
      return null;
  }
}
