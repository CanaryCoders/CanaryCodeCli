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
import {
  type AgentMode,
  roleForMode,
  runAgent,
  systemForMode,
} from "../agent.ts";
import { askUserTool } from "../askuser.ts";
import {
  clearCredentials,
  hasCredentials,
  loginWithBrowser,
  openBrowser,
} from "../auth.ts";
import { readClipboardImage } from "../clipboard.ts";
import { dispatchCommand } from "../commands.ts";
import {
  getRawConfigPath,
  loadConfig,
  modelSupportsVision,
  parseConfigValue,
  redactConfig,
  resolveModel,
  saveConfig,
  setRawConfigPath,
  summarizeConfig,
  unsetRawConfigPath,
  validateConfigPathValue,
} from "../config.ts";
import {
  runPostToolHooks,
  runPreToolHooks,
  runSessionEndHooks,
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
} from "../hooks.ts";
import { iconFor } from "../icons.ts";
import { extractImagePaths, type ImageData, readImageFile } from "../image.ts";
import { closeMcp, connectMcpServers, describeMcp } from "../mcp.ts";
import {
  describeCodex,
  gateCodexModels,
  OPENAI_PROVIDER,
  populateCodexModels,
} from "../openai-codex.ts";
import type { ContentBlock, Message } from "../provider.ts";
import { createProvider, type Provider } from "../provider.ts";
import { hasPriceData } from "../session.ts";
import { readSkillTool } from "../skills.ts";
import { Semaphore, spawnAgentTool } from "../subagents.ts";
import { type Task, updateTasksTool } from "../tasks.ts";
import {
  budgetFor,
  describeLevel,
  supportsThinking,
  type ThinkingLevel,
} from "../thinking.ts";
import type { Tool } from "../tools.ts";
import { tools as allTools } from "../tools.ts";
import { applyUpdate, updateDisabledReason } from "../update.ts";
import { webSearchTool } from "../websearch.ts";
import type { AppProps } from "./app-types.ts";
import { expandPastes } from "./input-helpers.ts";
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
  /** Connect MCP servers once, on mount (deferred so they don't block first paint). */
  startMcp: () => Promise<void>;
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
  // Base system prompt (project context + skills already folded in). Held in a
  // ref so `/init` can fold a freshly generated CC.md in live, mid-session.
  const baseSystemRef = useRef(props.baseSystem);
  // Seed with any resumed transcript; those turns are already stored, so the
  // persist baseline starts past them (only new turns get appended).
  const messagesRef = useRef<Message[]>(props.resumedMessages ?? []);
  const persistedRef = useRef(props.resumedMessages?.length ?? 0);
  const sessionIdRef = useRef(props.sessionId);
  const closedRef = useRef(false);
  const sessionStartedRef = useRef(true);
  const hookContext = () => ({
    sessionId: sessionIdRef.current,
    cwd: process.cwd(),
  });
  // Ctrl+C is "armed" after a first press with nothing to abort; a second press
  // before the timer fires quits. The timer disarms it so a lone press never quits.
  const quitArmedRef = useRef(false);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the one-time deferred MCP connect (see startMcp) against a re-invocation.
  const mcpStartedRef = useRef(false);
  // A prompt typed and submitted while a turn is in flight; it sends automatically
  // once the turn finishes. The ref mirrors state for the `useInput` closure.
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  // Images pasted from the clipboard (Ctrl+V), attached to the next prompt sent.
  const pendingImagesRef = useRef<ImageData[]>([]);

  const [busy, setBusy] = useState(false);
  const [mode, setModeState] = useState<AgentMode>(
    props.initialMode ?? "normal",
  );
  const [thinking, setThinkingState] = useState<ThinkingLevel>(
    props.initialThinking ?? "off",
  );
  // Persist mode / thinking onto the session row as they change, so a later
  // `--resume` restores them. Wrappers keep React state + the stored row in sync.
  const setMode = (next: AgentMode) => {
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

  async function ensureSessionStarted(): Promise<void> {
    if (sessionStartedRef.current) return;
    sessionStartedRef.current = true;
    if (props.config.hooks.SessionStart?.length) {
      await runSessionStartHooks(props.config.hooks, "startup", hookContext());
    }
  }

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
      // Unmount Ink first so the terminal is restored to cooked mode immediately,
      // then tear down the rest of the process. `app.exit()` only unmounts the UI —
      // it does NOT end the process, and the live MCP clients (their child
      // processes and sockets) keep the event loop alive, so without an explicit
      // exit the process lingers after the UI is gone: the now-cooked terminal
      // echoes any further keystrokes as raw `^[`/`^C` until a signal kills it.
      app.exit();
      // Best-effort close of MCP transports (kills spawned servers like puppeteer's
      // browser), capped so a wedged transport can't block the quit, then exit hard.
      await Promise.race([
        closeMcp(props.mcp).catch(() => {}),
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

  // ── build the tool set for a run (fresh signal so spawn_agent can be aborted) ──
  function buildTools(
    signal: AbortSignal,
    turnProvider: Provider,
    turnModel: string,
  ): Tool[] {
    if (props.noTools) return [];
    let tools: Tool[] = [
      ...allTools,
      webSearchTool(props.config.webSearch),
      readSkillTool(props.skills),
      askUserTool(approvals.requestAsk),
      ...props.mcp.tools,
    ];
    if (props.config.maxDepth > 0) {
      const limiter = new Semaphore(props.config.maxConcurrent);
      tools = [
        ...tools,
        spawnAgentTool({
          config: props.config,
          parentProvider: turnProvider,
          parentModel: turnModel,
          inheritedTools: tools,
          depth: 0,
          limiter,
          signal,
          agents: props.agents,
        }),
      ];
    }
    // update_tasks is the orchestrator's own todo list — added top-level only (it
    // is deliberately NOT in spawn_agent's inheritedTools above), so the panel
    // reflects the main agent's plan while children just do their one task and
    // return a summary.
    tools = [...tools, updateTasksTool(setTasks, props.config)];
    return tools;
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

  // ── run one user prompt through the agent loop ──
  // `modeOverride` lets callers run in a mode other than the current state value,
  // which matters when accepting a plan: `setMode("normal")` hasn't flushed yet.
  async function runTurn(modeOverride?: AgentMode): Promise<void> {
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    const runMode = modeOverride ?? mode;
    const {
      provider: turnProvider,
      model: turnModel,
      supportsVision: turnSupportsVision,
    } = modelForTurn(runMode);
    const system = systemForMode(baseSystemRef.current, runMode);
    let tools = buildTools(controller.signal, turnProvider, turnModel);
    if (runMode === "plan") tools = tools.filter((t) => t.readOnly);

    const budget = supportsThinking(turnProvider.id) ? budgetFor(thinking) : 0;
    // Auto mode runs unattended → a hard cap (no human to ask). Normal/plan run
    // unbounded with a periodic "keep going?" checkpoint instead of a turn limit.
    const interactive = runMode !== "auto";
    const maxTurns = props.config.autoMaxTurns;
    const checkpointEvery = interactive ? props.config.checkpointEvery : 0;

    // Lifecycle hooks run in every mode (deterministic policy). PreToolUse can
    // block a call; PostToolUse observes. Omitted when none are configured.
    const hooks = props.config.hooks;
    const ctx = hookContext();
    const preToolUse = hooks.PreToolUse?.length
      ? (call: { name: string; input: unknown }) =>
          runPreToolHooks(hooks, call, ctx)
      : undefined;
    const postToolUse = hooks.PostToolUse?.length
      ? (
          call: { name: string; input: unknown },
          result: { content: string; isError: boolean },
        ) => runPostToolHooks(hooks, call, result, ctx)
      : undefined;

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
        gate: (call) => approvals.requestGate(runMode, call),
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
                text: "⨯ aborted",
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
      if (props.config.hooks.Stop?.length) {
        await runStopHooks(props.config.hooks, {
          ...ctx,
          reason: outcome,
        });
      }
      flush(compacted);
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
        void submitPrompt(next);
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
    void submitPrompt(instruction, instruction, "normal");
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

  function replaceConfig(next: typeof props.config): void {
    const target = props.config as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, next);
  }

  function formatConfigValue(value: unknown): string {
    return value === undefined ? "<unset>" : summarizeConfig(value);
  }

  async function reloadConfig(): Promise<void> {
    const next = await loadConfig();
    if (await hasCredentials()) await populateCodexModels(next);
    else gateCodexModels(next, false);
    replaceConfig(next);
  }

  // Deferred initial MCP connect: runTui hands the App an empty `props.mcp` and the
  // App calls this once on mount, so a slow MCP server never blocks first paint. The
  // tools fold into the shared `props.mcp` (read at send time) and the `⌁ mcp` note
  // replaces the startup "connecting…" line. Idempotent — a no-op after the first run
  // and when there are no servers (or --no-tools).
  async function startMcp(): Promise<void> {
    if (mcpStartedRef.current || props.noTools) return;
    mcpStartedRef.current = true;
    const configured = Object.keys(props.config.mcpServers).length;
    if (configured === 0) return;
    const conn = await connectMcpServers(props.config.mcpServers);
    props.mcp.tools = conn.tools;
    props.mcp.clients = conn.clients;
    props.mcp.notes = conn.notes;
    note(describeMcp(conn, configured) ?? "⌁ mcp: no servers configured");
  }

  async function reloadMcp(): Promise<void> {
    const oldClients = props.mcp.clients;
    const next = await connectMcpServers(props.config.mcpServers);
    await Promise.all(oldClients.map((c) => c.close().catch(() => {})));
    props.mcp.tools = next.tools;
    props.mcp.clients = next.clients;
    props.mcp.notes = next.notes;
    note(
      describeMcp(next, Object.keys(props.config.mcpServers).length) ??
        "⌁ mcp: no servers configured",
    );
  }

  async function handleConfig(
    action: Extract<ReturnType<typeof dispatchCommand>, { kind: "config" }>,
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
        if (action.path === "mcp") await reloadMcp();
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
    await ensureSessionStarted();
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
      const runMode = modeOverride ?? mode;
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
    void runTurn(modeOverride);
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

    const action = dispatchCommand(line);
    switch (action.kind) {
      case "message":
        void submitPrompt(line);
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
        sessionStartedRef.current = true;
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
      case "login-codex":
        loginCodex();
        break;
      case "logout-codex":
        void logoutCodex();
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
    void submitPrompt("/init", INIT_PROMPT, "normal");
  }

  // `/login-codex` — sign in with the ChatGPT subscription via the browser OAuth
  // flow (a background callback server on 127.0.0.1:1455). The URL is also printed
  // so a remote user can copy it. On success the Codex models are discovered live;
  // switch with `/model <a listed model>` (e.g. `/model gpt-5.5 high`).
  function loginCodex(): void {
    note("opening your browser to sign in with ChatGPT…");
    void loginWithBrowser({
      open: openBrowser,
      onUrl: (url) => note(`if your browser didn't open, visit:\n${url}`),
    })
      .then(async ({ account_id }) => {
        const result = await populateCodexModels(props.config);
        const ids = (props.config.providers[OPENAI_PROVIDER]?.models ?? []).map(
          (m) => m.id,
        );
        const codexNote = describeCodex(result);
        if (codexNote) note(codexNote);
        note(
          `signed in to ChatGPT${account_id ? ` (account ${account_id})` : ""}${ids.length ? ` — switch with e.g. /model ${ids[0]}` : ""}`,
        );
      })
      .catch((err) => note(`login failed: ${(err as Error).message}`, "error"));
  }

  // `/logout-codex` — drop the stored ChatGPT credentials and hide the Codex models.
  async function logoutCodex(): Promise<void> {
    try {
      await clearCredentials();
      gateCodexModels(props.config, false);
      note("signed out of ChatGPT — Codex models hidden");
    } catch (err) {
      note(`logout failed: ${(err as Error).message}`, "error");
    }
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
    startMcp,
  };
}
