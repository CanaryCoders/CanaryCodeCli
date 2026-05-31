#!/usr/bin/env bun

// cc — a fast, minimal terminal coding agent.
// Entry point: arg parse + mode dispatch (headless vs TUI).
//
// Phase 1 ships the headless print path: `cc -p "<prompt>"` runs the shared
// agent loop once and streams the result to stdout, then exits. Piped stdin is
// folded into the prompt as context (`git diff | cc -p "commit message"`). The
// interactive TUI lands in Phase 4.

import { type AgentMode, runAgent, systemForMode } from "./agent.ts";
import {
  composeAgentsPrompt,
  describeAgents,
  discoverAgents,
} from "./agents.ts";
import { askUserTool, autoAnswer } from "./askuser.ts";
import { describeCanary, populateCanaryModels } from "./canary.ts";
import { type Config, loadConfig, resolveModel } from "./config.ts";
import {
  composeSystemPrompt,
  describeContext,
  loadProjectContext,
} from "./context.ts";
import { diffStat, renderDiff } from "./diff.ts";
import {
  describeHooks,
  runPostToolHooks,
  runPreToolHooks,
  runStopHooks,
} from "./hooks.ts";
import { renderAnsi } from "./markdown.ts";
import {
  closeMcp,
  connectMcpServers,
  describeMcp,
  type McpConnection,
} from "./mcp.ts";
import { checkCommandSafety, inPermissionScope } from "./permission.ts";
import type { Message, Provider } from "./provider.ts";
import { createProvider } from "./provider.ts";
import { type SessionRow, SessionStore } from "./session.ts";
import {
  composeSkillsPrompt,
  describeSkills,
  discoverSkills,
  readSkillTool,
} from "./skills.ts";
import { Semaphore, spawnAgentTool } from "./subagents.ts";
import {
  describeLevel,
  parseLevel,
  resolveThinking,
  supportsThinking,
  type ThinkingLevel,
} from "./thinking.ts";
import { tools as allTools } from "./tools.ts";
import { startTui } from "./tui/App.tsx";
import { webSearchTool } from "./websearch.ts";

/** App version, shown by `--version` and in the TUI launch banner. */
const VERSION = "0.0.1";

interface Args {
  help: boolean;
  version: boolean;
  /** The prompt passed via -p/--print, or undefined for interactive mode. */
  prompt?: string;
  /** --no-tools: run read-only with the tool set withheld entirely. */
  noTools: boolean;
  /** --no-color: force raw markdown to stdout even on a TTY (also honoured: NO_COLOR). */
  noColor: boolean;
  /** --json: emit one structured JSON event per line on stdout (for scripting). */
  json: boolean;
  /** --plan: read-only planning mode — investigate, emit a structured plan, stop. */
  plan: boolean;
  /** --auto (alias --yolo): autonomous multi-turn execution, capped at autoMaxTurns. */
  auto: boolean;
  /** --model <id>: override the configured model. */
  model?: string;
  /** --think <level>: off | think | think-hard | ultrathink (aliases accepted). */
  think?: string;
  /**
   * --resume: a session id (or id prefix) to continue, or `true` for a bare
   * `--resume` (resume the most recent session, or list sessions if no prompt).
   */
  resume?: string | boolean;
}

