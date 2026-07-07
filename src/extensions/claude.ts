// claude.ts — Claude Code subscription-backed models via the official
// @anthropic-ai/claude-agent-sdk package.
//
// This preset intentionally carries no Anthropic API key. Authentication is owned
// by Claude Code itself (run `claude login`), so users with Claude Code Pro/Max or
// org entitlements can use the same native subscription path from canarycode.

import type { ProviderConfig } from "../config.ts";
import type { Extension } from "../extension.ts";

/** The provider key used for the baked-in Claude Code preset. */
export const CLAUDE_CODE_PROVIDER = "claude";

export function claudeCodeProviderConfig(): ProviderConfig {
  return {
    api: "claude-code",
    models: [
      { id: "fable", name: "fable" },
      { id: "opus", name: "opus" },
      { id: "sonnet", name: "sonnet" },
      { id: "haiku", name: "haiku" },
    ],
  };
}

export const claudeCodeExtension: Extension = {
  name: "claude-code",
  description: "Anthropic models via your Claude Code subscription",
  providerPresets: () => ({
    [CLAUDE_CODE_PROVIDER]: claudeCodeProviderConfig(),
  }),
};
