// mcp.ts — connect to MCP servers and merge their tools into the registry.
//
// MCP (Model Context Protocol) servers expose extra tools over JSON-RPC 2.0.
// Two transports are supported, both declared in ~/.cc/config.json under
// `mcpServers`:
//   stdio:  { "name": { "command": "...", "args": [...], "env": {...} } }
//   SSE:    { "name": { "url": "https://..." } }
//
// On startup we connect to each, run the MCP handshake, list its tools, and wrap
// each one as a normal cc `Tool` namespaced `mcp__<server>__<tool>`. A tool's
// `readOnly` flag (the plan-mode gate) is inferred from its `readOnlyHint`
// annotation, defaulting to false (mutating) when unknown. A server that fails to
// connect is reported once and skipped — the agent runs without it.

import type { McpServerConfig } from "../config.ts";
import type { ImageData } from "../image.ts";
import type { Tool, ToolRunResult } from "../tools.ts";

/** MCP protocol revision we advertise in the handshake. */
const PROTOCOL_VERSION = "2024-11-05";
/** Per-request timeout (ms) before we give up on a server response. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A JSON-RPC 2.0 message (request, notification, or response). */
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A tool as reported by an MCP server's `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown };
}

/**
 * A bidirectional JSON-RPC message channel. Both stdio and SSE transports
 * implement this; `McpClient` drives the protocol over it. Injectable so the
 * client can be tested without spawning a process or opening a socket.
 */
export interface Transport {
  /** Begin reading. Resolves once the transport is ready to send. */
  start(): Promise<void>;
  /** Send one JSON-RPC message. */
  send(msg: RpcMessage): Promise<void>;
  /** Register the handler that receives every inbound message. */
  onMessage(handler: (msg: RpcMessage) => void): void;
  /** Register a handler for transport close / fatal error. */
  onClose(handler: (err?: Error) => void): void;
  /** Tear down the transport. */
  close(): Promise<void>;
}

/**
 * Minimal MCP client: handshake, tool listing, tool calls. Correlates JSON-RPC
 * responses to requests by id and rejects all pending calls if the transport
 * dies. One client per server.
 */
class McpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closeErr: Error | undefined;

  constructor(private readonly transport: Transport) {}

  /** Run the transport + MCP handshake. Throws if either fails.
   *
   * The three steps are a strict protocol ordering, NOT independent work: the
   * transport must be live before `initialize` can be sent, and the server must
   * finish `initialize` before it will accept the `initialized` notification.
   * They are chained so each step depends on the previous completing — racing
   * them with `Promise.all` would violate the MCP handshake. */
  async connect(): Promise<void> {
    this.transport.onMessage((m) => this.handle(m));
    this.transport.onClose((err) =>
      this.failAll(err ?? new Error("transport closed")),
    );
    await this.transport
      .start()
      .then(() =>
        this.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "cc", version: "0.0.1" },
        }),
      )
      .then(() => this.notify("notifications/initialized"));
  }

  /** List the server's tools. */
  async listTools(): Promise<McpTool[]> {
    const res = (await this.request("tools/list", {})) as
      | { tools?: McpTool[] }
      | undefined;
    return res?.tools ?? [];
  }

  /** Invoke a tool by its server-local name; returns rendered text + any image. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const res = await this.request("tools/call", { name, arguments: args });
    return renderToolResult(res);
  }

  /** Close the underlying transport and reject anything still in flight. */
  async close(): Promise<void> {
    await this.transport.close().catch(() => {});
    this.failAll(new Error("client closed"));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closeErr) return Promise.reject(this.closeErr);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport
        .send({ jsonrpc: "2.0", id, method, params })
        .catch((e: Error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        });
    });
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private handle(msg: RpcMessage): void {
    // We only originate requests, so inbound messages with an id are responses.
    if (msg.id === undefined) return; // server request/notification — unsupported, ignore
    const id = typeof msg.id === "string" ? Number(msg.id) : msg.id;
    const entry = this.pending.get(id as number);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id as number);
    if (msg.error)
      entry.reject(
        new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
      );
    else entry.resolve(msg.result);
  }

  private failAll(err: Error): void {
    this.closeErr ??= err;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

/** The rendered form of an MCP `tools/call` result: text plus an optional image. */
export interface McpToolResult {
  content: string;
  image?: ImageData;
}

/**
 * Render an MCP `tools/call` result into what cc passes back to the model. Text
 * content blocks are joined; the first image content block (`{ data, mimeType }`,
 * e.g. a puppeteer screenshot) is surfaced as base64 image data the agent loop
 * attaches for vision models. A result flagged `isError` is thrown so the agent
 * loop marks the tool_result as an error.
 */
export function renderToolResult(res: unknown): McpToolResult {
  const r = (res ?? {}) as {
    content?: Array<{
      type?: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  };
  // Single pass: collect text blocks and the first image block from content.
  const parts: string[] = [];
  let image: ImageData | undefined;
  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (
      !image &&
      c.type === "image" &&
      typeof c.data === "string" &&
      typeof c.mimeType === "string"
    ) {
      image = { mediaType: c.mimeType, data: c.data };
    }
  }
  const text = parts.join("\n");
  if (r.isError) throw new Error(text || "MCP tool returned an error");
  // The tool_result text must never be empty; fall back to an image marker.
  const content =
    text || (image ? `[image ${image.mediaType}]` : "(no output)");
  return { content, image };
}

/**
 * Wrap an MCP tool as a cc `Tool`. The name is namespaced `mcp__<server>__<tool>`
 * so it can't collide with built-ins or other servers; `readOnly` is taken from
 * the `readOnlyHint` annotation (default false), which is what plan mode filters on.
 */
function wrapMcpTool(server: string, mt: McpTool, client: McpClient): Tool {
  return {
    name: `mcp__${server}__${mt.name}`,
    description:
      mt.description || `MCP tool "${mt.name}" from server "${server}".`,
    schema: mt.inputSchema ?? { type: "object", properties: {} },
    readOnly: mt.annotations?.readOnlyHint === true,
    async run(input): Promise<ToolRunResult> {
      const { content, image } = await client.callTool(mt.name, input);
      return image ? { content, image } : { content };
    },
  };
}

// ── stdio transport ──────────────────────────────────────────────────────────

/**
 * Split the first newline-terminated line off a string buffer. Returns the line
 * (without the trailing `\n`) and the remaining buffer, or `undefined` when the
 * buffer holds no complete line yet. Pulling one frame per call keeps the
 * line-scan out of the streaming read loop.
 */
function takeLine(buf: string): { line: string; rest: string } | undefined {
  const nl = buf.indexOf("\n");
  if (nl === -1) return undefined;
  return { line: buf.slice(0, nl), rest: buf.slice(nl + 1) };
}

/**
 * Read newline-delimited JSON-RPC messages off a byte stream, dispatching each
 * parsed message to `onMessage`. Returns when the stream ends.
 */
async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onMessage: (msg: RpcMessage) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  // A stream pump: each chunk depends on the previous read advancing the cursor,
  // so it is sequential by nature — `for await` over the async-iterable stream
  // expresses that without a manual `reader.read()` await-in-loop.
  for await (const value of stream) {
    buf += decoder.decode(value, { stream: true });
    let frame = takeLine(buf);
    while (frame) {
      buf = frame.rest;
      const line = frame.line.trim();
      if (line) {
        try {
          onMessage(JSON.parse(line) as RpcMessage);
        } catch {
          // Non-JSON line (e.g. server diagnostics) — ignore.
        }
      }
      frame = takeLine(buf);
    }
  }
}

/** Vars safe to inherit by default — secrets must be passed via cfg.env explicitly.
 *  Mirrors the official MCP SDK's Unix default (HOME LOGNAME PATH SHELL TERM USER)
 *  plus TMPDIR/LANG/LC_ALL and non-secret proxy/TLS vars. If a server needs more
 *  (NODE_OPTIONS, XDG_*, …), add them to that server's `env` in config.json. */
const SAFE_ENV = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
];

