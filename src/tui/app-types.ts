// tui/app-types.ts — shared prop types for the TUI shell.
//
// `AppProps` lives here (rather than in App.tsx) so both the App component and the
// hooks it composes — notably use-agent-session.ts — can import it without a
// circular dependency.

import type { AgentMode } from "../agent.ts";
import type { AgentDef } from "../agents.ts";
import type { Config } from "../config.ts";
import type { Skill } from "../extensions/skills.ts";
import type { McpConnection } from "../mcp.ts";
import type { Message, Provider } from "../provider.ts";
import type { SessionStore } from "../session.ts";
import type { ThinkingLevel } from "../thinking.ts";

export interface AppProps {
  config: Config;
  /** Initial provider + model, already resolved by the launcher. */
  provider: Provider;
  modelName: string;
  modelLabel: string;
  /** App version, shown in the launch banner. */
  version: string;
  /** Base system prompt (project context + skills already folded in). */
  baseSystem: string;
  skills: Skill[];
  /** Custom agent definitions spawn_agent can dispatch to by name. */
  agents: AgentDef[];
  mcp: McpConnection;
  store: SessionStore;
  sessionId: string;
  /** Whether tools are disabled entirely (--no-tools). */
  noTools: boolean;
  /** Resumed initial state (model/think/mode restored from a prior session). */
  initialMode?: AgentMode;
  initialThinking?: ThinkingLevel;
  /** Prior transcript to seed the conversation when resuming a session. */
  resumedMessages?: Message[];
  /** Startup notes (context/skills/mcp) to show in the scrollback. */
  startupNotes: string[];
  /** Ink render instance (populated after render); used to clear the screen. */
  inkInstance?: { current: { clear: () => void } | null };
}
