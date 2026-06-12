// tui/Footer.tsx — the bottom status bar: a mode pill, model, thinking, tokens,
// cost, and a verbose indicator, above a subtle separator rule.
//
// Phase 4.8 promotes the old `model · mode · thinking · $cost` text line to a
// proper footer bar: the mode renders as a coloured **pill** (background-tinted,
// black text), the live **token count** sits beside the running **cost**, a
// `⏵ verbose` indicator shows when expanded tool output is on, and a faint
// full-width **separator rule** divides it from the scrollback. The width comes
// from `useStdout` (never a hard-coded 80); on a narrow terminal the lowest-value
// segments (model → thinking → tokens → verbose) drop out one at a time so the bar
// never overflows. Colours pass through `tint` so `NO_COLOR` keeps the pill's
// spacing + the rule but drops the colour.

import type { AgentMode } from "../agent.ts";
import { useIcon } from "./Icon.tsx";
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
}

/** Compact a token count: 1234 → "1.2k", 980 → "980". */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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

  const segs: Seg[] = [
    {
      key: "mode",
      width: props.mode.length + 2,
      prio: 0,
      node: (
        <Text
          backgroundColor={tint(props.modeColor)}
          color={tint("black")}
          bold
        >
          {` ${props.mode} `}
        </Text>
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
    segs.push({
      key: "verbose",
      width: verboseIcon.length + 1 + verboseText.length,
      prio: 2,
      node: (
        <Box>
          <Text color={tint("cyan")}>{verboseIcon}</Text>
          <Box marginLeft={1}>
            <Text color={tint("cyan")}>{verboseText}</Text>
          </Box>
        </Box>
      ),
    });
  }

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