/** Build the environment for a spawned MCP server: allowlisted parent vars plus
 *  the server's explicit `env` entries. Exported for tests. */
export function childEnv(
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/** A stdio transport that spawns `command args...` and speaks JSON-RPC over its stdio. */
function stdioTransport(cfg: McpServerConfig): Transport {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let onMessage: (msg: RpcMessage) => void = () => {};
  let onClose: (err?: Error) => void = () => {};

  return {
    onMessage(h) {
      onMessage = h;
    },
    onClose(h) {
      onClose = h;
    },
    async start() {
      if (!cfg.command) throw new Error("stdio MCP server needs a `command`");
      proc = Bun.spawn([cfg.command, ...(cfg.args ?? [])], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: childEnv(cfg.env),
      });
      // Pump stdout in the background; signal close when it ends or the process exits.
      readJsonLines(proc.stdout as ReadableStream<Uint8Array>, (m) =>
        onMessage(m),
      )
        .catch(() => {})
        .finally(() => onClose());
      proc.exited
        .then((code) =>
          onClose(
            code ? new Error(`MCP server exited (code ${code})`) : undefined,
          ),
        )
        .catch(() => onClose(new Error("MCP server process error")));
    },
    async send(msg) {
      if (!proc) throw new Error("transport not started");
      const stdin = proc.stdin as import("bun").FileSink;
      stdin.write(`${JSON.stringify(msg)}\n`);
      await stdin.flush();
    },
    async close() {
      proc?.kill();
    },
  };
}

// ── SSE transport ──────────────────────────────────────────────────────────

/**
 * Legacy MCP HTTP+SSE transport. Opening the URL yields an SSE stream whose first
 * `endpoint` event carries the URL to POST client messages to; server messages
 * arrive as `message` events on the stream.
 */
export function sseTransport(
  cfg: McpServerConfig,
  fetchImpl: typeof fetch = fetch,
): Transport {
  let onMessage: (msg: RpcMessage) => void = () => {};
  let onClose: (err?: Error) => void = () => {};
  let endpoint = "";
  let ready!: Promise<void>;
  let markReady!: () => void;
  let failReady!: (e: Error) => void;
  const headers = (cfg.env ?? {}) as Record<string, string>;

  return {
    onMessage(h) {
      onMessage = h;
    },
    onClose(h) {
      onClose = h;
    },
    async start() {
      if (!cfg.url) throw new Error("SSE MCP server needs a `url`");
      ready = new Promise<void>((res, rej) => {
        markReady = res;
        failReady = rej;
      });
      const resp = await fetchImpl(cfg.url, {
        headers: { Accept: "text/event-stream", ...headers },
      });
      if (!resp.ok || !resp.body)
        throw new Error(`SSE connect failed: HTTP ${resp.status}`);
      const base = cfg.url;
      // Pump the SSE stream in the background.
      readSse(resp.body as ReadableStream<Uint8Array>, (event, data) => {
        if (event === "endpoint") {
          // The endpoint is server-controlled: restrict it to the configured
          // server's origin so a malicious server can't redirect our POSTs.
          const resolved = new URL(data, base);
          if (resolved.origin !== new URL(base).origin) {
            failReady(
              new Error(
                `SSE endpoint ${resolved.origin} does not match server origin`,
              ),
            );
            return;
          }
          endpoint = resolved.href;
          markReady();
        } else if (event === "message") {
          try {
            onMessage(JSON.parse(data) as RpcMessage);
          } catch {
            // ignore malformed event
          }
        }
      })
        .catch(() => {})
        .finally(() => {
          // Only fail `ready` if the endpoint never arrived — after a
          // successful session the promise is already settled.
          if (!endpoint)
            failReady(new Error("SSE stream closed before endpoint"));
          onClose();
        });
    },
    async send(msg) {
      await ready;
      const resp = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(msg),
      });
      if (!resp.ok) throw new Error(`SSE send failed: HTTP ${resp.status}`);
    },
    async close() {
      // Best-effort: the background reader's finally() fires onClose when the
      // server ends the stream. Nothing to actively tear down here.
    },
  };
}

