// tui/use-agent-session.ts — the TUI's agent-session controller.
//
// This is the engine behind the App shell: it owns the run state (busy, queued,
// metrics, mode/thinking, the task panel) and every action that drives a turn —
// building the tool set, running the agent loop and mirroring its events into the
// transcript, the plan accept/edit/reject flow, model switching, slash-command
// dispatch (`onSubmit`), `/init`, and the shared Ctrl+C / Esc cancel escalation.
//
// Mutable engine state lives in refs (read inside the async loop across awaits);
// React state mirrors what the UI shows. It composes the smaller hooks (transcript,
// approvals, prompt input/history, paste chips) passed in by the App shell.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { useApp } from "ink";
import { useRef, useState } from "react";
import { type AgentMode, roleForMode, runAgent } from "../agent.ts";
import {
  type AssembledSession,
  assembleSession,
  availableCommands,
  extensionEnabled,
  type FrontendGate,
  initExtensions,
  listExtensions,
  runCommand,
  sessionForMode,
  startupExtensions,
  type Task,
} from "../assemble.ts";
import { readClipboardImage } from "../clipboard.ts";
import { type CommandAction, makeCommandSet } from "../commands.ts";
import {
  getRawConfigPath,
  loadConfig,
  modelSupportsVision,
  parseConfigValue,
  redactConfig,
  replaceConfigInPlace,
  resolveModel,
  saveConfig,
  setRawConfigPath,
  summarizeConfig,
  unsetRawConfigPath,
  validateConfigPathValue,
} from "../config.ts";
import {
  runSessionEndHooks,
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
} from "../extensions/hooks.ts";
import { iconFor } from "../icons.ts";
import { extractImagePaths, type ImageData, readImageFile } from "../image.ts";
import type { ContentBlock, Message } from "../provider.ts";
import { createProvider, type Provider } from "../provider.ts";
import { hasPriceData } from "../session.ts";
import {
  budgetFor,
  describeLevel,
  supportsThinking,
  type ThinkingLevel,
} from "../thinking.ts";
import { applyUpdate, updateDisabledReason } from "../update.ts";
import type { AppProps } from "./app-types.ts";
import type { ExtensionToggle } from "./Extensions.tsx";
import { drainInputQuiet, expandPastes } from "./input-helpers.ts";
import type { Item } from "./Message.tsx";
import { stablePrefixLen } from "./message-helpers.ts";
import type { Approvals } from "./use-approvals.ts";
import type { PasteChips } from "./use-paste-chips.ts";
import type { PromptHistory } from "./use-prompt-history.ts";
import type { PromptInput } from "./use-prompt-input.ts";
import type { Transcript } from "./use-transcript.ts";

// `/init` instruction: drives a real generation turn so the agent investigates
// the repo and writes a genuine CC.md instead of a fill-in-the-blanks template.
const INIT_PROMPT = `Create a CC.md file in the current directory — the project-context file cc reads on startup.

First investigate the project: read package manifests (package.json, pyproject.toml, go.mod, Cargo.toml, etc.), config files, the README, and the directory layout to understand what this project is, its stack, and how to build/test/lint/run it.

Then write CC.md with these sections, filled in from what you actually found (omit a section if it genuinely doesn't apply — do not leave placeholder comments):
- # <project name>
- ## Overview — one or two sentences on what the project is and does.
- ## Stack — languages, frameworks, runtimes, key libraries.
- ## Commands — the real build/test/run/lint commands for this repo.
- ## Conventions — code style, patterns, and rules to follow.

Keep it short and high-signal. Use write_file to create ./CC.md.`;

export interface AgentSession {
  busy: boolean;
  queued: string | null;
  tasks: Task[];
  cost: number;
  costKnown: boolean;
  tokens: number;
  modelLabel: string;
  mode: AgentMode;
  thinking: ThinkingLevel;
  verbose: boolean;
  setVerbose: React.Dispatch<React.SetStateAction<boolean>>;
  /** Handle a submitted input line (slash command or prompt). */
  onSubmit: (rawValue: string) => void;
  /** Ctrl+V: attach a clipboard image to the next prompt. */
  attachClipboardImage: () => void;
  /** Cycle the agent mode (Shift+Tab): normal → plan → auto → normal. */
  cycleMode: () => void;
  acceptPlan: () => void;
  editPlan: () => void;
  rejectPlan: () => void;
  /** The shared Ctrl+C / Esc cancel escalation. */
  handleCancel: (label: string) => void;
  /** Assemble the session once, on mount (deferred so a slow MCP server doesn't
   * block first paint). Turns dispatched before this resolves queue behind it. */
  startSession: () => Promise<void>;
  /** The `/extensions` checkbox picker's rows, or null when closed. */
  extensionsPicker: ExtensionToggle[] | null;
  /** Live mirror of `extensionsPicker !== null` for App's key handler. */
  extensionsOpenRef: React.MutableRefObject<boolean>;
  /** Enter in the picker — persist + apply the pending toggle states. */
  applyExtensions: (next: ExtensionToggle[]) => void;
  /** Esc in the picker — close without applying. */
  cancelExtensions: () => void;
}