/** Parse argv into a small, explicit shape. Unknown flags are ignored for now. */
function parseArgs(argv: string[]): Args {
  const out: Args = {
    help: false,
    version: false,
    noTools: false,
    noColor: false,
    json: false,
    plan: false,
    auto: false,
  };
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
      case "--no-color":
        out.noColor = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--plan":
        out.plan = true;
        break;
      case "--auto":
      case "--yolo":
        out.auto = true;
        break;
      case "--model":
        out.model = argv[++i];
        break;
      case "--think":
        // An optional level may follow; a bare `--think` means the default level.
        out.think =
          argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")
            ? argv[++i]
            : "think";
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
      "  cc                 interactive TUI (Ink)",
      "",
      "Flags:",
      "  -p, --print <s>    run a single prompt headless",
      "  --model <id>       override the configured model",
      "  --think [level]    extended thinking: off | think | think-hard | ultrathink",
      "                     (also triggered by a keyword in the prompt)",
      "  --plan             planning mode: investigate read-only, emit a plan, stop",
      "  --auto, --yolo     autonomous mode: run to completion, no confirmations,",
      "                     capped at autoMaxTurns (default 25)",
      "  --no-tools         disable tools (read-only quick Q&A)",
      "  --no-color         raw markdown to stdout even on a TTY (also: NO_COLOR)",
      "  --json             stream structured JSON events (JSONL) on stdout",
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
  "",
  "ALWAYS end your turn with a recap once you have finished working (i.e. your final reply that makes no further tool calls). Never stop after a tool call without a closing message. The recap is mandatory — even for small tasks or when nothing changed. Format it exactly as:",
  "",
  "## Recap",
  "- <what you did, one bullet per change or finding>",
  "",
  "Keep it short: list files touched and the key changes, plus anything the user should know (follow-ups, caveats, how to verify). If the task produced no changes, say so explicitly.",
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
    const when = new Date(s.updatedAt)
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
    const title = s.title ?? "(untitled)";
    const cost = s.costUsd > 0 ? `$${s.costUsd.toFixed(4)}` : "$0";
    console.log(
      `  ${s.id.slice(0, 8)}  ${when}  ${s.model}  ${cost}  ${title}`,
    );
  }
  console.log('\nResume with:  cc --resume <id> -p "<prompt>"');
}

