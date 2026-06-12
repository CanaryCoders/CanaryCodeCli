// tui/Help.tsx — the keyboard & mouse reference overlay.
//
// A modal cheat-sheet opened from the footer `?` chip (or by pressing `?` on an
// empty prompt). It lists every action beside its KEYBOARD shortcut and its MOUSE
// equivalent, so the two input styles read side by side. The overlay renders ABOVE
// the input frame (sharing PromptArea's bottom chrome, like the paste preview) and
// owns its own scoped key handler: Esc (or `?`) closes it. The rows are pure data
// (`HELP_ROWS`) so the layout stays declarative and the set is easy to keep honest
// against the real bindings. Colours route through `tint` so NO_COLOR keeps the
// frame + columns but drops the colour.

import { ActionChip } from "./Interactive.tsx";
import { isRawEscapeInput } from "./input-helpers.ts";
import { useTuiInput } from "./keyboard.ts";
import { Box, Text } from "./primitives.tsx";
import { SPACING, tint } from "./theme.ts";

/** One reference row: an action and its keyboard / mouse equivalents. A `"—"`
 *  means "no equivalent in that input style". */
export interface HelpRow {
  action: string;
  keyboard: string;
  mouse: string;
}

// Kept accurate to THIS app's bindings (see App.tsx's useTuiInput + the mouse
// handlers in Interactive/Message/Footer). A dash means "no equivalent".
export const HELP_ROWS: readonly HelpRow[] = [
  { action: "Send / newline", keyboard: "Enter / Shift+Enter", mouse: "—" },
  { action: "Cancel / quit", keyboard: "Esc / Ctrl+C", mouse: "—" },
  { action: "Cycle mode", keyboard: "Shift+Tab", mouse: "click mode pill" },
  { action: "Expand all tools", keyboard: "Ctrl+R", mouse: "—" },
  {
    action: "Expand one tool",
    keyboard: "nav Enter / Space",
    mouse: "click tool card",
  },
  {
    action: "Scroll",
    keyboard: "PageUp/Dn, Home/End",
    mouse: "wheel / jump banner",
  },
  {
    action: "Transcript nav",
    keyboard: "Ctrl+↑ / Ctrl+K or /copy; j/k g/G i/esc",
    mouse: "—",
  },
  {
    action: "Copy focused",
    keyboard: "y item · Y group · c/o cmd/out",
    mouse: "hover card → [copy]",
  },
  { action: "Copy last answer", keyboard: "/copy-last", mouse: "—" },
  { action: "Select text", keyboard: "—", mouse: "drag-select (auto-copies)" },
  {
    action: "Paste preview",
    keyboard: "Ctrl+P (cursor on chip) · y copy · esc close",
    mouse: "click chip",
  },
  {
    action: "Autocomplete",
    keyboard: "↑/↓ or Ctrl+P/N · Tab/Enter",
    mouse: "click row",
  },
  { action: "Help", keyboard: "?", mouse: "click footer ?" },
  { action: "Confirm", keyboard: "y / n / a", mouse: "click chips" },
  { action: "Plan review", keyboard: "a / e / r", mouse: "click chips" },
  { action: "Toggle verbose", keyboard: "Ctrl+R", mouse: "click verbose chip" },
] as const;

// Match the prompt frame's left inset (border + boxPadX) so the overlay lines up
// under the prompt content rather than floating flush-left — same as PastePreview.
const FRAME_INSET = 1 + SPACING.boxPadX;
const ACCENT = "#89a8d8";
const FILL = "#1f2733";

interface HelpOverlayProps {
  onClose: () => void;
  /** Terminal width — clamps the box so no row wraps past the right edge. */
  columns: number;
}

/** The bordered keyboard/mouse reference card. Mounted only while help is open;
 *  its scoped key handler closes on Esc or `?`. */
export function HelpOverlay({
  onClose,
  columns,
}: HelpOverlayProps): React.ReactElement {
  // Scoped key handling — active only while this overlay is mounted. Esc (or a raw
  // Esc burst) or `?` closes. The App's global handler checks the help-open ref and
  // bows out without escalating, so Esc only closes here (never quits).
  useTuiInput((input, key) => {
    if (key.escape || isRawEscapeInput(input) || input === "?") onClose();
  });

  // Clamp the box to the terminal so the widest row can't push the border past the
  // edge. The inner three columns are fixed-width and truncate rather than wrap.
  const maxBoxWidth = Math.max(40, columns - FRAME_INSET - 2);
  const innerWidth = maxBoxWidth - 2 * SPACING.boxPadX;
  // Action | Keyboard | Mouse — give the action + mouse fixed shares and let the
  // keyboard column take the slack, then clamp each so nothing wraps.
  const actionW = Math.min(18, Math.max(12, Math.floor(innerWidth * 0.28)));
  const mouseW = Math.min(24, Math.max(12, Math.floor(innerWidth * 0.3)));
  const keyW = Math.max(8, innerWidth - actionW - mouseW - 2);

  return (
    <Box flexDirection="column" paddingLeft={FRAME_INSET} marginBottom={0}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tint(ACCENT)}
        backgroundColor={tint(FILL)}
        paddingX={SPACING.boxPadX}
        width={maxBoxWidth}
        title="Keyboard & mouse"
        titleColor={tint(ACCENT)}
      >
        <Box flexDirection="row">
          <Box width={actionW} flexShrink={0}>
            <Text bold>Action</Text>
          </Box>
          <Box width={keyW} flexShrink={0}>
            <Text bold>Keyboard</Text>
          </Box>
          <Box width={mouseW} flexShrink={0}>
            <Text bold>Mouse</Text>
          </Box>
        </Box>
        {HELP_ROWS.map((row) => (
          <Box key={row.action} flexDirection="row">
            <Box width={actionW} flexShrink={0}>
              <Text wrap="truncate">{row.action}</Text>
            </Box>
            <Box width={keyW} flexShrink={0}>
              <Text wrap="truncate" dimColor>
                {row.keyboard}
              </Text>
            </Box>
            <Box width={mouseW} flexShrink={0}>
              <Text wrap="truncate" color={tint("cyan")}>
                {row.mouse}
              </Text>
            </Box>
          </Box>
        ))}
        <Box flexDirection="row" marginTop={1}>
          <ActionChip label="[close]" onAction={onClose} />
          <Text dimColor>{"   esc or ? to close"}</Text>
        </Box>
      </Box>
    </Box>
  );
}
