/** @jsxImportSource @opentui/react */
// tui/opentui-smoke.tsx — isolated OpenTUI renderer spike for the port.
//
// This file is intentionally not wired into src/index.ts yet. It verifies that
// Bun can create an OpenTUI renderer, render a simple tree, read dimensions,
// handle keyboard input, and shut down cleanly while the production Ink TUI keeps
// serving interactive mode.

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { useMemo } from "react";

function SmokeApp(props: { onExit: () => void }): ReactNode {
  const dimensions = useTerminalDimensions();
  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) props.onExit();
  });

  const sizeLabel = useMemo(
    () => `${dimensions.width}×${dimensions.height}`,
    [dimensions.width, dimensions.height],
  );

  return (
    <box flexDirection="column" borderStyle="rounded" padding={1}>
      <text fg="cyan">cc OpenTUI smoke</text>
      <text>terminal: {sizeLabel}</text>
      <text fg="gray">Esc or Ctrl+C exits</text>
    </box>
  );
}

export async function startOpenTuiSmoke(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const cleanup = () => {
    root.unmount();
    renderer.destroy();
  };

  root.render(<SmokeApp onExit={cleanup} />);
}

if (import.meta.main) {
  await startOpenTuiSmoke();
}
