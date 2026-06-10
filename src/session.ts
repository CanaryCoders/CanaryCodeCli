// session.ts — bun:sqlite persistence for conversations + token/cost tracking.
//
// Every run can be recorded as a `session` (one row: model, cwd, title, running
// token + cost totals) with an ordered list of `turns` (the Message transcript,
// each row a JSON-encoded ContentBlock[]). The store is intentionally small: open
// the db, create a session, append turns as the agent loop produces them, fold in
// usage as it streams. `--resume` (next task) reads sessions + turns back out.
//
// The db lives at ~/.cc/sessions.db. Content is stored as JSON text so the schema
// never has to know about provider block shapes.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message } from "./provider.ts";

/** Path to the sessions database (~/.cc/sessions.db). */
function dbPath(): string {
  return join(homedir(), ".cc", "sessions.db");
}

export interface SessionRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  cwd: string;
  title: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Last-active thinking level (e.g. "off" | "think" | "ultrathink"). */
  thinking: string | null;
  /** Last-active agent mode ("normal" | "plan" | "auto"). */
  mode: string | null;
}

interface SessionDbRow {
  id: string;
  created_at: number;
  updated_at: number;
  model: string;
  cwd: string;
  title: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  thinking: string | null;
  mode: string | null;
}

interface TurnDbRow {
  role: string;
  content: string;
}

function toSessionRow(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    model: r.model,
    cwd: r.cwd,
    title: r.title,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    thinking: r.thinking ?? null,
    mode: r.mode ?? null,
  };
}

// ── Pricing (USD per million tokens) ─────────────────────────────────────────
// Matched by substring against the resolved model name. Unknown models cost 0 —
// we'd rather report nothing than a confidently-wrong number. Custom/openai-compat
// providers can stay at 0 until a price is known.

interface Price {
  input: number;
  output: number;
}

const PRICES: { match: string; price: Price }[] = [
  { match: "opus", price: { input: 15, output: 75 } },
  { match: "sonnet", price: { input: 3, output: 15 } },
  { match: "haiku", price: { input: 0.8, output: 4 } },
];

function priceForModel(model: string): Price | undefined {
  const m = model.toLowerCase();
  return PRICES.find((p) => m.includes(p.match))?.price;
}

/** Whether a model has known pricing data. */
export function hasPriceData(model: string): boolean {
  return priceForModel(model) !== undefined;
}

/** Estimate USD cost for a token count given a model name. Unknown model → 0. */
function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceForModel(model);
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ── Store ─────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  model         TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  title         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  thinking      TEXT,
  mode          TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, idx);
