// tui/Footer.tsx — the bottom status bar: a mode pill, model, thinking, tokens,
// cost, and a verbose indicator, above a subtle separator rule.
//
// The mode renders as a coloured pill (background-tinted, black text), the live
// token count sits beside the running cost, and a `⏵ verbose` indicator shows
// when expanded tool output is on. The width comes from the terminal (never a
// hard-coded 80); on a narrow terminal the lowest-value segments
// (model → thinking → tokens → verbose) drop out one at a time so the bar never
// overflows. Colours pass through `tint` so `NO_COLOR` keeps the pill's spacing
// + the rule but drops the colour.

import { useRef, useState } from "react";
import type { AgentMode } from "../agent.ts";
import { useIcon } from "./Icon.tsx";
import { ActionChip } from "./Interactive.tsx";
import { Box, Text, useTerminalColumns } from "./primitives.tsx";
import { tint } from "./theme.ts";

export interface FooterProps {
  modelLabel: string;
  mode: AgentMode;
  /** Accent colour for the mode pill (from theme.modeColor). */
  modeColor: string;
  /** Pre-formatted thinking label (e.g. "no-think", "ultrathink"). */
  thinkLabel: string;
  cost: number;
  /** Whether pricing is known for the active model. */
  costKnown: boolean;
  /** Total tokens (input + output) for the running session. */
  tokens: number;
  verbose: boolean;
  /** Override terminal width (tests); defaults to the measured stdout columns. */
  columns?: number;
  /** Click the mode pill → cycle the mode (same as Shift+Tab). */
  onCycleMode?: () => void;
  /** Click the verbose chip → toggle verbose (same as Ctrl+R). */
  onToggleVerbose?: () => void;
  /** Click the `?` chip → open the keyboard/mouse help overlay. */
  onOpenHelp?: () => void;
}

/** Compact a token count: 1234 → "1.2k", 980 → "980". */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The mode pill — a coloured ` mode ` block. Clickable: a left-click cycles the
 *  mode (exactly like Shift+Tab); hover/press brighten it so the affordance reads.
 *  Keyboard stays caller-owned; this only translates the click. */
function ModePill({
  mode,
  modeColor,
  onCycle,
}: {
  mode: AgentMode;
  modeColor: string;
  onCycle?: () => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);
  const interactive = onCycle !== undefined;
  const setPressedState = (next: boolean): void => {
    pressedRef.current = next;
    setPressed(next);
  };
  return (
    <Text
      backgroundColor={tint(modeColor)}
      color={tint("black")}
      bold
      inverse={interactive && pressed}
      underline={interactive && hovered && !pressed}
      cursor={interactive ? "pointer" : "default"}
      onMouseOver={() => {
        if (interactive) setHovered(true);
      }}
      onMouseOut={() => {
        setHovered(false);
        setPressedState(false);
      }}
      onMouseDown={(event) => {
        if (!interactive || event.button !== 0) return;
        setPressedState(true);
        event.stopPropagation();
      }}
      onMouseUp={(event) => {
        if (!interactive || event.button !== 0) return;
        const wasPressed = pressedRef.current;
        setPressedState(false);
        event.stopPropagation();
        if (wasPressed) onCycle?.();
      }}
    >
      {` ${mode} `}
    </Text>
  );
}

export interface Seg {
  key: string;
  /** Plain-text width used for the fit calculation. */
  width: number;
  /** Drop order: higher drops first; 0 never drops (the mode pill). */
  prio: number;
  node: React.ReactNode;
}

const SEP = " · ";

/** Total rendered width of a segment list (segments joined by `SEP`). */
function rowWidth(segs: Seg[]): number {
  if (segs.length === 0) return 0;
  return (
    segs.reduce((sum, s) => sum + s.width, 0) + (segs.length - 1) * SEP.length
  );
}

/**
 * Choose which segments fit in `cols`, dropping the highest-`prio` ones first
 * (never `prio` 0 — the mode pill). Returns the survivors in their original
 * render order.
 */
function fitSegments(segs: Seg[], cols: number): Seg[] {
  const dropped = new Set<string>();
  const droppable = segs
    .filter((s) => s.prio > 0)
    .sort((a, b) => b.prio - a.prio);
  for (const cand of droppable) {
    if (rowWidth(segs.filter((s) => !dropped.has(s.key))) <= cols) break;
    dropped.add(cand.key);
  }
  return segs.filter((s) => !dropped.has(s.key));
}

export function Footer(props: FooterProps): React.ReactElement {
  const measuredColumns = useTerminalColumns();
  const cols = props.columns ?? measuredColumns;

  const tokText = `${formatTokens(props.tokens)} tok`;
  const costText = props.costKnown ? `$${props.cost.toFixed(4)}` : null;
  const verboseIcon = useIcon("verbose");
  const verboseText = "verbose";
  const verboseLabel = `${verboseIcon} ${verboseText}`;
  // No nerd-font glyph for "help"; the plain `?` reads everywhere.
  const helpLabel = "?";

  const segs: Seg[] = [
    {
      key: "mode",
      width: props.mode.length + 2,
      prio: 0,
      node: (
        <ModePill
          mode={props.mode}
          modeColor={props.modeColor}
          onCycle={props.onCycleMode}
        />
      ),
    },
    {
      key: "model",
      width: props.modelLabel.length,
      prio: 5,
      node: <Text dimColor>{props.modelLabel}</Text>,
    },
    {
      key: "think",
      width: props.thinkLabel.length,
      prio: 4,
      node: <Text dimColor>{props.thinkLabel}</Text>,
    },
    {
      key: "tokens",
      width: tokText.length,
      prio: 3,
      node: <Text dimColor>{tokText}</Text>,
    },
  ];
  if (costText) {
    segs.push({
      key: "cost",
      width: costText.length,
      prio: 1,
      node: <Text dimColor>{costText}</Text>,
    });
  }
  if (props.verbose) {
    // Clickable: a click turns verbose off (matches Ctrl+R). The icon+label ride
    // in one chip so the whole thing is the hit target.
    segs.push({
      key: "verbose",
      width: verboseLabel.length,
      prio: 2,
      node:
        props.onToggleVerbose !== undefined ? (
          <ActionChip
            label={verboseLabel}
            color="cyan"
            onAction={props.onToggleVerbose}
          />
        ) : (
          <Text color={tint("cyan")}>{verboseLabel}</Text>
        ),
    });
  }
  // The `?` help chip drops after model/think/tokens but before cost + the mode
  // pill, so it survives on all but the narrowest terminals.
  segs.push({
    key: "help",
    width: helpLabel.length,
    prio: 2,
    node:
      props.onOpenHelp !== undefined ? (
        <ActionChip
          label={helpLabel}
          color="cyan"
          onAction={props.onOpenHelp}
        />
      ) : (
        <Text dimColor>{helpLabel}</Text>
      ),
  });

  const kept = fitSegments(segs, cols);
  const rule = "─".repeat(Math.max(0, cols));

  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Box>
        {kept.map((s, i) => (
          <Box key={s.key}>
            {i > 0 ? <Text dimColor>{SEP}</Text> : null}
            {s.node}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
