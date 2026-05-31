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

import type { McpServerConfig } from "./config.ts";
import type { Tool } from "./tools.ts";

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

  /** Run the transport + MCP handshake. Throws if either fails. */
  async connect(): Promise<void> {
    this.transport.onMessage((m) => this.handle(m));
    this.transport.onClose((err) =>
      this.failAll(err ?? new Error("transport closed")),
    );
    await this.transport.start();
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cc", version: "0.0.1" },
    });
    await this.notify("notifications/initialized");
  }

  /** List the server's tools. */
  async listTools(): Promise<McpTool[]> {
    const res = (await this.request("tools/list", {})) as
      | { tools?: McpTool[] }
      | undefined;
    return res?.tools ?? [];
  }

  /** Invoke a tool by its server-local name; returns the rendered text result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
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

/**
 * Render an MCP `tools/call` result into the string cc passes back to the model.
 * Text content blocks are joined; a result flagged `isError` is thrown so the
 * agent loop marks the tool_result as an error.
 */
function renderToolResult(res: unknown): string {
  const r = (res ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  // Single pass: collect the text blocks instead of filter()+map() over content.
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  const text = parts.join("\n");
  if (r.isError) throw new Error(text || "MCP tool returned an error");
  return text || "(no output)";
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
    run(input) {
      return client.callTool(mt.name, input);
    },
  };
}

// ── stdio transport ──────────────────────────────────────────────────────────

/**
 * Read newline-delimited JSON-RPC messages off a byte stream, dispatching each
 * parsed message to `onMessage`. Returns when the stream ends.
 */
async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onMessage: (msg: RpcMessage) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as RpcMessage);
      } catch {
        // Non-JSON line (e.g. server diagnostics) — ignore.
      }
    }
  }
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
        env: { ...process.env, ...(cfg.env ?? {}) },
      });
      // Pump stdout in the background; signal close when it ends or the process exits.
      readJsonLines(proc.stdout as ReadableStream<Uint8Array>, (m) =>
        onMessage(m),
      )
        .catch(() => {})
        .finally(() => onClose());
      proc.exited.then((code) =>
        onClose(
          code ? new Error(`MCP server exited (code ${code})`) : undefined,
        ),
      );
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
function sseTransport(
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
          endpoint = new URL(data, base).href;
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
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  const flush = () => {
    if (data.length) onEvent(event, data.join("\n"));
    event = "message";
    data = [];
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        flush(); // blank line ends an event
      } else if (line.startsWith(":")) {
        // comment — ignore
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
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

  for (const [name, cfg] of Object.entries(servers)) {
    const client = new McpClient(transportFor(cfg));
    try {
      await client.connect();
      const mcpTools = await client.listTools();
      for (const mt of mcpTools) tools.push(wrapMcpTool(name, mt, client));
      clients.push(client);
      notes.push(
        `${name} (${mcpTools.length} tool${mcpTools.length === 1 ? "" : "s"})`,
      );
    } catch (err) {
      await client.close().catch(() => {});
      notes.push(`${name}: failed (${(err as Error).message})`);
    }
  }

  return { tools, clients, notes };
}

/** A one-line stderr note summarizing MCP connections (undefined if none configured). */
export function describeMcp(
  conn: McpConnection,
  configured: number,
): string | undefined {
  if (configured === 0) return undefined;
  return `🔌 mcp: ${conn.notes.join(", ")}`;
}

/** Close every live MCP client (call after the run). */
export async function closeMcp(conn: McpConnection): Promise<void> {
  await Promise.all(conn.clients.map((c) => c.close().catch(() => {})));
}
