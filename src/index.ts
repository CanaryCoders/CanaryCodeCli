#!/usr/bin/env bun
// cc — a fast, minimal terminal coding agent.
// Entry point: arg parse + mode dispatch (headless vs TUI).
//
// Phase 1 ships the headless print path: `cc -p "<prompt>"` runs the shared
// agent loop once and streams the result to stdout, then exits. Piped stdin is
// folded into the prompt as context (`git diff | cc -p "commit message"`). The
// interactive TUI lands in Phase 4.

import { loadConfig, resolveModel } from "./config.ts";
import { createProvider } from "./provider.ts";
import { runAgent } from "./agent.ts";
import { tools as allTools } from "./tools.ts";
import { SessionStore, type SessionRow } from "./session.ts";
import type { Message } from "./provider.ts";

interface Args {
  help: boolean;
  version: boolean;
  /** The prompt passed via -p/--print, or undefined for interactive mode. */
  prompt?: string;
  /** --no-tools: run read-only with the tool set withheld entirely. */
  noTools: boolean;
  /** --model <id>: override the configured model. */
  model?: string;
  /**
   * --resume: a session id (or id prefix) to continue, or `true` for a bare
   * `--resume` (resume the most recent session, or list sessions if no prompt).
   */
  resume?: string | boolean;
}

/** Parse argv into a small, explicit shape. Unknown flags are ignored for now. */
function parseArgs(argv: string[]): Args {
  const out: Args = { help: false, version: false, noTools: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--version":
        out.version = true;
        break;
      case "-p":
      case "--print":
        out.prompt = argv[++i] ?? "";
        break;
      case "--no-tools":
        out.noTools = true;
        break;
      case "--model":
        out.model = argv[++i];
        break;
      case "--resume": {
        // An optional session id (or prefix) may follow. A value that looks like
        // a flag (or no value at all) means a bare resume. The prompt itself is
        // always passed via -p, so a non-flag token here is the session id.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          out.resume = next;
          i++;
        } else {
          out.resume = true;
        }
        break;
      }
      default:
        // A bare positional after no recognized flag is treated as the prompt.
        if (!a.startsWith("-") && out.prompt === undefined) out.prompt = a;
        break;
    }
  }
  return out;
}

function printUsage(): void {
  console.log(
    [
      "cc — minimal AI coding CLI",
      "",
      "Usage:",
      '  cc -p "<prompt>"   headless print mode (streams to stdout, exits)',
      "  cc                 interactive TUI (not yet implemented)",
      "",
      "Flags:",
      "  -p, --print <s>    run a single prompt headless",
      "  --model <id>       override the configured model",
      "  --no-tools         disable tools (read-only quick Q&A)",
      "  --resume [id]      continue a saved session (most recent if id omitted);",
      "                     bare --resume with no prompt lists recent sessions",
      "  -h, --help         show this help",
      "  --version          show version",
      "",
      "Stdin is folded into the prompt as context:",
      '  git diff | cc -p "write a commit message"',
      "",
      "Resume a conversation:",
      "  cc --resume                 list recent sessions",
      '  cc --resume -p "and now?"   continue the most recent session',
      '  cc --resume 1a2b3c4d -p "…" continue a session by id (prefix ok)',
    ].join("\n"),
  );
}

/** Read all of stdin when it is piped (not a TTY). Returns "" for an interactive terminal. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    return (await Bun.stdin.text()).trimEnd();
  } catch {
    return "";
  }
}

const SYSTEM_PROMPT = [
  "You are cc, a concise terminal coding agent.",
  "You operate in the user's current working directory and can read, search, and modify files and run shell commands via your tools.",
  "Be direct. Use tools to inspect the project before answering; prefer evidence over assumptions.",
  "When you finish a task, give a short summary of what you did.",
].join("\n");

/** Render a one-line summary per recent session (the `/resume` listing). */
function printSessions(store: SessionStore): void {
  const rows = store.listSessions(20);
  if (rows.length === 0) {
    console.log("cc: no saved sessions yet");
    return;
  }
  console.log("Recent sessions (newest first):\n");
  for (const s of rows) {
    const when = new Date(s.updatedAt).toISOString().replace("T", " ").slice(0, 16);
    const title = s.title ?? "(untitled)";
    const cost = s.costUsd > 0 ? `$${s.costUsd.toFixed(4)}` : "$0";
    console.log(`  ${s.id.slice(0, 8)}  ${when}  ${s.model}  ${cost}  ${title}`);
  }
  console.log('\nResume with:  cc --resume <id> -p "<prompt>"');
}

