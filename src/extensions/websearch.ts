// websearch.ts — web-reading tools and pluggable search backends.
//
// `web_fetch(url)` retrieves a known URL directly; `github_read_file(...)` reads
// public GitHub repository files without scraping GitHub's app shell; and
// `web_search(query, cfg)` fans out to one of a few search backends selected by
// `config.webSearch.provider` ("duckduckgo" | "brave" | "tavily"), returning a
// normalized `{ title, url, snippet }[]`. DuckDuckGo is free and keyless and used
// by default. The tools are read-only (safe in plan mode). They are built from
// config at startup and appended to the registry by the caller, so tools.ts stays
// config-free.

import type { WebSearchConfig } from "../config.ts";
import type { SessionExtension } from "../extension.ts";
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
        'webSearch.provider to "brave" or "tavily" with an apiKey in ~/.canarycode/config.json.',
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

// ── direct URL fetching ─────────────────────────────────────────────────────

const WEB_FETCH_UA = `canarycode/${Bun.version} (+https://github.com/kyletsang/canarycode)`;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS = 50_000;

function clampMaxChars(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_CHARS, Math.max(1_000, Math.trunc(n)));
}

function reqInputStr(
  input: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const v = input[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (fallback) return fallback;
  throw new Error(`missing required string argument "${key}"`);
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports http:// and https:// URLs");
  }
  return url;
}

function truncateContent(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n[truncated: showing ${maxChars} of ${s.length} characters]`;
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ finalUrl: string; contentType: string; text: string }> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: "text/*,application/json,*/*;q=0.8",
      "User-Agent": WEB_FETCH_UA,
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `fetch failed: ${res.status} ${res.statusText} ${truncateBody(await res.text().catch(() => ""))}`.trim(),
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (
    contentType &&
    !/text|json|xml|javascript|markdown|yaml|toml|csv|html/i.test(contentType)
  ) {
    throw new Error(
      `unsupported content-type ${contentType}; web_fetch only returns text-like responses`,
    );
  }
  return { finalUrl: res.url || url, contentType, text: await res.text() };
}

function extractHtmlText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i.exec(
      html,
    )?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i.exec(
      html,
    )?.[1] ??
    "";
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return [title, description, body]
    .map((part) => normalizeWhitespace(decodeEntities(part)))
    .filter(Boolean)
    .join("\n\n");
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatFetchedContent(
  url: string,
  contentType: string,
  text: string,
  maxChars: number,
): string {
  const body = /html/i.test(contentType) ? extractHtmlText(text) : text.trim();
  return `URL: ${url}\nContent-Type: ${contentType || "unknown"}\n\n${truncateContent(body, maxChars)}`;
}

function parseGithubRepoUrl(value: string): { owner: string; repo: string } {
  const url = parseHttpUrl(value);
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("GitHub URL must be on github.com");
  }
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`not a GitHub repository URL: ${value}`);
  return { owner, repo: repo.replace(/\.git$/, "") };
}

async function fetchGithubFile(
  owner: string,
  repo: string,
  path: string,
  ref: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ url: string; text: string }> {
  const refs = ref ? [ref] : ["HEAD", "main", "master"];
  const cleanPath = path.replace(/^\/+/, "");
  for (const branch of refs) {
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${cleanPath}`;
    const res = await fetchImpl(raw, {
      headers: { Accept: "text/plain,*/*;q=0.8", "User-Agent": WEB_FETCH_UA },
      signal,
    });
    if (res.ok) return { url: res.url || raw, text: await res.text() };
    if (res.status !== 404) {
      throw new Error(
        `GitHub fetch failed: ${res.status} ${res.statusText} ${truncateBody(await res.text().catch(() => ""))}`.trim(),
      );
    }
  }
  throw new Error(`file not found in ${owner}/${repo}: ${cleanPath}`);
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

// ── tool factories ─────────────────────────────────────────────────────────────