/** Resolve a session by exact id, then by id prefix among recent sessions. */
function resolveSession(
  store: SessionStore,
  idOrPrefix: string,
): SessionRow | undefined {
  const exact = store.getSession(idOrPrefix);
  if (exact) return exact;
  const matches = store
    .listSessions(100)
    .filter((s) => s.id.startsWith(idOrPrefix));
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
  if (
    args.resume === true &&
    args.prompt === undefined &&
    process.stdin.isTTY
  ) {
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
    console.error('cc: empty prompt (pass -p "..." or pipe stdin)');
    return 1;
  }

  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  // Discover CanaryLLM models when the preset is active (CANARYLLM_API_KEY set),
  // so `--model <id>` resolves. Best-effort: failures leave it inert.
  const canaryNote = describeCanary(await populateCanaryModels(config));
  if (canaryNote) process.stderr.write(`${canaryNote}\n`);

  const resolved = resolveModel(config, args.model);
  if (!resolved) {
    console.error("cc: no model available; check ~/.cc/config.json providers");
    return 1;
  }

  let provider: Provider;
  try {
    provider = createProvider(resolved.providerConfig);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const modelName = resolved.model.name ?? resolved.model.id;
  // Plan mode runs read-only (investigate, emit a plan, stop); auto mode runs
  // autonomously to completion. They are mutually exclusive — plan wins if both given.
  if (args.plan && args.auto) {
    process.stderr.write(
      "note: --plan and --auto conflict; using --plan (read-only)\n",
    );
  }
  const mode: AgentMode = args.plan ? "plan" : args.auto ? "auto" : "normal";
  // Turn cap: auto mode uses the configured autonomy budget; otherwise the
  // checkpoint budget as a hard runaway guard (headless is non-interactive, so
  // there's no human to answer a checkpoint). Surfaced in the max_turns message.
  const turnCap =
    mode === "auto" ? config.autoMaxTurns : config.checkpointEvery;
  // Ctrl-C aborts the in-flight request cleanly. Created early so it can be threaded
  // into sub-agent runs spawned by the spawn_agent tool below.
  const controller = new AbortController();

  // Discover skills (global ~/.cc/skills + project ./.cc/skills). Only their
  // name+description go into the prompt; bodies load on demand via read_skill.
  const skills = await discoverSkills();
  const skillsNote = describeSkills(skills);
  if (skillsNote) process.stderr.write(`${skillsNote}\n`);

  // Discover custom agents (global ~/.cc/agents + project ./.cc/agents). Their
  // name+description go into the prompt; spawn_agent dispatches to them by name.
  const agents = await discoverAgents();
  const agentsNote = describeAgents(agents);
  if (agentsNote) process.stderr.write(`${agentsNote}\n`);

  // Connect MCP servers (stdio + SSE) and merge their namespaced tools. A server
  // that fails to connect is noted and skipped — the agent runs without it.
  const mcp: McpConnection = args.noTools
    ? { tools: [], clients: [], notes: [] }
    : await connectMcpServers(config.mcpServers);
  const mcpNote = describeMcp(mcp, Object.keys(config.mcpServers).length);
  if (mcpNote) process.stderr.write(`${mcpNote}\n`);

  // web_search is built from config (backend + key) and joins the static tool set.
  // read_skill (read-only) lets the model pull a skill's full instructions on
  // demand. MCP tools (namespaced `mcp__<server>__<tool>`) merge in too. In plan
  // mode the loop gates non-read-only tools, but we also withhold them from the
  // model entirely so it only sees what it can actually use.
  let tools = args.noTools
    ? []
    : [
        ...allTools,
        webSearchTool(config.webSearch),
        readSkillTool(skills),
        // Headless has no interactive prompt — auto-answer each ask_user question
        // with its recommended option so a call resolves instead of hanging.
        askUserTool(async (questions) => autoAnswer(questions)),
        ...mcp.tools,
      ];
  // spawn_agent lets the model delegate focused sub-tasks to child agents with a
  // fresh context. Added only when sub-agents are enabled (maxDepth > 0); it is
  // mutating, so the plan-mode filter below drops it. The inherited tool set is the
  // base tools (children get their own nested spawn_agent up to the depth cap).
  if (!args.noTools && config.maxDepth > 0) {
    const limiter = new Semaphore(config.maxConcurrent);
    tools = [
      ...tools,
      spawnAgentTool({
        config,
        parentProvider: provider,
        parentModel: modelName,
        inheritedTools: tools,
        depth: 0,
        limiter,
        signal: controller.signal,
        agents,
      }),
    ];
  }
  if (mode === "plan") tools = tools.filter((t) => t.readOnly);
  // Project memory (CC.md > AGENTS.md > CLAUDE.md, nearest dir first) is prepended
  // to the base prompt before the mode-specific rules are appended.
  const projectContext = await loadProjectContext();
  const contextNote = describeContext(projectContext);
  if (contextNote) process.stderr.write(`${contextNote}\n`);
  const system = systemForMode(
    composeAgentsPrompt(
      composeSkillsPrompt(
        composeSystemPrompt(SYSTEM_PROMPT, projectContext),
        skills,
      ),
      agents,
    ),
    mode,
  );
  if (mode === "plan") process.stderr.write("📋 plan mode (read-only)\n");
  if (mode === "auto")
    process.stderr.write(`🤖 auto mode (autonomous · max ${turnCap} turns)\n`);

  // ── resolve the thinking level (explicit flag wins, else a prompt keyword) ──
  const thinking = resolveThinking({ flag: args.think, prompt });
  let thinkingBudget = thinking.budget;
  if (thinkingBudget > 0 && !supportsThinking(provider.id)) {
    process.stderr.write(
      `note: ${modelName} (${provider.id}) does not support extended thinking; ignoring ${describeLevel(thinking.level)}\n`,
    );
    thinkingBudget = 0;
  } else if (thinkingBudget > 0) {
    process.stderr.write(`💭 ${describeLevel(thinking.level)}\n`);
  }

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
    process.stderr.write(
      `↻ resuming session ${sessionId.slice(0, 8)} (${messages.length} prior turns)\n`,
    );
  } else {
    sessionId = store.createSession({
      model: modelName,
      cwd: process.cwd(),
      title: titleFrom(prompt),
    });
  }

  // Everything already in `messages` is persisted; new entries (the prompt plus
  // each assistant/tool turn the loop appends) get written after the run.
  const persistedCount = messages.length;
  messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
  // Compaction rewrites `messages` in place, invalidating the index-based baseline;
  // when it fires we re-sync the whole transcript instead of appending a tail.
  let compacted = false;

  // Ctrl-C aborts the in-flight request cleanly (controller created above).
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  let sawError = false;
  // --json: emit one structured event per line on stdout so scripts can consume the
  // run (text, thinking, tool_start/tool_end, usage, compaction, done). Human-facing
  // formatting (markdown, the ⚙/✓ tool lines, diffs) is suppressed on stdout; the
  // raw JSONL is the whole output. Startup notes still go to stderr (separate stream).
  const jsonMode = args.json;
  const emit = (obj: unknown) =>
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  // Tracks an open (unclosed) dimmed thinking block on stderr so we can reset it
  // before any non-thinking output.
  let thinkingOpen = false;
  const closeThinking = () => {
    if (thinkingOpen) {
      process.stderr.write("\x1b[0m\n");
      thinkingOpen = false;
    }
  };
  // Assistant text is markdown. On a colour-capable TTY we buffer each turn's text
  // and render it as ANSI styling once the turn's deltas have all arrived (markdown
  // needs whole blocks; streaming char-by-char can't style). Piped output (not a
  // TTY), NO_COLOR, or --no-color keep the raw markdown streaming so it composes.
  const renderMd =
    !jsonMode &&
    Boolean(process.stdout.isTTY) &&
    !process.env.NO_COLOR &&
    !args.noColor;
  let mdBuf = "";
  const flushMarkdown = () => {
    if (mdBuf) {
      process.stdout.write(renderMd ? renderAnsi(mdBuf) : mdBuf);
      mdBuf = "";
    }
  };
  // ── lifecycle hooks (PreToolUse can block; PostToolUse/Stop observe) ──
  const hooksNote = describeHooks(config.hooks);
  if (hooksNote) process.stderr.write(`${hooksNote}\n`);
  const preToolUse = config.hooks.PreToolUse?.length
    ? (call: { name: string; input: unknown }) =>
        runPreToolHooks(config.hooks, call)
    : undefined;
  const postToolUse = config.hooks.PostToolUse?.length
    ? (
        call: { name: string; input: unknown },
        result: { content: string; isError: boolean },
      ) => runPostToolHooks(config.hooks, call, result)
    : undefined;

  // ── AI permission gate ──
  // The human confirm box is a TUI-only affordance, so headless has no one to
  // escalate an "unsafe" verdict to: here an unsafe call is blocked outright and
  // the model is told why. Auto/`--yolo` skips the gate entirely (run everything).
  let gate:
    | ((call: { name: string; input: unknown }) => Promise<{
        allow: boolean;
        reason?: string;
      }>)
    | undefined;
  if (mode !== "auto" && config.permission.mode === "ai") {
    const permResolved = resolveModel(config, config.permission.model);
    if (!permResolved) {
      process.stderr.write(
        `note: permission model "${config.permission.model}" not found; AI safety check disabled\n`,
      );
    } else {
      try {
        const checkerProvider = createProvider(permResolved.providerConfig);
        const checkerModel = permResolved.model.name ?? permResolved.model.id;
        process.stderr.write(`🛡 AI permission check (${checkerModel})\n`);
        gate = async (call) => {
          if (!inPermissionScope(config.permission.scope, call.name)) {
            return { allow: true };
          }
          const v = await checkCommandSafety(
            checkerProvider,
            checkerModel,
            call,
            controller.signal,
          );
          if (v.safe) return { allow: true };
          return {
            allow: false,
            reason: `blocked by AI safety check: ${v.reason}`,
          };
        };
      } catch (err) {
        process.stderr.write(
          `note: AI safety check disabled: ${(err as Error).message}\n`,
        );
      }
    }
  }

  try {
    for await (const ev of runAgent({
      provider,
      model: modelName,
      system,
      messages,
      tools,
      mode,
      maxTurns: turnCap,
      thinkingBudget,
      compactAtTokens: config.compactAtTokens,
      signal: controller.signal,
      gate,
      preToolUse,
      postToolUse,
    })) {
      switch (ev.type) {
        case "text":
          if (jsonMode) {
            emit({ type: "text", text: ev.text });
            break;
          }
          closeThinking();
          // Render mode buffers the turn's text (flushed at turn_end); raw mode
          // streams each delta immediately so piped output stays live.
          if (renderMd) mdBuf += ev.text;
          else process.stdout.write(ev.text);
          break;
        case "thinking":
          if (jsonMode) {
            emit({ type: "thinking", text: ev.text });
            break;
          }
          // Stream reasoning to stderr (dimmed) so it stays out of stdout output.
          if (!thinkingOpen) {
            process.stderr.write("\n💭 \x1b[2m");
            thinkingOpen = true;
          }
          process.stderr.write(ev.text);
          break;
        case "turn_end":
          // The turn's assistant text is complete — render the buffered markdown.
          if (!jsonMode) flushMarkdown();
          break;
        case "tool_start":
          // The exact tool call before it runs — full input, so the user (or a
          // script under --json) can see precisely what is about to execute.
          if (jsonMode) {
            emit({
              type: "tool_start",
              id: ev.id,
              name: ev.name,
              input: ev.input,
            });
            break;
          }
          closeThinking();
          process.stderr.write(`\n⚙ ${ev.name} ${JSON.stringify(ev.input)}\n`);
          break;
        case "tool_end":
          if (jsonMode) {
            if (ev.isError) sawError = true;
            emit({
              type: "tool_end",
              id: ev.id,
              name: ev.name,
              isError: ev.isError,
              result: ev.result,
              ...(ev.diff ? { diff: diffStat(ev.diff) } : {}),
            });
            break;
          }
          // The exit line after the call completes (✓ ok / ✗ error), mirroring the
          // ⚙ start line so every tool run shows a begin and an end.
          if (ev.isError) {
            sawError = true;
            process.stderr.write(`✗ ${ev.name}: ${ev.result}\n`);
          } else {
            process.stderr.write(`✓ ${ev.name}\n`);
            if (ev.diff && ev.diff.hunks.length > 0) {
              // write_file/edit_file carry a diff — show what changed (green/red on a TTY).
              const color =
                Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
              process.stderr.write(
                `${renderDiff(ev.diff, { color, maxLines: 60 })}\n`,
              );
            }
          }
          break;
        case "usage":
          if (jsonMode)
            emit({
              type: "usage",
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
            });
          store.addUsage(sessionId, ev.inputTokens, ev.outputTokens);
          break;
        case "compaction":
          compacted = true;
          if (jsonMode) {
            emit({
              type: "compaction",
              summarized: ev.summarized,
              beforeTokens: ev.beforeTokens,
              afterTokens: ev.afterTokens,
            });
            break;
          }
          process.stderr.write(
            `\n⌘ compacted context: ${ev.summarized} msgs · ~${ev.beforeTokens}→${ev.afterTokens} tok\n`,
          );
          break;
        case "done":
          if (jsonMode) {
            emit({ type: "done", reason: ev.reason });
            if (ev.reason === "aborted" || ev.reason === "max_turns")
              sawError = true;
            break;
          }
          closeThinking();
          flushMarkdown();
          process.stdout.write("\n");
          if (ev.reason === "aborted") {
            sawError = true;
          } else if (ev.reason === "max_turns") {
            // Cap reached before the model finished — the task may be incomplete.
            sawError = true;
            process.stderr.write(
              `⚠ stopped after ${turnCap} turns (the turn limit) before the model signalled it was done.\n`,
            );
          }
          break;
      }
    }
  } catch (err) {
    if (jsonMode) {
      emit({ type: "error", message: (err as Error).message });
    } else {
      closeThinking();
      flushMarkdown();
      process.stdout.write("\n");
    }
    console.error(`cc: ${(err as Error).message}`);
    flushTranscript(store, sessionId, messages, persistedCount, compacted);
    store.close();
    await closeMcp(mcp);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }

  // Stop hooks fire once the run finishes (observational; never block).
  if (config.hooks.Stop?.length) await runStopHooks(config.hooks);

  flushTranscript(store, sessionId, messages, persistedCount, compacted);
  const finalSession = store.getSession(sessionId);
  if (finalSession) {
    process.stderr.write(
      `\nsession ${sessionId.slice(0, 8)} · ${finalSession.inputTokens}→${finalSession.outputTokens} tok · $${finalSession.costUsd.toFixed(4)}\n`,
    );
  }
  store.close();
  await closeMcp(mcp);

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

/**
 * Interactive TUI mode (Ink). Assembles the same engine pieces as headless —
 * config, provider, project context, skills, MCP — then hands them to the App
 * component, which keeps a running session over `runAgent`. Startup notes that the
 * headless path writes to stderr are passed in as scrollback items instead.
 */
async function runTui(args: Args): Promise<number> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const canaryNote = describeCanary(await populateCanaryModels(config));

  const resolved = resolveModel(config, args.model);
  if (!resolved) {
    console.error("cc: no model available; check ~/.cc/config.json providers");
    return 1;
  }

  let provider: Provider;
  try {
    provider = createProvider(resolved.providerConfig);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const modelName = resolved.model.name ?? resolved.model.id;
  const modelLabel = resolved.model.id;

  const startupNotes: string[] = [];
  if (canaryNote) startupNotes.push(canaryNote);

  // Project memory (CC.md > AGENTS.md > CLAUDE.md) + skills fold into the base
  // system prompt; App re-appends the per-mode rules at send time.
  const projectContext = await loadProjectContext();
  const ctxNote = describeContext(projectContext);
  if (ctxNote) startupNotes.push(ctxNote);

  const skills = await discoverSkills();
  const skillsNote = describeSkills(skills);
  if (skillsNote) startupNotes.push(skillsNote);

  const agents = await discoverAgents();
  const agentsNote = describeAgents(agents);
  if (agentsNote) startupNotes.push(agentsNote);

  const hooksNote = describeHooks(config.hooks);
  if (hooksNote) startupNotes.push(hooksNote);

  const mcp: McpConnection = args.noTools
    ? { tools: [], clients: [], notes: [] }
    : await connectMcpServers(config.mcpServers);
  const mcpNote = describeMcp(mcp, Object.keys(config.mcpServers).length);
  if (mcpNote) startupNotes.push(mcpNote);

  const baseSystem = composeAgentsPrompt(
    composeSkillsPrompt(
      composeSystemPrompt(SYSTEM_PROMPT, projectContext),
      skills,
    ),
    agents,
  );

  // Thinking level persists in config (the user's default); an explicit `--think`
  // flag overrides it for this launch without changing the saved default.
  const initialThinking: ThinkingLevel =
    parseLevel(args.think) ?? config.thinking;

  const store = SessionStore.open();
  const sessionId = store.createSession({
    model: modelName,
    cwd: process.cwd(),
    thinking: initialThinking,
  });

  // The launch banner (in the TUI) shows app/version/cwd/model — keep the startup
  // notes to the /help hint plus context/skills/mcp lines.
  startupNotes.unshift("type /help for commands");

  startTui({
    config,
    provider,
    modelName,
    modelLabel,
    version: VERSION,
    baseSystem,
    skills,
    agents,
    mcp,
    store,
    sessionId,
    noTools: args.noTools,
    initialThinking,
    startupNotes,
  });
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }
  if (args.version) {
    console.log(`cc ${VERSION}`);
    return;
  }
  // Headless when a prompt is given, or when --resume is used (with a prompt to
  // continue, or bare to list sessions).
  if (args.prompt !== undefined || args.resume !== undefined) {
    process.exit(await runHeadless(args));
  }
  // No prompt + an interactive terminal → launch the Ink TUI. Without a TTY (piped
  // with no prompt) there's nothing to do, so show usage.
  if (process.stdin.isTTY) {
    const code = await runTui(args);
    if (code !== 0) process.exit(code);
    return;
  }
  printUsage();
}

main();
