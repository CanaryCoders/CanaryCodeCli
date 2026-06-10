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
import { Markdown } from "./Message.tsx";
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
          {/* width=2 leaves room for Nerd Font glyphs that terminals render as
              two cells (otherwise the glyph eats the following space and sticks
              to the heading); flexShrink=0 keeps the fixed cell from going
              fractional beside flexible text (see Message.tsx RuleRow). */}
          <Box width={2} flexShrink={0}>
            <Text color={accent} bold>
              {planIcon}
            </Text>
          </Box>
          <Box marginLeft={1}>
            <Text color={accent} bold>
              Proposed plan
            </Text>
          </Box>
        </Box>
        {/* The plan arrives as markdown (headings, bold, lists) — render it,
            don't print the raw markers. */}
        <Markdown text={plan.trim()} />
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
