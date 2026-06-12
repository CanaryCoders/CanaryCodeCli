// tui/runtime.tsx — renderer-neutral host operations for the interactive UI.
//
// The session controller needs a tiny surface for host actions (clear, exit, and
// terminal dimensions) without knowing whether the current renderer is Ink or
// OpenTUI. Keep this boundary intentionally small while the OpenTUI port is in
// progress.

import { createContext, useContext } from "react";

export interface TuiRuntime {
  clear(): void;
  exit(): void;
  columns(): number;
  rows(): number;
}

const fallbackRuntime: TuiRuntime = {
  clear: () => {},
  exit: () => {},
  columns: () => process.stdout.columns ?? 80,
  rows: () => process.stdout.rows ?? 24,
};

export const TuiRuntimeContext = createContext<TuiRuntime>(fallbackRuntime);

export function useTuiRuntime(): TuiRuntime {
  return useContext(TuiRuntimeContext);
}
