// Extensions.test.tsx — renderer-independent tests for the `/extensions` picker
// state reducer. The OpenTUI migration keeps the selection behavior pure so the
// remaining assertions do not depend on Ink's React 18 renderer.

import { expect, test } from "bun:test";
import type { ExtensionToggle } from "./Extensions.tsx";
import {
  applyExtensionPickerState,
  initialExtensionPickerState,
  reduceExtensionPicker,
} from "./Extensions.tsx";

test("picker state moves, toggles, and applies the batch", () => {
  const items: ExtensionToggle[] = [
    { name: "codex", description: "ChatGPT models", enabled: true },
    { name: "opencode", description: "Zen models", enabled: false },
  ];

  let state = initialExtensionPickerState(items);
  expect(state.cursor).toBe(0);
  expect([...state.checked]).toEqual(["codex"]);

  // Space on the first row (codex) flips it off…
  state = reduceExtensionPicker(state, items, { kind: "toggle" });
  // …↓ to opencode, space flips it on…
  state = reduceExtensionPicker(state, items, { kind: "down" });
  state = reduceExtensionPicker(state, items, { kind: "toggle" });

  const byName = Object.fromEntries(
    applyExtensionPickerState(items, state).map((e) => [e.name, e.enabled]),
  );
  expect(byName).toEqual({ codex: false, opencode: true });
});

test("picker state wraps vertically", () => {
  const items: ExtensionToggle[] = [
    { name: "a", description: "A", enabled: false },
    { name: "b", description: "B", enabled: false },
  ];

  let state = initialExtensionPickerState(items);
  state = reduceExtensionPicker(state, items, { kind: "up" });
  expect(state.cursor).toBe(1);
  state = reduceExtensionPicker(state, items, { kind: "down" });
  expect(state.cursor).toBe(0);
});