export function useAgentSession(deps: {
  props: AppProps;
  transcript: Transcript;
  approvals: Approvals;
  promptInput: PromptInput;
  promptHistory: PromptHistory;
  pasteMap: PasteChips["pasteMap"];
  /** Shared abort controller (also read by the approval gate's safety check). */
  controllerRef: React.MutableRefObject<AbortController | null>;
}): AgentSession {
  const { props, transcript, approvals, promptInput, promptHistory, pasteMap } =
    deps;
  const { setHistory, setLive, updateBanner, push, note, nextId } = transcript;
  const { setInput, inputRef, bumpCursor } = promptInput;
  const controllerRef = deps.controllerRef;
  const nerdFont = props.config.ui.nerdFont === true;
  const app = useApp();

  // Mutable engine state lives in refs (read inside async loops); React state
  // mirrors what the UI shows.
  const providerRef = useRef(props.provider);
  const modelNameRef = useRef(props.modelName);
  // The assembled session (tools, system prompt, gate, hooks, MCP lifecycle),
  // built once after first paint by startSession() and held here. Per-turn views
  // (plan filtering, mode suffix, auto's gate skip) are derived via sessionForMode.
  // Null until assembly completes; runTurn awaits assemblyRef before reading it so
  // a prompt sent during the deferred MCP connect simply queues behind readiness.
  const assembledRef = useRef<AssembledSession | null>(null);
  const assemblyRef = useRef<Promise<void> | null>(null);
  // A session-scoped abort signal handed to assembleSession for the AI permission
  // check. Aborted only at shutdown — per-turn aborts use their own controller and
  // the loop ignores a late gate verdict once aborted (the check fails open on abort).
  const sessionAbortRef = useRef(new AbortController());
  // Seed with any resumed transcript; those turns are already stored, so the
  // persist baseline starts past them (only new turns get appended).
  const messagesRef = useRef<Message[]>(props.resumedMessages ?? []);
  const persistedRef = useRef(props.resumedMessages?.length ?? 0);
  const sessionIdRef = useRef(props.sessionId);
  const closedRef = useRef(false);
  const hookContext = () => ({
    sessionId: sessionIdRef.current,
    cwd: process.cwd(),
  });
  // Ctrl+C is "armed" after a first press with nothing to abort; a second press
  // before the timer fires quits. The timer disarms it so a lone press never quits.
  const quitArmedRef = useRef(false);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A prompt typed and submitted while a turn is in flight; it sends automatically
  // once the turn finishes. The ref mirrors state for the `useInput` closure.
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  // Images pasted from the clipboard (Ctrl+V), attached to the next prompt sent.
  const pendingImagesRef = useRef<ImageData[]>([]);
  // The `/extensions` checkbox picker (null = closed). The ref mirrors openness
  // for App's `useInput` closure, like the approvals' pending refs.
  const [extensionsPicker, setExtensionsPicker] = useState<
    ExtensionToggle[] | null
  >(null);
  const extensionsOpenRef = useRef(false);
  // An applyToggles run still persisting/reloading; a reopened picker awaits it
  // so it never snapshots half-applied state.
  const togglesInFlightRef = useRef<Promise<void> | null>(null);

  const [busy, setBusy] = useState(false);
  const [mode, setModeState] = useState<AgentMode>(
    props.initialMode ?? "normal",
  );
  // Mirror of `mode` for long-lived async closures. A turn dispatched from an
  // older render (e.g. a queued prompt sent when the previous turn ends) would
  // otherwise read that render's stale `mode` — after a plan accept it would
  // silently run the next turn in plan mode (read-only tools) while the footer
  // says normal. Always resolve the run mode through this ref.
  const modeRef = useRef(mode);
  const [thinking, setThinkingState] = useState<ThinkingLevel>(
    props.initialThinking ?? "off",
  );
  // Persist mode / thinking onto the session row as they change, so a later
  // `--resume` restores them. Wrappers keep React state + the stored row in sync.
  const setMode = (next: AgentMode) => {
    modeRef.current = next;
    setModeState(next);
    props.store.setMode(sessionIdRef.current, next);
  };
  const setThinking = (next: ThinkingLevel) => {
    setThinkingState(next);
    props.store.setThinking(sessionIdRef.current, next);
    // Persist as the default thinking level so it survives restarts.
    void saveConfig({ thinking: next }).catch((err) =>
      note(
        `could not save thinking preference: ${(err as Error).message}`,
        "error",
      ),
    );
  };
  const [modelLabel, setModelLabel] = useState(props.modelLabel);
  const [cost, setCost] = useState(0);
  const [costKnown, setCostKnown] = useState(hasPriceData(props.modelName));
  const [tokens, setTokens] = useState(0);
  // Verbose expands tool calls to show full input + output head (Ctrl+R toggles).
  const [verbose, setVerbose] = useState(false);
  // The agent's live task list (from the update_tasks tool), shown in the Tasks
  // panel above the input. Ephemeral: it lives only for the session.
  const [tasks, setTasks] = useState<Task[]>([]);

  const hasConversation = () => messagesRef.current.length > 0;

  async function shutdown(reason: string): Promise<void> {
    if (closedRef.current) return;
    closedRef.current = true;
    if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
    try {
      if (props.config.hooks.Stop?.length) {
        await runStopHooks(props.config.hooks, { ...hookContext(), reason });
      }
      if (props.config.hooks.SessionEnd?.length) {
        await runSessionEndHooks(props.config.hooks, {
          ...hookContext(),
          reason,
        });
      }
    } finally {
      props.store.close();
      // Absorb the tail of an Esc/Ctrl+C spam before releasing the tty: while Ink
      // is still mounted the terminal is raw and reads here drain the buffered
      // keystrokes. Without this, the leftovers spill into the parent shell and
      // corrupt its terminal handshake (fish's OSC 11 background probe renders
      // its reply as literal `]11;rgb:…` at the prompt).
      await drainInputQuiet(process.stdin);
      // Unmount Ink first so the terminal is restored to cooked mode immediately,
      // then tear down the rest of the process. `app.exit()` only unmounts the UI —
      // it does NOT end the process, and the live MCP clients (their child
      // processes and sockets) keep the event loop alive, so without an explicit
      // exit the process lingers after the UI is gone: the now-cooked terminal
      // echoes any further keystrokes as raw `^[`/`^C` until a signal kills it.
      app.exit();
      // Abort the session-scoped signal (cancels any in-flight AI permission
      // check) and dispose the assembled session — its dispose() closes MCP
      // transports (killing spawned servers like puppeteer's browser). Capped so a
      // wedged transport can't block the quit, then exit hard.
      sessionAbortRef.current.abort();
      await Promise.race([
        (assembledRef.current?.dispose() ?? Promise.resolve()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      process.exit(0);
    }
  }

  // Resolve the provider + concrete model for a run, by the mode's role. Falls back
  // to the base refs (set at launch / by /model) when the role is unset or unresolvable.
  function modelForTurn(runMode: AgentMode): {
    provider: Provider;
    model: string;
    supportsVision: boolean;
  } {
    const id = props.config.models?.[roleForMode(runMode)];
    if (id) {
      const resolved = resolveModel(props.config, id);
      if (resolved) {
        try {
          return {
            provider: createProvider(resolved.providerConfig),
            model: resolved.model.name ?? resolved.model.id,
            supportsVision: modelSupportsVision(resolved.model),
          };
        } catch {
          // fall through to base refs
        }
      }
    }
    // Base-ref fallback has no ModelConfig in hand; assume vision-capable (the
    // built-in models all are) — a text-only model is opted out via config.
    const base = resolveModel(props.config);
    return {
      provider: providerRef.current,
      model: modelNameRef.current,
      supportsVision: base ? modelSupportsVision(base.model) : true,
    };
  }

  /** Persist newly appended (or compacted) turns to the session store. */
  function flush(compacted: boolean): void {
    const msgs = messagesRef.current;
    if (compacted) {
      props.store.replaceTurns(sessionIdRef.current, msgs);
    } else {
      for (let i = persistedRef.current; i < msgs.length; i++) {
        props.store.appendTurn(sessionIdRef.current, msgs[i]);
      }
    }
    persistedRef.current = msgs.length;
  }

  // A turn rejecting *outside* runTurn's own try (e.g. while building tools) would
  // otherwise vanish as an unhandled rejection and leave `busy` stuck true.
  const reportTurnFailure = (err: unknown) => {
    note(`cc: ${(err as Error).message}`, "error");
    controllerRef.current = null;
    setBusy(false);
    setLive([]);
    // Clear any queued prompt waiting on this turn — the dispatch failed, so the
    // queue is stale; the user can resubmit.
    queuedRef.current = null;
    setQueued(null);
  };

  // ── run one user prompt through the agent loop ──
  // `modeOverride` lets callers run in a mode other than the current state value,
  // which matters when accepting a plan: `setMode("normal")` hasn't flushed yet.
  async function runTurn(modeOverride?: AgentMode): Promise<void> {
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    // Wait for the deferred assembly (tools + MCP connect) to finish before the
    // first turn. A prompt sent during the connect window queues behind it here
    // rather than running with an incomplete tool set. startSession is idempotent.
    await startSession();
    const assembled = assembledRef.current;

    const runMode = modeOverride ?? modeRef.current;
    const {
      provider: turnProvider,
      model: turnModel,
      supportsVision: turnSupportsVision,
    } = modelForTurn(runMode);
    // Per-turn view of the assembled session: plan filtering, the mode suffix, and
    // auto's gate skip are all derived here (tools/system/gate) from the single
    // mode-independent assembly. The PreToolUse/PostToolUse hooks are composed
    // once at assembly and reused every turn. `assembled` is never null when tools
    // are enabled; under --no-tools assembly still runs (it yields an empty tool
    // set), so the only null case is a still-pending/failed assembly.
    const view = assembled
      ? sessionForMode(assembled, runMode)
      : { tools: [], system: "", gate: undefined };
    const { tools, system, gate } = view;
    const preToolUse = assembled?.preToolUse;
    const postToolUse = assembled?.postToolUse;

    const budget = supportsThinking(turnProvider.id) ? budgetFor(thinking) : 0;
    // Auto mode runs unattended → a hard cap (no human to ask). Normal/plan run
    // unbounded with a periodic "keep going?" checkpoint instead of a turn limit.
    const interactive = runMode !== "auto";
    const maxTurns = props.config.autoMaxTurns;
    const checkpointEvery = interactive ? props.config.checkpointEvery : 0;

    // The in-flight turn is built up here and mirrored into React state for render.
    // Only the *last* item is ever mutated (text appends to it, a tool flips
    // pending→done); every earlier item is final. So as the turn progresses we
    // move finalised items into the `<Static>` scrollback and keep just the live
    // (mutating) item in the dynamic region. This is what stops the dynamic region
    // from growing past the terminal viewport — overflowing it desyncs Ink's
    // redraw and duplicates lines into the scrollback. `committed` tracks how many
    // of `local` have already been handed to `<Static>`.
    const local: Item[] = [];
    let committed = 0;
    // Ghost-free streaming: a growing assistant/thinking block is the one item that
    // can outgrow the viewport. Before each commit, peel its *stable* prefix (whole
    // lines, never inside an open code fence) into its own finalised chunk inserted
    // just before it — the existing "commit all but last" pass then moves the chunk
    // into `<Static>` permanently, leaving only the unstable tail in the live region.
    // The tail is ≤ one logical line (plus any open fence), so it can't overflow.
    const splitStableText = () => {
      const last = local[local.length - 1];
      if (!last || (last.kind !== "assistant" && last.kind !== "thinking"))
        return;
      const cut = stablePrefixLen(last.text, last.kind);
      if (cut <= 0) return;
      const chunk: Item = {
        id: nextId(),
        kind: last.kind,
        text: last.text.slice(0, cut),
        continuation: last.continuation,
      };
      last.text = last.text.slice(cut);
      last.continuation = true; // its head was already committed above
      local.splice(local.length - 1, 0, chunk); // insert the chunk before the tail
    };
    const sync = () => {
      splitStableText();
      const finalCount = local.length - 1; // all but the still-mutating last item
      if (finalCount > committed) {
        const newlyFinal = local.slice(committed, finalCount);
        setHistory((prev) => [...prev, ...newlyFinal]);
        committed = finalCount;
      }
      setLive(local.length > committed ? [local[local.length - 1]!] : []);
    };
    let compacted = false;
    let lastCheckpoint = 0; // turn count of the most recent checkpoint, for the note
    let outcome: "stop" | "max_turns" | "aborted" | "stopped" | "error" =
      "stop";

    const appendText = (text: string) => {
      const last = local[local.length - 1];
      if (last && last.kind === "assistant") last.text += text;
      else local.push({ id: nextId(), kind: "assistant", text });
    };
    const appendThinking = (text: string) => {
      const last = local[local.length - 1];
      if (last && last.kind === "thinking") last.text += text;
      else local.push({ id: nextId(), kind: "thinking", text });
    };

    try {
      for await (const ev of runAgent({
        provider: turnProvider,
        model: turnModel,
        system,
        messages: messagesRef.current,
        tools,
        mode: runMode,
        supportsVision: turnSupportsVision,
        maxTurns,
        checkpointEvery,
        onCheckpoint: interactive ? approvals.requestCheckpoint : undefined,
        thinkingBudget: budget,
        compactAtTokens: props.config.compactAtTokens,
        signal: controller.signal,
        gate,
        preToolUse,
        postToolUse,
      })) {
        switch (ev.type) {
          case "text":
            appendText(ev.text);
            sync();
            break;
          case "thinking":
            appendThinking(ev.text);
            sync();
            break;
          case "tool_start":
            local.push({
              id: nextId(),
              kind: "tool",
              toolId: ev.id,
              name: ev.name,
              input: ev.input,
              pending: true,
            });
            sync();
            break;
          case "tool_end": {
            // `local` holds only the current turn's items (a handful of tool
            // calls); a linear find runs once per tool_end. A keyed Map would add
            // bookkeeping to this streaming reducer for no measurable gain.
            // eslint-disable-next-line react-doctor/js-index-maps -- tiny per-turn array; see above
            const t = local.find(
              (i) => i.kind === "tool" && i.toolId === ev.id,
            );
            if (t && t.kind === "tool") {
              t.pending = false;
              t.result = ev.result;
              t.isError = ev.isError;
              t.diff = ev.diff;
            }
            sync();
            break;
          }
          case "usage": {
            props.store.addUsage(
              sessionIdRef.current,
              ev.inputTokens,
              ev.outputTokens,
            );
            const s = props.store.getSession(sessionIdRef.current);
            if (s) {
              setCost(s.costUsd);
              setTokens(s.inputTokens + s.outputTokens);
            }
            break;
          }
          case "compaction":
            compacted = true;
            local.push({
              id: nextId(),
              kind: "note",
              text: `⌘ compacted context: ${ev.summarized} msgs · ~${ev.beforeTokens}→${ev.afterTokens} tok`,
            });
            sync();
            break;
          case "checkpoint":
            // The onCheckpoint hook surfaces the prompt; just remember the turn
            // count so a subsequent "stopped" can name it.
            lastCheckpoint = ev.turn;
            break;
          case "done":
            outcome = ev.reason;
            if (ev.reason === "aborted") {
              local.push({
                id: nextId(),
                kind: "note",
                text: "aborted",
                tone: "error",
              });
            } else if (ev.reason === "max_turns") {
              local.push({
                id: nextId(),
                kind: "note",
                text: `${iconFor("warning", nerdFont)} stopped after ${maxTurns} turns (the turn limit)`,
                tone: "error",
              });
            } else if (ev.reason === "stopped") {
              local.push({
                id: nextId(),
                kind: "note",
                text: `${iconFor("checkpoint", nerdFont)} stopped at the ${lastCheckpoint}-turn checkpoint — send a message to continue`,
              });
            }
            break;
        }
      }
    } catch (err) {
      outcome = "error";
      local.push({
        id: nextId(),
        kind: "note",
        text: `cc: ${(err as Error).message}`,
        tone: "error",
      });
    } finally {
      // Persist first — Stop hooks and UI cleanup must not be able to lose the turn.
      // This also means Stop hooks now run after the turn is committed to the store,
      // so hooks observe completed state — that is the intended contract.
      try {
        flush(compacted);
      } catch (err) {
        local.push({
          id: nextId(),
          kind: "note",
          text: `session save failed: ${(err as Error).message}`,
          tone: "error",
        });
      }
      if (props.config.hooks.Stop?.length) {
        try {
          await runStopHooks(props.config.hooks, {
            ...hookContext(),
            reason: outcome,
          });
        } catch (err) {
          local.push({
            id: nextId(),
            kind: "note",
            text: `Stop hook failed: ${(err as Error).message}`,
            tone: "error",
          });
        }
      }
      // Commit whatever `sync` hasn't already moved (the last, now-final item plus
      // anything appended after the loop) into the scrollback and clear the live region.
      const remaining = local.slice(committed);
      if (remaining.length > 0) setHistory((prev) => [...prev, ...remaining]);
      setLive([]);
      controllerRef.current = null;
      setBusy(false);
      // A clean plan-mode turn produced a plan → surface accept/edit/reject.
      if (runMode === "plan" && outcome === "stop") {
        let planText = "";
        for (const item of local)
          if (item.kind === "assistant") planText += item.text;
        if (planText.trim()) approvals.showPlan(planText);
      }
      // Send a prompt queued while this turn was running (unless it was aborted, a
      // plan is now awaiting review, or it got canceled meanwhile).
      const next = queuedRef.current;
      if (
        next !== null &&
        outcome !== "aborted" &&
        !approvals.pendingPlanRef.current
      ) {
        queuedRef.current = null;
        setQueued(null);
        submitPrompt(next).catch(reportTurnFailure);
      }
    }
  }

  // ── plan review: accept / edit / reject the pending plan ──
  // Accept switches to normal mode and executes the plan as the next prompt; edit
  // drops the plan text into the input box (in normal mode) for tweaking before
  // running; reject discards it and stays in plan mode.
  function acceptPlan(): void {
    const plan = approvals.pendingPlanRef.current;
    approvals.showPlan(null);
    if (!plan) return;
    setMode("normal");
    const instruction = "Proceed with the plan above. Implement it now.";
    note("plan accepted — executing");
    submitPrompt(instruction, instruction, "normal").catch(reportTurnFailure);
  }
  function editPlan(): void {
    const plan = approvals.pendingPlanRef.current;
    approvals.showPlan(null);
    setMode("normal");
    if (plan) setInput(plan.trim());
    note("editing plan — submit to execute, or clear to discard");
  }
  function rejectPlan(): void {
    approvals.showPlan(null);
    note("plan rejected — still in plan mode");
  }

  // ── cycle the agent mode (Shift+Tab): normal → plan → auto → normal ──
  // This is the canonical mode switch; the status line reflects it immediately.
  // Disabled while a plan awaits review (those keys belong to accept/edit/reject).
  function cycleMode(): void {
    const next: AgentMode =
      mode === "normal" ? "plan" : mode === "plan" ? "auto" : "normal";
    setMode(next);
    note(`mode → ${next}`);
  }

  // ── switch the active model (/model <id>) ──
  function switchModel(id: string): void {
    const resolved = resolveModel(props.config, id);
    if (!resolved) {
      note(`unknown model: ${id}`, "error");
      return;
    }
    try {
      providerRef.current = createProvider(resolved.providerConfig);
    } catch (err) {
      note((err as Error).message, "error");
      return;
    }
    modelNameRef.current = resolved.model.name ?? resolved.model.id;
    const label = resolved.model.id;
    setModelLabel(label);
    setCostKnown(hasPriceData(modelNameRef.current));
    if (!hasConversation()) {
      updateBanner({ model: label, provider: providerRef.current.id });
    }
    // Persist: update the session row (so --resume restores this model) and write
    // the preference to ~/.cc/config.json (so it's the default next launch).
    props.store.setModel(sessionIdRef.current, modelNameRef.current);
    void saveConfig({ model: label }).catch((err) =>
      note(
        `could not save model preference: ${(err as Error).message}`,
        "error",
      ),
    );
    note(`model → ${label}`);
  }

  function formatConfigValue(value: unknown): string {
    return value === undefined ? "<unset>" : summarizeConfig(value);
  }

  async function reloadConfig(): Promise<void> {
    const next = await loadConfig();
    // Re-run the loader so a just-enabled user extension imports now (Bun's
    // module cache makes re-imports of already-loaded files free). No confirm
    // mid-session: an unapproved project extension skips with a note telling
    // the user to relaunch.
    await initExtensions(next, { note: (text) => note(text) });
    // Re-run extension startup against the fresh config (live — a reload
    // should reflect current credentials). Startup notes are dropped: a
    // reload is not a launch.
    await startupExtensions(next, "live");
    replaceConfigInPlace(props.config, next);
  }

  // Assemble the session through the shared extension kernel: tools, system
  // prompt, the composed gate (AI permission check + the human confirm gate
  // below), pre/post-tool hooks, and the MCP lifecycle all come from this one
  // call. Notes (skills/agents/mcp/context) route into the scrollback. The MCP
  // connect happens here, which is why assembly is deferred to after first paint.
  async function assemble(): Promise<AssembledSession> {
    // The human confirm gate. The frontend gate is composed BEHIND the AI gate by
    // assembleSession; it reads the live run mode (modeRef) so a mode switch
    // between turns is reflected without reassembling. Auto-mode's skip is handled
    // by sessionForMode (it drops the gate), so passing modeRef here is belt-and-braces.
    const frontendGate: FrontendGate = (call, aiFlag) =>
      approvals.requestGate(modeRef.current, call, aiFlag);
    return assembleSession({
      config: props.config,
      // Assembly is mode-independent (mode-specific derivation is per-turn via
      // sessionForMode). spawn_agent inherits this provider/model as its child
      // default — the launch/`/model` model at assembly time.
      provider: providerRef.current,
      model: modelNameRef.current,
      sessionId: sessionIdRef.current,
      signal: sessionAbortRef.current.signal,
      noTools: props.noTools,
      gate: frontendGate,
      note: (text) => note(text), // drops the local note()'s tone arg
      askUser: approvals.requestAsk,
      onTasks: setTasks,
    });
  }

  // Deferred initial assembly: the App calls this once on mount, so a slow MCP
  // server (assembly connects them) never blocks first paint. Idempotent — the
  // first call stores the in-flight promise and every later caller (including the
  // first turn) awaits it rather than reassembling.
  async function startSession(): Promise<void> {
    if (assemblyRef.current) {
      await assemblyRef.current;
      return;
    }
    const p = (async () => {
      assembledRef.current = await assemble();
    })();
    assemblyRef.current = p;
    await p;
  }

  // `/config reload mcp`: full reassembly. Dispose the old session (closes the MCP
  // clients), then assemble afresh so the new mcpServers config takes effect. The
  // skills/agents/mcp notes reprint — acceptable for a manual reload.
  async function reloadSession(): Promise<void> {
    await startSession(); // ensure the initial assembly has settled first
    const old = assembledRef.current;
    const next = await assemble();
    assembledRef.current = next;
    await old?.dispose().catch(() => {});
  }

  async function handleConfig(
    action: Extract<CommandAction, { kind: "config" }>,
  ): Promise<void> {
    try {
      if (action.op === "summary") {
        await reloadConfig();
        note(summarizeConfig(props.config));
        return;
      }
      if (action.op === "get") {
        const path = action.path ?? "";
        await reloadConfig();
        const raw = await getRawConfigPath(path);
        const effective = path
          .split(".")
          .filter(Boolean)
          .reduce<unknown>((cur, part) => {
            return cur && typeof cur === "object" && part in cur
              ? (cur as Record<string, unknown>)[part]
              : undefined;
          }, props.config);
        note(
          `${path}\nraw: ${formatConfigValue(redactConfig(raw))}\neffective: ${formatConfigValue(redactConfig(effective))}`,
        );
        return;
      }
      if (action.op === "set") {
        const path = action.path ?? "";
        const value = parseConfigValue(action.value ?? "");
        validateConfigPathValue(path, value);
        await setRawConfigPath(path, value);
        await reloadConfig();
        if (path === "model" && typeof value === "string") switchModel(value);
        else {
          note(
            `config set ${path} = ${formatConfigValue(redactConfig(value))}`,
          );
        }
        return;
      }
      if (action.op === "unset") {
        const path = action.path ?? "";
        await unsetRawConfigPath(path);
        await reloadConfig();
        note(`config unset ${path}`);
        return;
      }
      if (action.op === "reload") {
        await reloadConfig();
        if (action.path === "mcp") await reloadSession();
        else note("config reloaded");
      }
    } catch (err) {
      note((err as Error).message, "error");
    }
  }

  /** List every configured model id (/model with no argument). */
  function listModels(): void {
    const ids: string[] = [];
    for (const pc of Object.values(props.config.providers)) {
      for (const m of pc.models ?? [])
        ids.push(m.name ? `${m.id} (${m.name})` : m.id);
    }
    note(ids.length ? `models: ${ids.join(", ")}` : "no models configured");
  }

  async function submitPrompt(
    displayText: string,
    messageText = displayText,
    modeOverride?: AgentMode,
  ): Promise<void> {
    if (props.config.hooks.UserPromptSubmit?.length) {
      await runUserPromptSubmitHooks(
        props.config.hooks,
        displayText,
        hookContext(),
      );
    }
    push({ kind: "user", text: displayText });
    const content: ContentBlock[] = [{ type: "text", text: messageText }];
    // Collect images for this prompt: clipboard pastes (Ctrl+V) queued in the ref,
    // plus any image files referenced in the prompt text (bare or @-mentioned).
    const clipboardImages = pendingImagesRef.current;
    pendingImagesRef.current = [];
    const imagePaths = extractImagePaths(messageText);
    if (clipboardImages.length || imagePaths.length) {
      const runMode = modeOverride ?? modeRef.current;
      const resolved = resolveModel(
        props.config,
        props.config.models?.[roleForMode(runMode)],
      );
      if (resolved && !modelSupportsVision(resolved.model)) {
        const total = clipboardImages.length + imagePaths.length;
        note(`current model can't view images — ignoring ${total} image(s)`);
      } else {
        for (const img of clipboardImages) {
          content.push({
            type: "image",
            mediaType: img.mediaType,
            data: img.data,
          });
        }
        // Read failures are reported but never block the turn.
        for (const p of imagePaths) {
          try {
            const img = await readImageFile(p);
            content.push({
              type: "image",
              mediaType: img.mediaType,
              data: img.data,
            });
          } catch (err) {
            note(`couldn't attach ${p}: ${(err as Error).message}`, "error");
          }
        }
      }
    }
    messagesRef.current.push({ role: "user", content });
    runTurn(modeOverride).catch(reportTurnFailure);
  }

  /** Ctrl+V: grab an image off the clipboard and queue it for the next prompt. */
  async function attachClipboardImage(): Promise<void> {
    try {
      const img = await readClipboardImage();
      if (!img) {
        note("no image in clipboard");
        return;
      }
      pendingImagesRef.current.push(img);
      const n = pendingImagesRef.current.length;
      note(
        `image attached (${img.mediaType}) — ${n} pending; send a message to include`,
      );
    } catch (err) {
      note(`clipboard read failed: ${(err as Error).message}`, "error");
    }
  }

  // ── handle a submitted input line (command or prompt) ──
  function onSubmit(rawValue: string): void {
    // The buffer may carry paste sentinels — expand them to the real pasted text
    // before the prompt is sent, recorded to history, or dispatched as a command.
    const value = expandPastes(rawValue, pasteMap);
    const line = value.trim();
    if (!line) return;
    // Busy → queue this line to send when the current turn finishes. A second
    // submit replaces the queued prompt rather than stacking.
    if (busy) {
      setInput("");
      promptHistory.recordHistory(line);
      queuedRef.current = line;
      setQueued(line);
      return;
    }
    setInput("");
    promptHistory.recordHistory(line);

    const action = makeCommandSet(availableCommands(props.config)).dispatch(
      line,
    );
    switch (action.kind) {
      case "message":
        submitPrompt(line).catch(reportTurnFailure);
        break;
      case "set-mode":
        setMode(action.mode);
        note(`mode → ${action.mode}`);
        break;
      case "set-think":
        setThinking(action.level);
        note(`thinking → ${describeLevel(action.level)}`);
        break;
      case "set-model":
        switchModel(action.model);
        break;
      case "list-models":
        listModels();
        break;
      case "clear": {
        messagesRef.current = [];
        persistedRef.current = 0;
        sessionIdRef.current = props.store.createSession({
          model: modelNameRef.current,
          cwd: process.cwd(),
          title: "(cleared)",
          thinking,
          mode,
        });
        if (props.config.hooks.SessionStart?.length) {
          void runSessionStartHooks(props.config.hooks, "clear", hookContext());
        }
        // Ink's <Static> prints scrollback permanently — resetting React state
        // alone leaves the old transcript on screen. We must clear via Ink's own
        // instance.clear() so Ink resets its internal cursor/output bookkeeping;
        // writing a raw clear escape (\x1b[2J…) out-of-band desyncs Ink and causes
        // duplicated re-renders and a runaway layout. Reset history first, then
        // clear on the next tick so the <Static> count is in sync.
        setHistory([]);
        setTasks([]);
        queueMicrotask(() => props.inkInstance?.current?.clear());
        setCost(0);
        setTokens(0);
        note("conversation cleared");
        break;
      }
      case "cost": {
        const s = props.store.getSession(sessionIdRef.current);
        if (s) {
          note(
            hasPriceData(s.model)
              ? `tokens: ${s.inputTokens}→${s.outputTokens} · cost: $${s.costUsd.toFixed(4)}`
              : `tokens: ${s.inputTokens}→${s.outputTokens}`,
          );
        }
        break;
      }
      case "resume":
        note(
          "resume from the TUI isn't supported yet — start with `cc --resume`",
        );
        break;
      case "init":
        doInit();
        break;
      case "extension-command":
        void runBuiltin(action.name, action.args);
        break;
      case "extensions":
        handleExtensions(action).catch((err) =>
          note(`/extensions failed: ${(err as Error).message}`, "error"),
        );
        break;
      case "update":
        void doUpdate();
        break;
      case "config":
        void handleConfig(action);
        break;
      case "help":
        note(action.text);
        break;
      case "exit":
        quit();
        break;
      case "error":
        note(action.message, "error");
        break;
    }
  }

  // `/init` — drive a real agent turn that investigates the repo and writes a
  // proper CC.md (not a placeholder template). Refuses to overwrite an existing
  // CC.md so project memory is never clobbered.
  function doInit(): void {
    if (existsSync(join(process.cwd(), "CC.md"))) {
      note(
        `CC.md already exists — left intact (${join(process.cwd(), "CC.md")})`,
        "error",
      );
      return;
    }
    note("investigating the project to write CC.md…");
    submitPrompt("/init", INIT_PROMPT, "normal").catch(reportTurnFailure);
  }

  // A command contributed by an extension (`/login-codex`,
  // `/login-opencode`, …) — the handler lives with its extension; the TUI only
  // routes notes into the scrollback and formats failures.
  async function runBuiltin(name: string, args: string[]): Promise<void> {
    try {
      if (
        !(await runCommand(
          props.config,
          name,
          { config: props.config, note: (text) => note(text) },
          args,
        ))
      ) {
        note(`unknown command: /${name}`, "error");
      }
    } catch (err) {
      note(`/${name} failed: ${(err as Error).message}`, "error");
    }
  }

  // `/extensions` — bare opens the interactive checkbox picker; an explicit
  // `enable|disable <name>` flips one directly. Either way a change persists to
  // ~/.cc/config.json (`extensions.<name>`), re-runs the built-in startup
  // gating, and reassembles the session so tool/prompt changes apply at once.
  async function handleExtensions(
    action: Extract<CommandAction, { kind: "extensions" }>,
  ): Promise<void> {
    // A prior toggle may still be applying (config reload + reassembly take
    // seconds) — wait it out so this command never reads mid-apply state.
    if (togglesInFlightRef.current) await togglesInFlightRef.current;
    const known = listExtensions(props.config);
    if (action.op === "list") {
      // Read the persisted toggles straight from disk so the picker reflects
      // saved truth even if some in-memory reload is lagging.
      const raw = (await getRawConfigPath("extensions").catch(
        () => undefined,
      )) as Record<string, boolean> | undefined;
      extensionsOpenRef.current = true;
      setExtensionsPicker(
        known.map((e) => ({
          name: e.name,
          description: e.description,
          enabled: raw?.[e.name] ?? e.enabled,
        })),
      );
      return;
    }
    const name = action.name ?? "";
    if (!known.some((e) => e.name === name)) {
      note(
        `unknown extension: "${name}" (known: ${known.map((e) => e.name).join(", ")})`,
        "error",
      );
      return;
    }
    const enable = action.op === "enable";
    if (extensionEnabled(props.config, name) === enable) {
      note(`extension ${name} is already ${enable ? "enabled" : "disabled"}`);
      return;
    }
    await applyToggles([{ name, description: "", enabled: enable }]);
  }

  /** The applyToggles work: persist the changed toggles, then ONE config
   * reload and ONE session reassembly for the whole batch. */
  async function doApplyToggles(next: ExtensionToggle[]): Promise<void> {
    const changed = next.filter(
      (e) => e.enabled !== extensionEnabled(props.config, e.name),
    );
    if (changed.length === 0) return;
    try {
      for (const e of changed) {
        await setRawConfigPath(`extensions.${e.name}`, e.enabled);
      }
      await reloadConfig();
      await reloadSession();
      const enabled = changed.filter((e) => e.enabled).map((e) => e.name);
      const disabled = changed.filter((e) => !e.enabled).map((e) => e.name);
      note(
        [
          enabled.length ? `enabled: ${enabled.join(", ")}` : "",
          disabled.length ? `disabled: ${disabled.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    } catch (err) {
      note(`/extensions failed: ${(err as Error).message}`, "error");
    }
  }

  /** Run doApplyToggles, tracked in togglesInFlightRef so a reopened picker
   * (or a follow-up enable/disable) waits for the apply to land first. */
  function applyToggles(next: ExtensionToggle[]): Promise<void> {
    const run: Promise<void> = doApplyToggles(next).finally(() => {
      if (togglesInFlightRef.current === run) togglesInFlightRef.current = null;
    });
    togglesInFlightRef.current = run;
    return run;
  }

  // Enter in the picker: close it, then apply whatever changed.
  function applyExtensions(next: ExtensionToggle[]): void {
    extensionsOpenRef.current = false;
    setExtensionsPicker(null);
    void applyToggles(next);
  }

  // Esc in the picker: close without applying.
  function cancelExtensions(): void {
    extensionsOpenRef.current = false;
    setExtensionsPicker(null);
  }

  // `/update` — download, verify, and swap in the latest release binary. Each
  // step reports through note(); the swap takes effect on the next launch.
  async function doUpdate(): Promise<void> {
    const reason = updateDisabledReason(props.config);
    if (reason) {
      note(`update unavailable — ${reason}`, "error");
      return;
    }
    note("checking for updates…");
    const result = await applyUpdate(props.config, (msg) => note(msg));
    note(result.message, result.ok ? undefined : "error");
  }

  function quit(): void {
    void shutdown("quit");
  }

  // Shared cancel escalation for both Ctrl+C and Esc. In priority order it:
  //   1. cancels a queued prompt (the typed-while-busy line waiting to send),
  //   2. clears the current prompt if there's text in it,
  //   3. aborts the in-flight AI request,
  //   4. arms quit (first press) then quits (second press within the window).
  // `label` is the key name shown in the "press … again to quit" hint.
  function handleCancel(label: string): void {
    // 1. A queued prompt waiting to be sent after the current turn.
    if (queuedRef.current !== null) {
      queuedRef.current = null;
      setQueued(null);
      note("queued prompt canceled");
      quitArmedRef.current = false;
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      return;
    }
    // 2. A non-empty prompt buffer — clear it.
    if (inputRef.current.length > 0) {
      setInput("");
      bumpCursor();
      quitArmedRef.current = false;
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      return;
    }
    // 3. An in-flight request — abort it.
    if (controllerRef.current) {
      controllerRef.current.abort();
      // A pending confirm/checkpoint/ask holds the loop on an unresolved promise —
      // decline them so the abort can actually propagate instead of deadlocking.
      approvals.declineAllPending();
      quitArmedRef.current = false;
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      return;
    }
    // 4. Nothing left to cancel — arm, then quit on the second press.
    if (quitArmedRef.current) {
      quit();
      return;
    }
    quitArmedRef.current = true;
    note(`press ${label} again to quit`);
    if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
    quitTimerRef.current = setTimeout(() => {
      quitArmedRef.current = false;
    }, 1500);
  }

  // The footer shows the model THIS mode will actually run on (role-resolved), so
  // cycling modes (Shift+Tab) reflects a role's model when it differs from the base.
  const roleId = props.config.models?.[roleForMode(mode)];
  const effectiveModel = roleId
    ? resolveModel(props.config, roleId)
    : undefined;
  const effectiveModelLabel = effectiveModel?.model.id ?? modelLabel;
  const effectiveModelName =
    effectiveModel?.model.name ??
    effectiveModel?.model.id ??
    modelNameRef.current;

  return {
    busy,
    queued,
    tasks,
    cost,
    costKnown: effectiveModel ? hasPriceData(effectiveModelName) : costKnown,
    tokens,
    modelLabel: effectiveModelLabel,
    mode,
    thinking,
    verbose,
    setVerbose,
    onSubmit,
    attachClipboardImage,
    cycleMode,
    acceptPlan,
    editPlan,
    rejectPlan,
    handleCancel,
    startSession,
    extensionsPicker,
    extensionsOpenRef,
    applyExtensions,
    cancelExtensions,
  };
}
