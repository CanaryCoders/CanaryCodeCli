// tui/Icon.tsx — React helpers for semantic TUI icons.

import { createContext, useContext, useEffect, useState } from "react";
import type { Config } from "../config.ts";
import {
  iconFor as baseIconFor,
  type IconName,
  spinnerFrames,
} from "../icons.ts";
import { Text } from "./primitives.tsx";

function useNerdFont(config: Config | undefined): boolean {
  return config?.ui?.nerdFont === true;
}

const IconConfigContext = createContext<Config | undefined>(undefined);

export function IconProvider({
  config,
  children,
}: {
  config: Config;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <IconConfigContext.Provider value={config}>
      {children}
    </IconConfigContext.Provider>
  );
}

export function useIcon(name: IconName): string {
  return baseIconFor(name, useNerdFont(useContext(IconConfigContext)));
}

export function Icon({ name }: { name: IconName }): React.ReactElement {
  return <Text>{useIcon(name)}</Text>;
}

/**
 * The current frame of the animated "busy" spinner. While `active`, an interval
 * advances through the braille frames so the model-is-working indicator actually
 * spins; when idle it parks on the first frame and clears the timer. The interval
 * drives React state, which OpenTUI repaints each tick.
 */
export function useSpinnerFrame(active: boolean): string {
  const frames = spinnerFrames();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => setFrame((n) => (n + 1) % frames.length), 90);
    return () => clearInterval(id);
  }, [active, frames.length]);
  return frames[frame % frames.length] ?? frames[0]!;
}

export type { IconName };
