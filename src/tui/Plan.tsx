// tui/Plan.tsx — the plan-mode review box: render the agent's structured plan in a
// bordered box and prompt the user to accept / edit / reject it.
//
// Plan mode (agent.ts) runs read-only and emits ONE structured plan as assistant
// text. App.tsx captures that text when a plan-mode turn finishes and shows this
// box; the a/e/r keys are handled in App.tsx's `useInput` while the prompt
// `TextInput` is unmounted, so the keystrokes can't leak into the input line.

import { Box, Text } from "ink";
import type { AgentMode } from "../agent.ts";
import { modeColor, SPACING, tint } from "./theme.ts";

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

export function PlanView({
  plan,
  mode = "plan",
}: {
  plan: string;
  /** Active mode — tints the box border + accents (defaults to plan's cyan). */
  mode?: AgentMode;
}): React.ReactElement {
  // Mode-aware accent (plan=cyan), routed through `tint` so NO_COLOR keeps the
  // frame + glyphs but drops colour.
  const accent = tint(modeColor(mode));
  return (
    <Box flexDirection="column" marginTop={SPACING.inputGap}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={accent}
        paddingX={SPACING.boxPadX}
      >
        <Text color={accent} bold>
          {"📋 Proposed plan"}
        </Text>
        <Text>{plan.trim()}</Text>
      </Box>
      <Box marginTop={SPACING.inputGap}>
        <Text color={accent}>{"[a]"}</Text>
        <Text dimColor>{"ccept · "}</Text>
        <Text color={accent}>{"[e]"}</Text>
        <Text dimColor>{"dit · "}</Text>
        <Text color={accent}>{"[r]"}</Text>
        <Text dimColor>{"eject"}</Text>
      </Box>
    </Box>
  );
}
