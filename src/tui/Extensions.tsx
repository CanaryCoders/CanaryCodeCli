// tui/Extensions.tsx — the interactive `/extensions` checkbox picker.
//
// Bare `/extensions` renders this box in the input area (the prompt is
// unmounted, like the ask/confirm boxes): one row per toggleable extension with
// a checkbox reflecting its (pending) enabled state. ↑/↓ move, Space flips the
// checkbox, Enter applies every change at once — the host persists the toggles
// and reassembles the session a single time — and Esc (handled by App's global
// handler) closes without applying. Like AskUserView, this component owns its
// own keys via `useInput`; App's handler bows out while the picker is open.

import { useState } from "react";
import { useIcon } from "./Icon.tsx";
import { useTuiInput } from "./keyboard.ts";
import { Box, Text } from "./primitives.tsx";
import { SPACING, tint } from "./theme.ts";

const ACCENT = "magenta";

/** One toggleable extension row: identity plus its (pending) enabled state. */
export interface ExtensionToggle {
  name: string;
  description: string;
  enabled: boolean;
}

interface ExtensionsViewProps {
  /** The toggleable extensions with their current enabled state. */
  items: ExtensionToggle[];
  /** Enter — the full list with the user's pending states. */
  onSubmit: (next: ExtensionToggle[]) => void;
}

export function ExtensionsView({
  items,
  onSubmit,
}: ExtensionsViewProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  // Pending checkbox states, seeded from the live config; nothing is applied
  // until Enter so a toggle spree costs one reassembly, not one per keypress.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((i) => i.enabled).map((i) => i.name)),
  );

  useTuiInput((input, key) => {
    if (key.upArrow)
      return setCursor((c) => (c - 1 + items.length) % items.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % items.length);
    if (input === " ") {
      const name = items[cursor]!.name;
      return setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    }
    if (key.return) {
      onSubmit(items.map((i) => ({ ...i, enabled: checked.has(i.name) })));
    }
  });

  const accent = tint(ACCENT);
  const promptIcon = useIcon("prompt");
  const selectedIcon = useIcon("choiceSelected");
  const emptyIcon = useIcon("choiceEmpty");
  const width = Math.max(...items.map((i) => i.name.length));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={SPACING.boxPadX}
      marginTop={SPACING.inputGap}
    >
      <Text color={accent} bold>
        {"[extensions]"}
      </Text>
      {items.map((item, i) => {
        const isSel = i === cursor;
        const on = checked.has(item.name);
        const changedMark = on !== item.enabled ? "*" : " ";
        return (
          <Box key={item.name}>
            <Box width={1} marginRight={1}>
              <Text color={isSel ? accent : undefined}>
                {isSel ? promptIcon : " "}
              </Text>
            </Box>
            <Box width={1} marginRight={1}>
              <Text color={isSel ? accent : on ? tint("green") : undefined}>
                {on ? selectedIcon : emptyIcon}
              </Text>
            </Box>
            <Text color={isSel ? accent : undefined} bold={isSel}>
              {`${item.name.padEnd(width)}${changedMark}`}
            </Text>
            <Text dimColor>{` ${item.description}`}</Text>
          </Box>
        );
      })}
      <Text dimColor>
        {"↑/↓ move · space toggle · enter apply · esc cancel"}
      </Text>
    </Box>
  );
}