/** Resolve a session by exact id, then by id prefix among recent sessions. */
function resolveSession(store: SessionStore, idOrPrefix: string): SessionRow | undefined {
  const exact = store.getSession(idOrPrefix);
  if (exact) return exact;
  const matches = store.listSessions(100).filter((s) => s.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Truncate a prompt into a short session title. */
function titleFrom(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** Headless print mode: run the agent loop once over `prompt`, streaming to stdout. */
async function runHeadless(args: Args): Promise<number> {
  // Bare `--resume` with no prompt → list sessions and exit.
  if (args.resume === true && args.prompt === undefined && process.stdin.isTTY) {
    const store = SessionStore.open();
    try {
      printSessions(store);
    } finally {
      store.close();
    }
    return 0;
  }

  const stdin = await readStdin();
  let prompt = args.prompt ?? "";
  if (stdin) {
    prompt = prompt ? `${prompt}\n\n--- stdin ---\n${stdin}` : stdin;
  }
  if (!prompt.trim()) {
    console.error("cc: empty prompt (pass -p \"...\" or pipe stdin)");
    return 1;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const resolved = resolveModel(config, args.model);
  if (!resolved) {
    console.error("cc: no model available; check ~/.cc/config.json providers");
    return 1;
  }

  let provider;
  try {
    provider = createProvider(resolved.providerConfig);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const modelName = resolved.model.name ?? resolved.model.id;
  const tools = args.noTools ? [] : allTools;

  // ── Open the store and resolve which session to write into ──
  const store = SessionStore.open();
  let sessionId: string;
  const messages: Message[] = [];

  if (args.resume) {
    // Resume an explicit id/prefix, or the most recent session for bare --resume.
    const target =
      typeof args.resume === "string"
        ? resolveSession(store, args.resume)
        : store.listSessions(1)[0];
    if (!target) {
      store.close();
      if (typeof args.resume === "string") {
        console.error(`cc: no session matching "${args.resume}"`);
      } else {
        console.error("cc: no sessions to resume");
      }
      return 1;
    }
    sessionId = target.id;
    messages.push(...store.loadMessages(sessionId));
    process.stderr.write(`↻ resuming session ${sessionId.slice(0, 8)} (${messages.length} prior turns)\n`);
  } else {
    sessionId = store.createSession({ model: modelName, cwd: process.cwd(), title: titleFrom(prompt) });
  }

  // Everything already in `messages` is persisted; new entries (the prompt plus
  // each assistant/tool turn the loop appends) get written after the run.
  const persistedCount = messages.length;
  messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
  // Compaction rewrites `messages` in place, invalidating the index-based baseline;
  // when it fires we re-sync the whole transcript instead of appending a tail.
  let compacted = false;

  // Ctrl-C aborts the in-flight request cleanly.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  let sawError = false;
  try {
    for await (const ev of runAgent({
      provider,
      model: modelName,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      compactAtTokens: config.compactAtTokens,
      signal: controller.signal,
    })) {
      switch (ev.type) {
        case "text":
          process.stdout.write(ev.text);
          break;
        case "tool_start":
          process.stderr.write(`\n⚙ ${ev.name} ${JSON.stringify(ev.input)}\n`);
          break;
        case "tool_end":
          if (ev.isError) {
            sawError = true;
            process.stderr.write(`✗ ${ev.name}: ${ev.result}\n`);
          }
          break;
        case "usage":
          store.addUsage(sessionId, ev.inputTokens, ev.outputTokens);
          break;
        case "compaction":
          compacted = true;
          process.stderr.write(
            `\n⌘ compacted context: ${ev.summarized} msgs · ~${ev.beforeTokens}→${ev.afterTokens} tok\n`,
          );
          break;
        case "done":
          process.stdout.write("\n");
          if (ev.reason === "aborted") sawError = true;
          break;
      }
    }
  } catch (err) {
    process.stdout.write("\n");
    console.error(`cc: ${(err as Error).message}`);
    flushTranscript(store, sessionId, messages, persistedCount, compacted);
    store.close();
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }

  flushTranscript(store, sessionId, messages, persistedCount, compacted);
  const finalSession = store.getSession(sessionId);
  if (finalSession) {
    process.stderr.write(
      `\nsession ${sessionId.slice(0, 8)} · ${finalSession.inputTokens}→${finalSession.outputTokens} tok · $${finalSession.costUsd.toFixed(4)}\n`,
    );
  }
  store.close();

  return sawError ? 1 : 0;
}

/**
 * Persist the run's transcript. Normally appends just the messages added since
 * `from`. If compaction rewrote `messages` in place this run, the index baseline
 * is meaningless, so re-sync the whole (compacted) transcript instead.
 */
function flushTranscript(
  store: SessionStore,
  sessionId: string,
  messages: Message[],
  from: number,
  compacted: boolean,
): void {
  if (compacted) {
    store.replaceTurns(sessionId, messages);
    return;
  }
  for (let i = from; i < messages.length; i++) {
    store.appendTurn(sessionId, messages[i]);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }
  if (args.version) {
    console.log("cc 0.0.1");
    return;
  }
  // Headless when a prompt is given, or when --resume is used (with a prompt to
  // continue, or bare to list sessions). The TUI lands in Phase 4.
  if (args.prompt !== undefined || args.resume !== undefined) {
    process.exit(await runHeadless(args));
  }
  // No -p and no TUI yet → show usage.
  printUsage();
}

main();
