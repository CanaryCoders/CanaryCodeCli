#!/usr/bin/env bun

// canarycode — a fast, minimal terminal coding agent.
// Entry point: arg parse + mode dispatch (headless vs TUI).
//
// The headless print path (`canarycode -p "<prompt>"`) runs the shared agent loop once
// and streams the result to stdout, then exits. Piped stdin is folded into the
// prompt as context (`git diff | canarycode -p "commit message"`). Without a prompt,
// the interactive TUI starts instead.

import { type AgentMode, roleForMode, runSession } from "./agent.ts";
import {
  assembleSession,
  availableCommands,
  type ExtensionCommand,
  errorMessage,
  findCommand,
  findCommandAnywhere,
  initExtensions,
  sessionForMode,
  startupExtensions,
} from "./assemble.ts";
import {
  type Config,
  loadConfig,
  modelForRole,
  modelSupportsVision,
  resolveModel,
} from "./config.ts";
import { diffStat, renderDiff } from "./diff.ts";
import { autoAnswer } from "./extensions/askuser.ts";
import {
  describeHooks,
  runSessionEndHooks,
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
} from "./extensions/hooks.ts";
import { statusMark } from "./extensions/tasks.ts";
import {
  appendMentionedFilesToPrompt,
  readMentionedFiles,
} from "./file-mentions.ts";
import { extractImagePaths, readImageFile } from "./image.ts";
import { renderAnsi } from "./markdown.ts";
import type { ContentBlock, Message, Provider } from "./provider.ts";
import { createProvider } from "./provider.ts";
import {
  hasPriceData,
  resolveSession,
  type SessionRow,
  SessionStore,
} from "./session.ts";
import { pickSession } from "./session-picker.ts";
import {
  describeLevel,
  parseLevel,
  resolveThinking,
  supportsThinking,
  type ThinkingLevel,
} from "./thinking.ts";
import { startTui } from "./tui/App.tsx";
import {
  applyUpdate,
  cachedUpdateNotice,
  fetchReleaseNotes,
  refreshUpdateCache,
  updateDisabledReason,
  whatsNewNotice,
} from "./update.ts";
import { VERSION } from "./version.ts";

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
   * `--resume` (interactive: opens the session picker; headless: most recent).
   * Interactive launches resume into the TUI; with -p the run is headless.
   */
  resume?: string | boolean;
  /** -c/--continue: resume the most recent session directly (no picker). */
  continueLatest: boolean;
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
    continueLatest: false,
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
      case "-c":
      case "--continue":
        // Claude Code-style shorthand: continue the most recent session
        // directly, without the `--resume` picker.
        out.continueLatest = true;
        break;
      default:
        // A bare positional after no recognized flag is treated as the prompt.
        if (!a.startsWith("-") && out.prompt === undefined) out.prompt = a;
        break;
    }
  }
  return out;
}

