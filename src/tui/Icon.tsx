// tui/Icon.tsx — React helpers for semantic TUI icons.

import { createContext, useContext } from "react";
import type { Config } from "../config.ts";
import { iconFor as baseIconFor, type IconName } from "../icons.ts";
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

export type { IconName };
