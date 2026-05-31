// websearch.ts — the `web_search` tool and its pluggable HTTP backends.
//
// A single `searchWeb(query, cfg)` fans out to one of a few search APIs selected
// by `config.webSearch.provider` ("brave" | "tavily"), returning a normalized
// `{ title, url, snippet }[]`. `webSearchTool(cfg)` wraps it as a read-only Tool
// (safe in plan mode). The tool is built from config at startup and appended to
// the registry by the caller, so tools.ts stays config-free.

import type { WebSearchConfig } from "./config.ts";
import type { Tool } from "./tools.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  /** Max results to return (clamped 1..10). Default 5. */
  count?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

function clampCount(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, Math.trunc(n)));
}

/**
 * Run a web search via the configured backend. Throws a clear, model-readable
 * error when web search is unconfigured or the backend is unknown/fails.
 */
async function searchWeb(
  query: string,
  cfg: WebSearchConfig,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const provider = (cfg.provider ?? "").toLowerCase();
  if (!provider) {
    throw new Error(
      'web search is not configured; set webSearch.provider ("brave" | "tavily") and webSearch.apiKey in ~/.cc/config.json',
    );
  }
  const count = clampCount(opts.count);
  const fetchImpl = opts.fetchImpl ?? fetch;
  switch (provider) {
    case "brave":
      return braveSearch(query, cfg, count, fetchImpl, opts.signal);
    case "tavily":
      return tavilySearch(query, cfg, count, fetchImpl, opts.signal);
    default:
      throw new Error(
        `unknown webSearch.provider "${cfg.provider}" (supported: brave, tavily)`,
      );
  }
}

// ── Brave Search API ────────────────────────────────────────────────────────
// GET https://api.search.brave.com/res/v1/web/search?q=…&count=N
// Auth header: X-Subscription-Token. Results under web.results[].

async function braveSearch(
  query: string,
  cfg: WebSearchConfig,
  count: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!cfg.apiKey)
    throw new Error("brave web search requires webSearch.apiKey");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const res = await fetchImpl(url.toString(), {
    headers: { Accept: "application/json", "X-Subscription-Token": cfg.apiKey },
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `brave search failed: ${res.status} ${res.statusText} ${await res.text()}`.trim(),
    );
  }
  const data = (await res.json()) as { web?: { results?: BraveResult[] } };
  const results = data.web?.results ?? [];
  return results.slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: stripTags(r.description ?? ""),
  }));
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

// ── Tavily Search API ───────────────────────────────────────────────────────
// POST https://api.tavily.com/search  { api_key, query, max_results }
// Results under results[]; snippet field is `content`.

async function tavilySearch(
  query: string,
  cfg: WebSearchConfig,
  count: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!cfg.apiKey)
    throw new Error("tavily web search requires webSearch.apiKey");
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: count }),
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `tavily search failed: ${res.status} ${res.statusText} ${await res.text()}`.trim(),
    );
  }
  const data = (await res.json()) as { results?: TavilyResult[] };
  const results = data.results ?? [];
  return results.slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.content ?? "").trim(),
  }));
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Strip simple HTML tags from a snippet (Brave wraps matches in <strong>). */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

/** Render results as a compact, model-friendly numbered list. */
function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.title || "(untitled)"}`;
    const url = `   ${r.url}`;
    const snip = r.snippet ? `   ${r.snippet}` : "";
    return [head, url, snip].filter(Boolean).join("\n");
  });
  return lines.join("\n\n");
}

// ── tool factory ──────────────────────────────────────────────────────────────

/**
 * Build the `web_search` Tool from the active config. Read-only (allowed in plan
 * mode). When web search is unconfigured the tool still registers, but a call
 * returns the clear "not configured" error so the model learns it can't search.
 */
export function webSearchTool(cfg: WebSearchConfig): Tool {
  return {
    name: "web_search",
    description:
      "Search the web for up-to-date information. Returns a numbered list of results with title, URL, and a short snippet. Use for current events, docs, or anything outside the local project.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        count: {
          type: "number",
          description: "Number of results to return (1-10, default 5).",
        },
      },
      required: ["query"],
    },
    async run(input) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) throw new Error('missing required string argument "query"');
      const results = await searchWeb(query, cfg, { count: input.count });
      return formatResults(query, results);
    },
  };
}