function printUsage(
  extCommands: { name: string; usage?: string; description: string }[],
): void {
  // Subcommand lines for extension commands, aligned like the rest.
  const builtin = extCommands.map((c) => {
    const left = `canarycode ${c.name}${c.usage ? ` ${c.usage}` : ""}`;
    return `  ${left.padEnd(33)}  ${c.description}`;
  });
  console.log(
    [
      "canarycode — minimal AI coding CLI",
      "",
      "Usage:",
      '  canarycode -p "<prompt>"   headless print mode (streams to stdout, exits)',
      "  canarycode                 interactive TUI",
      "",
      "Subcommands:",
      ...builtin,
      "  canarycode update                  update canarycode to the latest release (binary installs)",
      "  canarycode changelog [version]     show release notes (default: this version)",
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
      "  --resume [id]      continue a saved session: bare --resume opens a picker,",
      "                     an id resumes directly; runs headless with -p",
      "  -c, --continue     continue the most recent session (no picker)",
      "  -h, --help         show this help",
      "  --version          show version",
      "",
      "Stdin is folded into the prompt as context:",
      '  git diff | canarycode -p "write a commit message"',
      "",
      "Resume a conversation:",
      "  canarycode --resume                 pick a recent session to reopen in the TUI",
      "  canarycode --resume 1a2b3c4d        reopen a session by id (prefix ok)",
      "  canarycode --continue               reopen the most recent session",
      '  canarycode -c -p "and now?"         continue the most recent session headless',
      "  (inside the TUI, /resume lists sessions and /resume <id> switches)",
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

/** Truncate a prompt into a short session title. */
function titleFrom(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** Headless print mode: run the agent loop once over `prompt`, streaming to stdout. */
async function runHeadless(args: Args): Promise<number> {
  const stdin = await readStdin();
  let prompt = args.prompt ?? "";
  if (stdin) {
    prompt = prompt ? `${prompt}\n\n--- stdin ---\n${stdin}` : stdin;
  }
  if (!prompt.trim()) {
    console.error('canarycode: empty prompt (pass -p "..." or pipe stdin)');
    return 1;
  }

  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  await initExtensions(config, {
    note: (text) => process.stderr.write(`${text}\n`),
  });

  // Warm the update cache in the background (no stdout notice — headless output
  // must stay clean for scripting / --json; the TUI surfaces the notice).
  void refreshUpdateCache(config);

  // Built-in extension startup: each one discovers its provider's models when
  // authenticated (CanaryLLM key, Codex sign-in, opencode credentials) and gates
  // the preset when not, so an unauthenticated launch never offers — or falls
  // back onto — a model that would just error. "live" blocks on the network.
  for (const note of await startupExtensions(config, "live")) {
    process.stderr.write(`${note}\n`);
  }

  // Plan mode runs read-only (investigate, emit a plan, stop); auto mode runs
  // autonomously to completion. They are mutually exclusive — plan wins if both given.
  if (args.plan && args.auto) {
    process.stderr.write(
      "note: --plan and --auto conflict; using --plan (read-only)\n",
    );
  }
  const mode: AgentMode = args.plan ? "plan" : args.auto ? "auto" : "normal";

  // An explicit --model flag wins; otherwise the run uses the model for this
  // mode's role (plan → reasoning, normal/auto → coding).
  const wantedId = args.model ?? modelForRole(config, roleForMode(mode));
  const resolved = resolveModel(config, wantedId);
  if (!resolved) {
    console.error(
      "canarycode: no model available; check ~/.canarycode/config.json providers",
    );
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
  // Turn cap: auto mode uses the configured autonomy budget; otherwise the
  // checkpoint budget as a hard runaway guard (headless is non-interactive, so
  // there's no human to answer a checkpoint). `checkpointEvery: 0` disables the
  // guard rather than capping the run at zero turns. Surfaced in the max_turns
  // message.
  const turnCap =
    mode === "auto"
      ? config.autoMaxTurns
      : config.checkpointEvery > 0
        ? config.checkpointEvery
        : Number.MAX_SAFE_INTEGER;
  // Ctrl-C aborts the in-flight request cleanly. Created early so it can be threaded
  // into sub-agent runs spawned by the spawn_agent tool below.
  const controller = new AbortController();

  // ── Open the store and resolve which session to write into ──
  // Resolved BEFORE assembly so the session id is available to extensions (the
  // hooks extension stamps it into the hook payload). The "no session matching"
  // error path returns before any MCP connection is opened, as it did before.
  const store = SessionStore.open();
  let sessionId: string;
  const messages: Message[] = [];

  const wantsResume = Boolean(args.resume) || args.continueLatest;
  if (wantsResume) {
    // Resume an explicit id/prefix, or the most recent session for a bare
    // --resume/--continue (headless has no picker).
    const target =
      typeof args.resume === "string"
        ? resolveSession(store, args.resume)
        : store.listSessions(1)[0];
    if (!target) {
      store.close();
      if (typeof args.resume === "string") {
        console.error(`canarycode: no session matching "${args.resume}"`);
      } else {
        console.error("canarycode: no sessions to resume");
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

  const hookContext = { sessionId, cwd: process.cwd() };
  if (config.hooks.SessionStart?.length) {
    await runSessionStartHooks(
      config.hooks,
      wantsResume ? "resume" : "startup",
      hookContext,
    );
  }
  if (config.hooks.UserPromptSubmit?.length) {
    await runUserPromptSubmitHooks(config.hooks, prompt, hookContext);
  }

  // ── Assemble the session: tools, system prompt, hooks, MCP cleanup ──
  // Every capability is an Extension (see src/assemble.ts). Startup notes route
  // to stderr (clean stdout for scripting); headless answers ask_user by
  // auto-picking each question's recommended option and renders the task list as a
  // compact stderr checklist.
  // Assembly is mode-independent; the per-turn view for this run's actual
  // `mode` is derived below via sessionForMode. Headless runs a single fixed
  // mode, but routing both frontends through the same path keeps plan
  // filtering / the mode suffix / auto's gate skip in exactly one place.
  const session = await assembleSession({
    config,
    provider,
    model: modelName,
    sessionId,
    signal: controller.signal,
    // Headless has no human to escalate an "unsafe" verdict to, so no frontend
    // confirm gate; assembleSession builds the AI permission gate from config.
    noTools: args.noTools,
    note: (text) => process.stderr.write(`${text}\n`),
    askUser: async (questions) => autoAnswer(questions),
    onTasks: (list) => {
      const lines = list
        .map((t) => `  ${statusMark(t.status, config)} ${t.content}`)
        .join("\n");
      process.stderr.write(`\n≡ tasks:\n${lines}\n`);
    },
  });
  const { tools, system, gate } = sessionForMode(session, mode);
  const compactResolved = resolveModel(config, modelForRole(config, "compact"));
  const compactProvider = compactResolved
    ? createProvider(compactResolved.providerConfig)
    : provider;
  const compactModel = compactResolved
    ? (compactResolved.model.name ?? compactResolved.model.id)
    : modelName;
  if (mode === "plan") process.stderr.write("≡ plan mode (read-only)\n");
  if (mode === "auto")
    process.stderr.write(`◉ auto mode (autonomous · max ${turnCap} turns)\n`);

  // ── resolve the thinking level (explicit flag wins, else a prompt keyword) ──
  const thinking = resolveThinking({ flag: args.think, prompt });
  let thinkingBudget = thinking.budget;
  if (thinkingBudget > 0 && !supportsThinking(provider.id)) {
    process.stderr.write(
      `note: ${modelName} (${provider.id}) does not support extended thinking; ignoring ${describeLevel(thinking.level)}\n`,
    );
    thinkingBudget = 0;
  } else if (thinkingBudget > 0) {
    process.stderr.write(`✻ ${describeLevel(thinking.level)}\n`);
  }

  // Everything already in `messages` is persisted; new entries (the prompt plus
  // each assistant/tool turn the loop appends) get written after the run.
  const persistedCount = messages.length;
  const mentioned = await readMentionedFiles(prompt);
  for (const err of mentioned.errors)
    process.stderr.write(`note: couldn't read @mentioned file ${err}\n`);
  const modelPrompt = appendMentionedFilesToPrompt(prompt, mentioned.files);
  // Attach any image files referenced in the prompt, for vision-capable models.
  const supportsVision = modelSupportsVision(resolved.model);
  const promptContent: ContentBlock[] = [{ type: "text", text: modelPrompt }];
  const promptImagePaths = extractImagePaths(prompt);
  if (promptImagePaths.length) {
    if (!supportsVision) {
      process.stderr.write(
        `note: ${modelName} can't view images; ignoring ${promptImagePaths.length} image(s)\n`,
      );
    } else {
      for (const p of promptImagePaths) {
        try {
          const img = await readImageFile(p);
          promptContent.push({
            type: "image",
            mediaType: img.mediaType,
            data: img.data,
          });
        } catch (err) {
          process.stderr.write(
            `note: couldn't attach ${p}: ${(err as Error).message}\n`,
          );
        }
      }
    }
  }
  messages.push({ role: "user", content: promptContent });
  // Compaction rewrites `messages` in place, invalidating the index-based baseline;
  // when it fires we re-sync the whole transcript instead of appending a tail.
  let compacted = false;

  // Ctrl-C aborts the in-flight request cleanly (controller created above).
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  let sawError = false;
  let doneReason = "stop";
  let caughtError = false;
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
  // PreToolUse/PostToolUse are now composed by the session's hooks extension;
  // the Stop/SessionStart/SessionEnd hooks still fire from runHeadless directly.
  const hooksNote = describeHooks(config.hooks);
  if (hooksNote) process.stderr.write(`${hooksNote}\n`);

  try {
    for await (const ev of runSession({
      provider,
      model: modelName,
      system,
      messages,
      tools,
      mode,
      supportsVision,
      maxTurns: turnCap,
      thinkingBudget,
      compactAtTokens: config.compactAtTokens,
      compactProvider,
      compactModel,
      signal: controller.signal,
      gate,
      preToolUse: session.preToolUse,
      postToolUse: session.postToolUse,
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
            process.stderr.write("\n✻ \x1b[2m");
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
          doneReason = ev.reason;
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
              `▲ stopped after ${turnCap} turns (the turn limit) before the model signalled it was done.\n`,
            );
          }
          break;
      }
    }
  } catch (err) {
    caughtError = true;
    doneReason = "error";
    if (jsonMode) {
      emit({ type: "error", message: (err as Error).message });
    } else {
      closeThinking();
      flushMarkdown();
      process.stdout.write("\n");
    }
    console.error(`canarycode: ${(err as Error).message}`);
    sawError = true;
  } finally {
    process.off("SIGINT", onSigint);
    // Stop/session-end hooks fire during every headless shutdown path, including
    // errors and aborts, before resources are closed.
    if (config.hooks.Stop?.length) {
      await runStopHooks(config.hooks, { ...hookContext, reason: doneReason });
    }
    if (config.hooks.SessionEnd?.length) {
      await runSessionEndHooks(config.hooks, {
        ...hookContext,
        reason: doneReason,
      });
    }
    flushTranscript(store, sessionId, messages, persistedCount, compacted);
    if (!caughtError) {
      const finalSession = store.getSession(sessionId);
      if (finalSession) {
        const cost = hasPriceData(finalSession.model)
          ? ` · $${finalSession.costUsd.toFixed(4)}`
          : "";
        process.stderr.write(
          `\nsession ${sessionId.slice(0, 8)} · ${finalSession.inputTokens}→${finalSession.outputTokens} tok${cost}\n`,
        );
      }
    }
    store.close();
    await session.dispose();
  }

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
 * Interactive TUI mode. Assembles the same engine pieces as headless —
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
  // User-extension loading runs BEFORE the TUI mounts: Bun's global confirm() is a
  // synchronous y/n on the launching terminal, which is exactly where a trust
  // decision for project extensions belongs. Loader notes surface as startup
  // scrollback items below.
  const extensionNotes: string[] = [];
  await initExtensions(config, {
    note: (text) => extensionNotes.push(text),
    confirm: async ({ name, path, changed }) =>
      confirm(
        changed
          ? `canarycode: project extension "${name}" (${path}) CHANGED since you approved it — load the new version?`
          : `canarycode: load project extension "${name}" from ${path}?`,
      ),
  });

  // Built-in extension startup (see runHeadless). "fast" favors cached catalogs
  // (a file read) so the TUI paints without waiting on network fetches; stale
  // caches refresh in the background. A successful in-session `/login-<ext>`
  // re-discovers the models live.
  const builtinNotes = await startupExtensions(config, "fast");

  // ── resume: resolve the target session before any UI mounts ──
  const store = SessionStore.open();
  let resumedSession: SessionRow | undefined;
  let resumedMessages: Message[] | undefined;
  if (typeof args.resume === "string") {
    const target = resolveSession(store, args.resume);
    if (!target) {
      store.close();
      console.error(`canarycode: no session matching "${args.resume}"`);
      return 1;
    }
    resumedSession = target;
  } else if (args.continueLatest) {
    // -c/--continue: straight to the most recent session, no picker.
    const target = store.listSessions(1)[0];
    if (!target) {
      store.close();
      console.error("canarycode: no sessions to resume");
      return 1;
    }
    resumedSession = target;
  } else if (args.resume === true) {
    // Bare `--resume`: open the interactive picker over recent sessions
    // (most recent preselected at the top).
    const rows = store.listSessions(15);
    if (rows.length === 0) {
      store.close();
      console.error("canarycode: no sessions to resume");
      return 1;
    }
    const picked = await pickSession(rows);
    if (!picked) {
      store.close();
      console.log("canarycode: resume cancelled");
      return 0;
    }
    resumedSession = picked;
  }
  if (resumedSession) {
    resumedMessages = store.loadMessages(resumedSession.id);
  }

  // An explicit --model wins; otherwise a resumed session restores its model
  // (when it still resolves), and a fresh launch uses the configured default.
  const resolved = resolveModel(config, args.model ?? resumedSession?.model);
  if (!resolved) {
    store.close();
    console.error(
      "canarycode: no model available; check ~/.canarycode/config.json providers",
    );
    return 1;
  }

  let provider: Provider;
  try {
    provider = createProvider(resolved.providerConfig);
  } catch (err) {
    store.close();
    console.error((err as Error).message);
    return 1;
  }
  const modelName = resolved.model.name ?? resolved.model.id;
  const modelLabel = resolved.model.id;

  const startupNotes: string[] = [];
  // A newer release seen on a prior run shows immediately (synchronous cache
  // read); the network refresh runs in the background for the next launch.
  const updateNotice = await cachedUpdateNotice(config);
  if (updateNotice) startupNotes.push(updateNotice);
  // First launch after an update lands: point at /changelog once.
  const whatsNew = await whatsNewNotice();
  if (whatsNew) startupNotes.push(whatsNew);
  void refreshUpdateCache(config);
  startupNotes.push(...extensionNotes, ...builtinNotes);

  // Tools, system prompt (project memory + skills/agents/feature sections), the
  // approval gate, lifecycle hooks, and the MCP lifecycle are all assembled
  // through the shared extension kernel — but INSIDE the TUI session machine,
  // AFTER first paint (see App → session.startSession), so a slow MCP server
  // never blocks the launch. The context/skills/agents/mcp notes those extensions
  // emit therefore arrive in the scrollback once assembly runs, not here.
  const hooksNote = describeHooks(config.hooks);
  if (hooksNote) startupNotes.push(hooksNote);

  // Assembly (and its MCP connect) is deferred; show a "connecting…" line up front
  // so the gap is explained — a prompt sent in those first seconds queues behind
  // assembly readiness rather than running with an incomplete tool set.
  const mcpServerCount = Object.keys(config.mcpServers).length;
  if (!args.noTools && mcpServerCount > 0) {
    startupNotes.push(
      `⌁ mcp: connecting to ${mcpServerCount} server${mcpServerCount === 1 ? "" : "s"}…`,
    );
  }

  // Thinking level persists in config (the user's default); an explicit `--think`
  // flag overrides it for this launch. A resumed session restores its own
  // last-active thinking level and mode.
  const initialThinking: ThinkingLevel =
    parseLevel(args.think) ??
    parseLevel(resumedSession?.thinking ?? undefined) ??
    config.thinking;
  const initialMode: AgentMode | undefined =
    resumedSession?.mode === "normal" ||
    resumedSession?.mode === "plan" ||
    resumedSession?.mode === "auto"
      ? resumedSession.mode
      : undefined;

  // Resume reuses the saved session row (new turns append to it); a fresh
  // launch creates a new one.
  const sessionId =
    resumedSession?.id ??
    store.createSession({
      model: modelName,
      cwd: process.cwd(),
      thinking: initialThinking,
    });
  if (config.hooks.SessionStart?.length) {
    await runSessionStartHooks(
      config.hooks,
      resumedSession ? "resume" : "startup",
      {
        sessionId,
        cwd: process.cwd(),
      },
    );
  }

  // The launch banner (in the TUI) shows app/version/cwd/model — keep the startup
  // notes to the /help hint plus context/skills/mcp lines.
  startupNotes.unshift("type /help for commands");
  if (resumedSession) {
    startupNotes.push(
      `↻ resumed session ${sessionId.slice(0, 8)} (${resumedMessages?.length ?? 0} prior messages)`,
    );
  }

  startTui({
    config,
    provider,
    modelName,
    modelLabel,
    version: VERSION,
    store,
    sessionId,
    noTools: args.noTools,
    initialMode,
    initialThinking,
    resumedMessages,
    startupNotes,
  });
  return 0;
}

/** Run an extension command (`canarycode login-codex`, …) as a CLI subcommand:
 * console output, prompt() for manual paste flows. */
async function runExtensionCli(
  config: Config,
  cmd: ExtensionCommand,
  rest: string[],
): Promise<number> {
  try {
    await cmd.run(
      {
        config,
        note: (text) => console.log(text),
        readLine: async () => prompt("> ") ?? "",
      },
      rest,
    );
    return 0;
  } catch (err) {
    console.error(`canarycode ${cmd.name} failed: ${errorMessage(err)}`);
    return 1;
  }
}

/** The extension commands /help and usage should list — config-aware, but a
 * broken config must not break `canarycode --help`. */
async function usageCommands(): Promise<
  { name: string; usage?: string; description: string }[]
> {
  try {
    const config = await loadConfig();
    await initExtensions(config, { note: () => {} });
    return availableCommands(config);
  } catch {
    return [];
  }
}

/**
 * Try argv[0] as an extension subcommand. Returns an exit code when it was
 * one (including the disabled-extension error), or undefined to fall through
 * and treat the word as a prompt.
 */
async function tryExtensionSubcommand(
  word: string,
  rest: string[],
): Promise<number | undefined> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    // A broken config blocks every run path (command or prompt alike).
    console.error((err as Error).message);
    return 1;
  }
  await initExtensions(config, {
    note: (text) => process.stderr.write(`${text}\n`),
  });
  const cmd = findCommand(config, word);
  if (cmd) return runExtensionCli(config, cmd, rest);
  const owner = findCommandAnywhere(word);
  if (owner) {
    console.error(
      `canarycode: "${word}" belongs to the disabled extension "${owner.extension.name}" — enable it with /extensions in the TUI, or set {"extensions":{"${owner.extension.name}":true}} in ~/.canarycode/config.json`,
    );
    return 1;
  }
  return undefined;
}

/**
 * `canarycode update` — check GitHub releases and, if newer, download + verify + swap the
 * running binary. No-ops with a clear message when self-update is unavailable
 * (source run, Nix install, non-writable dir, or disabled in config).
 */
async function runUpdate(): Promise<number> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const reason = updateDisabledReason(config);
  if (reason) {
    console.error(`canarycode update: unavailable — ${reason}`);
    return 1;
  }
  const result = await applyUpdate(config, (msg) => console.log(`  ${msg}`));
  console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
  return result.ok ? 0 : 1;
}

/**
 * `canarycode changelog [version]` — print a release's notes. Bare asks for the running
 * version and falls back to the latest release (covers source runs whose
 * version was never published); an explicit version must exist.
 */
async function runChangelog(version?: string): Promise<number> {
  const result =
    (await fetchReleaseNotes(version ?? VERSION)) ??
    (version ? null : await fetchReleaseNotes());
  if (!result) {
    console.error(
      version
        ? `canarycode changelog: no release notes found for ${version}`
        : "canarycode changelog: no release notes available (couldn't reach GitHub releases)",
    );
    return 1;
  }
  console.log(`canarycode ${result.version}\n\n${result.notes.trim()}`);
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "update") {
    process.exit(await runUpdate());
  }
  if (argv[0] === "changelog") {
    process.exit(await runChangelog(argv[1]));
  }
  // A bare first word may be an extension subcommand (login-codex, …);
  // resolving it needs config, since disabled extensions expose nothing.
  if (argv[0] && !argv[0].startsWith("-")) {
    const handled = await tryExtensionSubcommand(argv[0], argv.slice(1));
    if (handled !== undefined) process.exit(handled);
  }
  const args = parseArgs(argv);

  if (args.help) {
    printUsage(await usageCommands());
    return;
  }
  if (args.version) {
    console.log(`canarycode ${VERSION}`);
    return;
  }
  // Headless when a prompt is given (resume included), or when --resume is used
  // without a terminal (the prompt then comes from piped stdin). An interactive
  // `canarycode --resume [id]` with no prompt reopens the session in the TUI instead.
  if (
    args.prompt !== undefined ||
    ((args.resume !== undefined || args.continueLatest) && !process.stdin.isTTY)
  ) {
    process.exit(await runHeadless(args));
  }
  // No prompt + an interactive terminal → launch the TUI (resuming when asked).
  // Without a TTY (piped with no prompt) there's nothing to do, so show usage.
  if (process.stdin.isTTY) {
    const code = await runTui(args);
    if (code !== 0) process.exit(code);
    return;
  }
  printUsage(await usageCommands());
}

main();