`;

/**
 * Add columns introduced after the original schema to pre-existing databases.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so older
 * sessions.db files miss `thinking`/`mode` — add them idempotently. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so we check the catalog first.
 */
function migrate(db: Database): void {
  const cols = new Set(
    (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("thinking"))
    db.run("ALTER TABLE sessions ADD COLUMN thinking TEXT");
  if (!cols.has("mode")) db.run("ALTER TABLE sessions ADD COLUMN mode TEXT");
}

export class SessionStore {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * Open (or create) the store at `path`. Pass ":memory:" for an ephemeral db
   * (used by tests). Parent directories are created as needed.
   */
  static open(path: string = dbPath()): SessionStore {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const db = new Database(path, { create: true });
    if (path !== ":memory:") {
      // Transcripts can contain secrets the tools read — owner-only.
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort: never block opening the store on a chmod failure
      }
    }
    db.exec("PRAGMA journal_mode = WAL;");
    db.run(SCHEMA);
    migrate(db);
    return new SessionStore(db);
  }

  /** Create a new session row and return its generated id. */
  createSession(opts: {
    model: string;
    cwd: string;
    title?: string;
    thinking?: string;
    mode?: string;
  }): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO sessions (id, created_at, updated_at, model, cwd, title, thinking, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        now,
        now,
        opts.model,
        opts.cwd,
        opts.title ?? null,
        opts.thinking ?? null,
        opts.mode ?? null,
      );
    return id;
  }

  /** Update the session's active model (e.g. after a runtime `/model` switch). */
  setModel(sessionId: string, model: string): void {
    this.db
      .query("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
      .run(model, Date.now(), sessionId);
  }

  /** Update the session's last-active thinking level. */
  setThinking(sessionId: string, thinking: string): void {
    this.db
      .query("UPDATE sessions SET thinking = ?, updated_at = ? WHERE id = ?")
      .run(thinking, Date.now(), sessionId);
  }

  /** Update the session's last-active agent mode. */
  setMode(sessionId: string, mode: string): void {
    this.db
      .query("UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, Date.now(), sessionId);
  }

  /** Append one message to a session's transcript, in order. Bumps updated_at. */
  appendTurn(sessionId: string, message: Message): void {
    const row = this.db
      .query(
        "SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM turns WHERE session_id = ?",
      )
      .get(sessionId) as { maxIdx: number };
    const idx = row.maxIdx + 1;
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO turns (session_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, idx, message.role, JSON.stringify(message.content), now);
    this.db
      .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(now, sessionId);
  }

  /**
   * Replace a session's entire transcript with `messages`, in order. Used after
   * context compaction, which rewrites the in-memory history in place — the stored
   * turns must mirror it (storing the compacted form so resume doesn't re-bloat).
   */
  replaceTurns(sessionId: string, messages: Message[]): void {
    const now = Date.now();
    const tx = this.db.transaction((msgs: Message[]) => {
      this.db.query("DELETE FROM turns WHERE session_id = ?").run(sessionId);
      const insert = this.db.query(
        "INSERT INTO turns (session_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      msgs.forEach((m, idx) => {
        insert.run(sessionId, idx, m.role, JSON.stringify(m.content), now);
      });
      this.db
        .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, sessionId);
    });
    tx(messages);
  }

  /**
   * Fold a usage sample into a session's running totals and accrue cost using the
   * session's model. Called once per `usage` event from the agent loop.
   */
  addUsage(sessionId: string, inputTokens: number, outputTokens: number): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const cost = estimateCost(session.model, inputTokens, outputTokens);
    this.db
      .query(
        "UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?",
      )
      .run(inputTokens, outputTokens, cost, Date.now(), sessionId);
  }

  /** Set (or clear) a session's title. */
  setTitle(sessionId: string, title: string | null): void {
    this.db
      .query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), sessionId);
  }

  /** Fetch one session row, or undefined if it doesn't exist. */
  getSession(id: string): SessionRow | undefined {
    const row = this.db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionDbRow | null;
    return row ? toSessionRow(row) : undefined;
  }

  /** Most-recently-updated sessions first. `limit` caps the result count. */
  listSessions(limit = 20): SessionRow[] {
    // rowid breaks ties when two sessions share an updated_at millisecond, so
    // the most-recently-created wins deterministically.
    const rows = this.db
      .query(
        "SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as SessionDbRow[];
    return rows.map(toSessionRow);
  }

  /** Reconstruct a session's Message transcript in order. */
  loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .query(
        "SELECT role, content FROM turns WHERE session_id = ? ORDER BY idx ASC",
      )
      .all(sessionId) as TurnDbRow[];
    const out: Message[] = [];
    let skipped = 0;
    for (const r of rows) {
      // A corrupt row (partial write, manual edit) must not make the whole
      // session unloadable — skip it and keep the rest of the transcript.
      try {
        out.push({
          role: r.role as Message["role"],
          content: JSON.parse(r.content) as Message["content"],
        });
      } catch {
        skipped++;
      }
    }
    // loadMessages runs at startup before the TUI mounts, so writing to
    // stderr here is safe and makes silent data loss observable.
    if (skipped > 0) {
      process.stderr.write(
        `cc: warning: skipped ${skipped} corrupt turn row(s) in session ${sessionId}\n`,
      );
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
