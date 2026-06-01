// tui/Plan.tsx — the plan-mode review box: render the agent's structured plan in a
// bordered box and prompt the user to accept / edit / reject it.
//
// Plan mode (agent.ts) runs read-only and emits ONE structured plan as assistant
// text. App.tsx captures that text when a plan-mode turn finishes and shows this
// box; the a/e/r keys are handled in App.tsx's `useInput` while the prompt
// `TextInput` is unmounted, so the keystrokes can't leak into the input line.

import { Box, Text } from "ink";
import type { AgentMode } from "../agent.ts";
import { useIcon } from "./Icon.tsx";
import { modeColor, SPACING, tint } from "./theme.ts";

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
  const planIcon = useIcon("plan");
  return (
    <Box flexDirection="column" marginTop={SPACING.inputGap}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={accent}
        paddingX={SPACING.boxPadX}
      >
        <Box>
          <Text color={accent} bold>
            {planIcon}
          </Text>
          <Box marginLeft={1}>
            <Text color={accent} bold>
              Proposed plan
            </Text>
          </Box>
        </Box>
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