/**
 * Parse a Server-Sent Events byte stream, invoking `onEvent(event, data)` for
 * each complete event (event name defaults to "message").
 */
async function readSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  const flush = () => {
    if (data.length) onEvent(event, data.join("\n"));
    event = "message";
    data = [];
  };
  // Sequential stream pump (each read advances the cursor) — `for await` over the
  // async-iterable stream, no manual `reader.read()` await-in-loop.
  for await (const value of stream) {
    buf += decoder.decode(value, { stream: true });
    let frame = takeLine(buf);
    while (frame) {
      buf = frame.rest;
      const line = frame.line.replace(/\r$/, "");
      if (line === "") {
        flush(); // blank line ends an event
      } else if (line.startsWith(":")) {
        // comment — ignore
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
      frame = takeLine(buf);
    }
  }
  flush();
}

// ── orchestration ────────────────────────────────────────────────────────────

/** The result of connecting to the configured MCP servers. */
export interface McpConnection {
  /** Namespaced tools merged from all servers that connected. */
  tools: Tool[];
  /** Live clients to close when the run ends. */
  clients: McpClient[];
  /** Per-server one-line status notes (connected counts + failures). */
  notes: string[];
}

/**
 * Connect to every configured MCP server, list and wrap its tools. A server that
 * fails to connect is noted and skipped (the agent continues without it). Servers
 * with both `command` and `url` prefer `url` (SSE).
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  transportFor: (cfg: McpServerConfig) => Transport = (cfg) =>
    cfg.url ? sseTransport(cfg) : stdioTransport(cfg),
): Promise<McpConnection> {
  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  const notes: string[] = [];

  // Different servers are independent, so connect to them concurrently. Each
  // settles to its own tools/client/note; we fold the settled results back in
  // `Object.entries` order so tool ordering and notes stay deterministic.
  type ServerResult = {
    tools: Tool[];
    client?: McpClient;
    note: string;
  };
  const connectOne = async (
    name: string,
    cfg: McpServerConfig,
  ): Promise<ServerResult> => {
    const client = new McpClient(transportFor(cfg));
    try {
      await client.connect();
      const mcpTools = await client.listTools();
      return {
        tools: mcpTools.map((mt) => wrapMcpTool(name, mt, client)),
        client,
        note: `${name} (${mcpTools.length} tool${
          mcpTools.length === 1 ? "" : "s"
        })`,
      };
    } catch (err) {
      await client.close().catch(() => {});
      return { tools: [], note: `${name}: failed (${(err as Error).message})` };
    }
  };

  const settled = await Promise.all(
    Object.entries(servers).map(([name, cfg]) => connectOne(name, cfg)),
  );
  for (const r of settled) {
    tools.push(...r.tools);
    if (r.client) clients.push(r.client);
    notes.push(r.note);
  }

  return { tools, clients, notes };
}

/** A one-line stderr note summarizing MCP connections (undefined if none configured). */
export function describeMcp(
  conn: McpConnection,
  configured: number,
): string | undefined {
  if (configured === 0) return undefined;
  return `⌁ mcp: ${conn.notes.join(", ")}`;
}

/** Close every live MCP client (call after the run). */
export async function closeMcp(conn: McpConnection): Promise<void> {
  await Promise.all(conn.clients.map((c) => c.close().catch(() => {})));
}

// ── extension factory ─────────────────────────────────────────────────────────

import type { SessionExtension } from "../extension.ts";

export function mcpExtension(
  transportFor?: (cfg: McpServerConfig) => Transport,
): SessionExtension {
  let mcpConn: McpConnection | undefined;
  return {
    name: "mcp",
    async tools(ctx) {
      const configured = Object.keys(ctx.config.mcpServers).length;
      // No servers configured ⇒ don't connect at all (matches headless).
      if (configured === 0) return [];
      const conn = await connectMcpServers(ctx.config.mcpServers, transportFor);
      mcpConn = conn;
      const note = describeMcp(conn, configured);
      if (note) ctx.note(note);
      return conn.tools;
    },
    async dispose() {
      if (mcpConn) await closeMcp(mcpConn);
    },
  };
}
