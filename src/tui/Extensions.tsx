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
import { ChoiceRow } from "./Interactive.tsx";
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

export interface ExtensionPickerState {
  cursor: number;
  checked: Set<string>;
}

export type ExtensionPickerAction =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "setCursor"; index: number }
  | { kind: "toggle"; index?: number };

export function initialExtensionPickerState(
  items: ExtensionToggle[],
): ExtensionPickerState {
  return {
    cursor: 0,
    checked: new Set(items.filter((i) => i.enabled).map((i) => i.name)),
  };
}

export function reduceExtensionPicker(
  state: ExtensionPickerState,
  items: ExtensionToggle[],
  action: ExtensionPickerAction,
): ExtensionPickerState {
  if (items.length === 0) return state;
  if (action.kind === "up") {
    return {
      ...state,
      cursor: (state.cursor - 1 + items.length) % items.length,
    };
  }
  if (action.kind === "down") {
    return { ...state, cursor: (state.cursor + 1) % items.length };
  }
  if (action.kind === "setCursor") {
    if (action.index < 0 || action.index >= items.length) return state;
    return { ...state, cursor: action.index };
  }

  const index = action.index ?? state.cursor;
  const name = items[index]?.name;
  if (!name) return state;
  const checked = new Set(state.checked);
  if (checked.has(name)) checked.delete(name);
  else checked.add(name);
  return { ...state, checked };
}

export function applyExtensionPickerState(
  items: ExtensionToggle[],
  state: ExtensionPickerState,
): ExtensionToggle[] {
  return items.map((i) => ({ ...i, enabled: state.checked.has(i.name) }));
}

export function ExtensionsView({
  items,
  onSubmit,
}: ExtensionsViewProps): React.ReactElement {
  // Pending checkbox states, seeded from the live config; nothing is applied
  // until Enter so a toggle spree costs one reassembly, not one per keypress.
  const [state, setState] = useState(() => initialExtensionPickerState(items));

  useTuiInput((input, key) => {
    if (key.upArrow)
      return setState((s) => reduceExtensionPicker(s, items, { kind: "up" }));
    if (key.downArrow)
      return setState((s) => reduceExtensionPicker(s, items, { kind: "down" }));
    if (input === " ")
      return setState((s) =>
        reduceExtensionPicker(s, items, { kind: "toggle" }),
      );
    if (key.return) {
      onSubmit(applyExtensionPickerState(items, state));
    }
  });

  const accent = tint(ACCENT);
  const promptIcon = useIcon("prompt");
  const selectedIcon = useIcon("choiceSelected");
  const emptyIcon = useIcon("choiceEmpty");
  const width = Math.max(0, ...items.map((i) => i.name.length));

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
        const isSel = i === state.cursor;
        const on = state.checked.has(item.name);
        const changedMark = on !== item.enabled ? "*" : " ";
        return (
          <ChoiceRow
            key={item.name}
            selected={isSel}
            onHover={() =>
              setState((s) =>
                reduceExtensionPicker(s, items, {
                  kind: "setCursor",
                  index: i,
                }),
              )
            }
            onAction={() =>
              setState((s) =>
                reduceExtensionPicker(s, items, { kind: "toggle", index: i }),
              )
            }
          >
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
          </ChoiceRow>
        );
      })}
      <Text dimColor>
        {"↑/↓ move · space toggle · enter apply · esc cancel"}
      </Text>
    </Box>
  );
}