/** Fetch a known URL directly. Prefer this over search when the prompt includes a URL. */
export function webFetchTool(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Tool {
  return {
    name: "web_fetch",
    description:
      "Fetch a direct URL and return readable text. Use this when the user provides a URL; do not use web_search first for known URLs. HTML is converted to plain text. Supports text-like http(s) responses.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch." },
        max_chars: {
          type: "number",
          description: `Maximum characters to return (1000-${MAX_CHARS}, default ${DEFAULT_MAX_CHARS}).`,
        },
      },
      required: ["url"],
    },
    async run(input) {
      const url = parseHttpUrl(reqInputStr(input, "url")).toString();
      const maxChars = clampMaxChars(input.max_chars as number | undefined);
      const fetched = await fetchText(url, fetchImpl, signal);
      return formatFetchedContent(
        fetched.finalUrl,
        fetched.contentType,
        fetched.text,
        maxChars,
      );
    },
  };
}

/** Read files from a public GitHub repo via raw.githubusercontent.com. */
export function githubReadFileTool(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Tool {
  return {
    name: "github_read_file",
    description:
      "Read a text file from a public GitHub repository, especially README.md or docs. Accepts either repo_url or owner/repo plus a file path. Use for GitHub repo URLs before web_search.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          description:
            "GitHub repository URL, e.g. https://github.com/owner/repo.",
        },
        owner: { type: "string", description: "Repository owner/org." },
        repo: { type: "string", description: "Repository name." },
        path: {
          type: "string",
          description: "File path in the repository (default README.md).",
        },
        ref: {
          type: "string",
          description:
            "Branch, tag, or commit SHA (default: HEAD/main/master).",
        },
        max_chars: {
          type: "number",
          description: `Maximum characters to return (1000-${MAX_CHARS}, default ${DEFAULT_MAX_CHARS}).`,
        },
      },
    },
    async run(input) {
      const repoUrl =
        typeof input.repo_url === "string" ? input.repo_url.trim() : "";
      const parsed = repoUrl ? parseGithubRepoUrl(repoUrl) : undefined;
      const owner = parsed?.owner ?? reqInputStr(input, "owner");
      const repo = parsed?.repo ?? reqInputStr(input, "repo");
      const path = reqInputStr(input, "path", "README.md");
      const ref =
        typeof input.ref === "string" && input.ref.trim()
          ? input.ref.trim()
          : undefined;
      const maxChars = clampMaxChars(input.max_chars as number | undefined);
      const fetched = await fetchGithubFile(
        owner,
        repo,
        path,
        ref,
        fetchImpl,
        signal,
      );
      return `GitHub: ${owner}/${repo}/${path}\nURL: ${fetched.url}\n\n${truncateContent(
        fetched.text.trim(),
        maxChars,
      )}`;
    },
  };
}

/**
 * Build the `web_search` Tool from the active config. Read-only (allowed in plan
 * mode). With no config it uses the free, keyless DuckDuckGo backend; set
 * webSearch.provider/apiKey to switch to Brave or Tavily.
 */
export function webSearchTool(
  cfg: WebSearchConfig,
  signal?: AbortSignal,
): Tool {
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
      const results = await searchWeb(query, cfg, {
        count: input.count,
        signal,
      });
      return formatResults(query, results);
    },
  };
}

const WEB_PROMPT_SECTION = [
  "── WEB TOOLS ──",
  "When the user provides a direct URL, fetch it with web_fetch instead of searching for it.",
  "For github.com/owner/repo URLs, prefer github_read_file with path README.md, then fetch specific files/docs as needed.",
  "Use web_search only when you need to discover unknown pages or alternatives.",
].join("\n");

export function webSearchExtension(): SessionExtension {
  return {
    name: "websearch",
    tools: (ctx) => [
      webFetchTool(fetch, ctx.signal),
      githubReadFileTool(fetch, ctx.signal),
      webSearchTool(ctx.config.webSearch, ctx.signal),
    ],
    systemPrompt: () => WEB_PROMPT_SECTION,
  };
}
