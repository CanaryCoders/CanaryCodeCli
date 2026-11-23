// model-list.ts — the `/model` listing.

import { type Config, providerDisplayName } from "../config.ts";

/** "32k" / "1M" for a context window in tokens. */
function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.floor(tokens / 1000)}k`;
}

/** Wrap comma-separated entries under a label, indenting continuation lines. */
function wrapEntries(label: string, entries: string[], width: number): string {
  const indent = " ".repeat(label.length);
  const lines: string[] = [];
  let line = label;
  for (const [i, entry] of entries.entries()) {
    const piece = i < entries.length - 1 ? `${entry}, ` : entry;
    if (line.length + piece.trimEnd().length > width && line !== label) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += piece;
  }
  lines.push(line.trimEnd());
  return lines.join("\n");
}

/**
 * Every configured model, one block per source, wrapped to `columns` so a
 * gateway with dozens of models stays readable. Gateway ids of the form
 * `upstream/model` are grouped by upstream, and a known context window is
 * shown beside the id since it decides how much a model can hold.
 */
export function formatModelList(config: Config, columns: number): string {
  const width = Math.max(40, columns - 6);
  const blocks: string[] = [];
  for (const [key, pc] of Object.entries(config.providers)) {
    const models = pc.models ?? [];
    if (models.length === 0) continue;
    const groups = new Map<string, string[]>();
    for (const m of models) {
      const slash = m.id.indexOf("/");
      const group = slash > 0 ? m.id.slice(0, slash) : "";
      let entry = m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id;
      if (m.contextWindow) entry += ` [${windowLabel(m.contextWindow)}]`;
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    }
    const name = providerDisplayName(key);
    if (groups.size === 1) {
      blocks.push(wrapEntries(`  ${name}: `, [...groups.values()][0]!, width));
      continue;
    }
    blocks.push(`  ${name}:`);
    for (const entries of groups.values())
      blocks.push(wrapEntries("    ", entries, width));
  }
  return blocks.join("\n");
}
