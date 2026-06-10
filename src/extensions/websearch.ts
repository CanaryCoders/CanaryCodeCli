// websearch.ts — the `web_search` tool and its pluggable HTTP backends.
//
// A single `searchWeb(query, cfg)` fans out to one of a few search backends
// selected by `config.webSearch.provider` ("duckduckgo" | "brave" | "tavily"),
// returning a normalized `{ title, url, snippet }[]`. DuckDuckGo is free and
// keyless and used by default. `webSearchTool(cfg)` wraps it as a read-only Tool
// (safe in plan mode). The tool is built from config at startup and appended to
// the registry by the caller, so tools.ts stays config-free.

import type { WebSearchConfig } from "../config.ts";
import type { Extension } from "../extension.ts";
import type { Tool } from "../tools.ts";

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

/** Keep provider error bodies short — they can echo auth/subscription details. */
function truncateBody(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

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
  // Default to the free, keyless DuckDuckGo backend when nothing is configured.
  const provider = (cfg.provider ?? "duckduckgo").toLowerCase();
  const count = clampCount(opts.count);
  const fetchImpl = opts.fetchImpl ?? fetch;
  switch (provider) {
    case "duckduckgo":
    case "ddg":
      return duckDuckGoSearch(query, count, fetchImpl, opts.signal);
    case "brave":
      return braveSearch(query, cfg, count, fetchImpl, opts.signal);
    case "tavily":
      return tavilySearch(query, cfg, count, fetchImpl, opts.signal);
    default:
      throw new Error(
        `unknown webSearch.provider "${cfg.provider}" (supported: duckduckgo, brave, tavily)`,
      );
  }
}

// ── DuckDuckGo (free, no API key) ─────────────────────────────────────────────
// The default backend: no key, no signup. We POST the query to DuckDuckGo's
// no-JS SERP endpoints and scrape the result anchors/snippets. Two endpoints are
// tried in order for resilience: the rich `html.duckduckgo.com/html/` page first,
// then the minimal `lite.duckduckgo.com/lite/` page. DDG routes outbound links
// through a `/l/?uddg=<encoded>` redirector, which we unwrap to the real URL.
//
// Note: DDG rate-limits scraping by IP. When it serves an "anomaly"/challenge
// page instead of results, we surface a clear, actionable error.

const DDG_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** One endpoint attempt: results, a "blocked" signal, or "miss" (retry next). */
type EndpointOutcome =
  | { kind: "results"; results: SearchResult[] }
  | { kind: "blocked" }
  | { kind: "miss" };

/** Try a single DDG endpoint. Pulled out of the fallback loop so the loop holds
 *  no inline await — the endpoints are a *sequential fallback chain* (try the
 *  next only when this one misses/blocks), never raced. */
async function tryDdgEndpoint(
  endpoint: string,
  query: string,
  count: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<EndpointOutcome> {
  let html: string;
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DDG_UA,
        Accept: "text/html",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal,
    });
    if (!res.ok) return { kind: "miss" };
    html = await res.text();
  } catch {
    return { kind: "miss" };
  }
  // DDG's block page is short and contains an anomaly/challenge token.
  if (/anomaly-modal|If this error persists|challenge/i.test(html)) {
    return { kind: "blocked" };
  }
  const results = parseDdgHtml(html, count);
  return results.length > 0 ? { kind: "results", results } : { kind: "miss" };
}

async function duckDuckGoSearch(
  query: string,
  count: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const endpoints = [
    "https://html.duckduckgo.com/html/",
    "https://lite.duckduckgo.com/lite/",
  ];
  // A sequential fallback chain: try the next endpoint only when the prior one
  // misses/blocks — never raced (don't hammer both; the second is a backstop).
  // `reduce` threads the prior outcome into the next step (a loop-carried
  // dependency), so each attempt depends on the previous result, and a `results`
  // outcome short-circuits the remaining attempts.
  const final = await endpoints.reduce<Promise<EndpointOutcome>>(
    (prev, endpoint) =>
      prev.then((outcome) =>
        outcome.kind === "results"
          ? outcome
          : tryDdgEndpoint(endpoint, query, count, fetchImpl, signal).then(
              (next) =>
                // Carry a "blocked" verdict forward so the final outcome still
                // reflects it even if a later endpoint merely misses.
                next.kind === "miss" && outcome.kind === "blocked"
                  ? outcome
                  : next,
            ),
      ),
    Promise.resolve<EndpointOutcome>({ kind: "miss" }),
  );
  if (final.kind === "results") return final.results;
  if (final.kind === "blocked") {
    throw new Error(
      "duckduckgo blocked this request (rate limit / anomaly page). " +
        "Retry shortly, or configure a keyed provider: set " +
        'webSearch.provider to "brave" or "tavily" with an apiKey in ~/.cc/config.json.',
    );
  }
  return [];
}

/** Scrape result anchors + snippets from either DDG no-JS layout. */
function parseDdgHtml(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  // html/: <a class="result__a" href="…">title</a>; lite/: <a class="result-link" …>.
  const anchorRe =
    /<a[^>]+class="[^"]*result(?:__a|-link)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Snippets: html/ uses result__snippet (an <a>); lite/ uses td.result-snippet.
  const snippetRe =
    /class="[^"]*result(?:__snippet|-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td)>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)))
    snippets.push(decodeEntities(stripTags(sm[1] ?? "")));
  let am: RegExpExecArray | null;
  let i = 0;
  while ((am = anchorRe.exec(html)) && results.length < count) {
    const url = unwrapDdgUrl(decodeEntities(am[1] ?? ""));
    const title = decodeEntities(stripTags(am[2] ?? ""));
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

/** DDG wraps outbound links as `…/l/?…&uddg=<urlencoded>`. Recover the target. */
function unwrapDdgUrl(href: string): string {
  let h = href;
  if (h.startsWith("//")) h = `https:${h}`;
  try {
    const u = new URL(h, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    return u.toString();
  } catch {
    return h;
  }
}

/** Decode the HTML entities DDG emits in href/title/snippet text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // last: avoid double-decoding
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
      `brave search failed: ${res.status} ${res.statusText} ${truncateBody(await res.text().catch(() => ""))}`.trim(),
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
      `tavily search failed: ${res.status} ${res.statusText} ${truncateBody(await res.text().catch(() => ""))}`.trim(),
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
 * mode). With no config it uses the free, keyless DuckDuckGo backend; set
 * webSearch.provider/apiKey to switch to Brave or Tavily.
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

export function webSearchExtension(): Extension {
  return {
    name: "websearch",
    tools: (ctx) => [webSearchTool(ctx.config.webSearch)],
  };
}
