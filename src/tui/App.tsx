// tui/App.tsx — the Ink interactive TUI: scrollback + input box + status line.
//
// This is the second front-end over the shared agent engine (`runAgent`). The
// headless path (index.ts) streams to stdout and exits; the TUI keeps a running
// session: a scrollback of past exchanges (Ink `<Static>`), a live region for the
// turn in flight, a prompt box (`ink-text-input`), and a status line
// (model · mode · thinking · $cost). Slash commands are parsed by commands.ts and
// applied against this component's state.
//
// Item rendering lives in Message.tsx (collapsed/expandable tool calls); the plan
// accept/edit/reject box lands in its own Phase-4 task. Esc aborts the in-flight
// request; Ctrl+C aborts then (pressed twice) quits; Ctrl+R toggles verbose tool
// output; Shift+Tab cycles the mode (normal → plan → auto → normal).

import { useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { MultilineInput } from "./Input.tsx";

import type { Config } from "../config.ts";
import { resolveModel } from "../config.ts";
import { createProvider } from "../provider.ts";
import type { Message, Provider } from "../provider.ts";
import { runAgent, systemForMode, type AgentMode } from "../agent.ts";
import type { Tool } from "../tools.ts";
import { tools as allTools } from "../tools.ts";
import { webSearchTool } from "../websearch.ts";
import { readSkillTool, type Skill } from "../skills.ts";
import { spawnAgentTool, Semaphore } from "../subagents.ts";
import type { McpConnection } from "../mcp.ts";
import { SessionStore } from "../session.ts";
import { dispatchCommand, completions, type CompletionContext } from "../commands.ts";
import {
  budgetFor,
  describeLevel,
  supportsThinking,
  type ThinkingLevel,
} from "../thinking.ts";
import { ItemView, type Item, type ItemInput } from "./Message.tsx";
import { PlanView, planChoiceForKey } from "./Plan.tsx";
import { Complete } from "./Complete.tsx";
import {
  ConfirmView,
  confirmChoiceForKey,
  buildConfirmPreview,
  type ConfirmPreview,
} from "./Confirm.tsx";
import { modeColor as themeModeColor } from "./theme.ts";

// ── The component ────────────────────────────────────────────────────────────────
// The transcript is rendered as a flat list of typed `Item`s (see Message.tsx).
// Finished items live in the `<Static>` scrollback; the in-flight turn accumulates
// in `live` and is moved into the scrollback when the turn completes.

interface AppProps {
  config: Config;
  /** Initial provider + model, already resolved by the launcher. */
  provider: Provider;
  modelName: string;
  modelLabel: string;
  /** App version, shown in the launch banner. */
  version: string;
  /** Base system prompt (project context + skills already folded in). */
  baseSystem: string;
  skills: Skill[];
  mcp: McpConnection;
  store: SessionStore;
  sessionId: string;
  /** Whether tools are disabled entirely (--no-tools). */
  noTools: boolean;
  /** Startup notes (context/skills/mcp) to show in the scrollback. */
  startupNotes: string[];
}

/** Gather the data the `/` autocomplete draws parameter values from. */
function buildCompletionContext(config: Config, store: SessionStore): CompletionContext {
  const models: string[] = [];
  for (const pc of Object.values(config.providers)) {
    for (const m of pc.models ?? []) models.push(m.id);
  }
  const sessions = store.listSessions(20).map((s) => ({ id: s.id, title: s.title }));
  return { models, sessions };
}

export function App(props: AppProps): React.ReactElement {
  const app = useApp();

  // Mutable engine state lives in refs (read inside async loops); React state
  // mirrors what the UI shows.
  const providerRef = useRef(props.provider);
  const modelNameRef = useRef(props.modelName);
  const messagesRef = useRef<Message[]>([]);
  const persistedRef = useRef(0);
  const sessionIdRef = useRef(props.sessionId);
  const controllerRef = useRef<AbortController | null>(null);
  // Ctrl+C is "armed" after a first press with nothing to abort; a second press
  // before the timer fires quits. The timer disarms it so a lone press never quits.
  const quitArmedRef = useRef(false);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // Prompt history (shell-style, in-memory per session). `list` holds submitted
  // lines oldest-first; `idx` is the browse position (null = not browsing, on the
  // live draft); `draft` stashes the in-progress text so the final Down restores it.
  const historyListRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");

  // The launch banner is the first `<Static>` item so it scrolls away naturally;
  // startup notes (context/skills/mcp) follow it.
  const [history, setHistory] = useState<Item[]>(() => [
    {
      id: nextId(),
      kind: "banner" as const,
      appName: "cc",
      version: props.version,
      cwd: process.cwd(),
      model: props.modelLabel,
      provider: props.provider.id,
    },
    ...props.startupNotes.map((text) => ({ id: nextId(), kind: "note" as const, text })),
  ]);
  const [live, setLive] = useState<Item[]>([]);
  const [input, setInputState] = useState("");
  // Mirrors `input` for the once-captured `useInput` closure (which sees stale
  // state). The `setInput` wrapper keeps both in sync.
  const inputRef = useRef("");
  const setInput = (value: string) => {
    inputRef.current = value;
    setInputState(value);
  };
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AgentMode>("normal");
  const [thinking, setThinking] = useState<ThinkingLevel>("off");
  const [modelLabel, setModelLabel] = useState(props.modelLabel);
  const [cost, setCost] = useState(0);
  // Verbose expands tool calls to show full input + output head (Ctrl+R toggles).
  const [verbose, setVerbose] = useState(false);
  // After a plan-mode turn finishes, its plan text awaits accept/edit/reject. The
  // ref mirrors the state so the (stale-closure) `useInput` handler reads it live.
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const pendingPlanRef = useRef<string | null>(null);
  const showPlan = (text: string | null) => {
    pendingPlanRef.current = text;
    setPendingPlan(text);
  };

  // Confirm-before-running gate. While a mutating call awaits approval the loop is
  // paused on `confirmResolverRef`'s promise; y/n/a resolve it. `alwaysRef` is the
  // session-wide "[a]lways" override that disables the gate for the rest of the run.
  // Refs mirror state for the once-captured `useInput` closure.
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmPreview | null>(null);
  const pendingConfirmRef = useRef<ConfirmPreview | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const confirmAlwaysRef = useRef(false);

  // `/` autocomplete popover. `selected` is the highlighted row; `dismissed`
  // hides it (after Esc, or accepting a no-arg command) until the input changes.
  // `cursorNonce` is bumped when we set the input out-of-band so the MultilineInput
  // snaps its cursor to the end. The refs mirror live state for the once-captured
  // `useInput` closure that drives navigation/accept.
  const [selected, setSelected] = useState(0);
  const [completeDismissed, setCompleteDismissed] = useState(false);
  const [cursorNonce, setCursorNonce] = useState(0);
  const completeOpenRef = useRef(false);
  const completionsRef = useRef<ReturnType<typeof completions>>([]);
  const selRef = useRef(0);
  const completeDismissedRef = useRef(false);

  const push = (item: ItemInput) =>
    setHistory((prev) => [...prev, { ...item, id: nextId() } as Item]);
  const note = (text: string, tone: "info" | "error" = "info") =>
    push({ kind: "note", text, tone });

  // ── build the tool set for a run (fresh signal so spawn_agent can be aborted) ──
  function buildTools(signal: AbortSignal): Tool[] {
    if (props.noTools) return [];
    let tools: Tool[] = [
      ...allTools,
      webSearchTool(props.config.webSearch),
      readSkillTool(props.skills),
      ...props.mcp.tools,
    ];
    if (props.config.maxDepth > 0) {
      const limiter = new Semaphore(props.config.maxConcurrent);
      tools = [
        ...tools,
        spawnAgentTool({
          config: props.config,
          parentProvider: providerRef.current,
          parentModel: modelNameRef.current,
          inheritedTools: tools,
          depth: 0,
          limiter,
          signal,
        }),
      ];
    }
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
    const system = systemForMode(props.baseSystem, runMode);
    let tools = buildTools(controller.signal);
    if (runMode === "plan") tools = tools.filter((t) => t.readOnly);

    const budget = supportsThinking(providerRef.current.id) ? budgetFor(thinking) : 0;
    const maxTurns = runMode === "auto" ? props.config.autoMaxTurns : 25;

    // The in-flight turn is built up here and mirrored into React state for render.
    const local: Item[] = [];
    const sync = () => setLive([...local]);
    let compacted = false;
    let outcome: "stop" | "max_turns" | "aborted" | "error" = "stop";

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
        provider: providerRef.current,
        model: modelNameRef.current,
        system,
        messages: messagesRef.current,
        tools,
        mode: runMode,
        maxTurns,
        thinkingBudget: budget,
        compactAtTokens: props.config.compactAtTokens,
        signal: controller.signal,
        confirm: (call) => requestConfirm(runMode, call),
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
            const t = local.find((i) => i.kind === "tool" && i.toolId === ev.id);
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
            props.store.addUsage(sessionIdRef.current, ev.inputTokens, ev.outputTokens);
            const s = props.store.getSession(sessionIdRef.current);
            if (s) setCost(s.costUsd);
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
          case "done":
            outcome = ev.reason;
            if (ev.reason === "aborted") {
              local.push({ id: nextId(), kind: "note", text: "⨯ aborted", tone: "error" });
            } else if (ev.reason === "max_turns") {
              local.push({
                id: nextId(),
                kind: "note",
                text: `⚠ stopped after ${maxTurns} turns (the turn limit)`,
                tone: "error",
              });
            }
            break;
        }
      }
    } catch (err) {
      outcome = "error";
      local.push({ id: nextId(), kind: "note", text: `cc: ${(err as Error).message}`, tone: "error" });
    } finally {
      flush(compacted);
      // Move the completed turn into the scrollback and clear the live region.
      const finished = [...local];
      setHistory((prev) => [...prev, ...finished]);
      setLive([]);
      controllerRef.current = null;
      setBusy(false);
      // A clean plan-mode turn produced a plan → surface accept/edit/reject.
      if (runMode === "plan" && outcome === "stop") {
        let planText = "";
        for (const item of local) if (item.kind === "assistant") planText += item.text;
        if (planText.trim()) showPlan(planText);
      }
    }
  }

  // ── plan review: accept / edit / reject the pending plan ──
  // Accept switches to normal mode and executes the plan as the next prompt; edit
  // drops the plan text into the input box (in normal mode) for tweaking before
  // running; reject discards it and stays in plan mode.
  function acceptPlan(): void {
    const plan = pendingPlanRef.current;
    showPlan(null);
    if (!plan) return;
    setMode("normal");
    const instruction = "Proceed with the plan above. Implement it now.";
    push({ kind: "user", text: instruction });
    messagesRef.current.push({ role: "user", content: [{ type: "text", text: instruction }] });
    note("plan accepted — executing");
    void runTurn("normal");
  }
  function editPlan(): void {
    const plan = pendingPlanRef.current;
    showPlan(null);
    setMode("normal");
    if (plan) setInput(plan.trim());
    note("editing plan — submit to execute, or clear to discard");
  }
  function rejectPlan(): void {
    showPlan(null);
    note("plan rejected — still in plan mode");
  }

  // ── confirm gate: the hook runAgent calls before a mutating tool runs ──
  // Decides whether to pause for [y]/[n]/[a]. Auto mode, the session "always"
  // override, and `confirm:"off"` all run silently; otherwise gated tools (bash,
  // or bash+writes) render the box and await the user's choice via a Promise.
  function requestConfirm(
    runMode: AgentMode,
    call: { id: string; name: string; input: unknown },
  ): Promise<boolean> {
    if (runMode === "auto" || confirmAlwaysRef.current) return Promise.resolve(true);
    const setting = props.config.confirm;
    if (setting === "off") return Promise.resolve(true);
    const gated =
      setting === "bash"
        ? call.name === "bash"
        : call.name === "bash" || call.name === "write_file" || call.name === "edit_file";
    if (!gated) return Promise.resolve(true);
    // Pause the loop: render the call and resolve once the user picks y/n/a.
    return buildConfirmPreview(call).then(
      (preview) =>
        new Promise<boolean>((resolve) => {
          confirmResolverRef.current = resolve;
          pendingConfirmRef.current = preview;
          setPendingConfirm(preview);
        }),
    );
  }

  /** Resolve a pending confirm with the user's choice and tear down the box. */
  function resolveConfirm(ok: boolean, always: boolean): void {
    const resolve = confirmResolverRef.current;
    if (!resolve) return;
    if (always) confirmAlwaysRef.current = true;
    confirmResolverRef.current = null;
    pendingConfirmRef.current = null;
    setPendingConfirm(null);
    resolve(ok);
  }

  // ── cycle the agent mode (Shift+Tab): normal → plan → auto → normal ──
  // This is the canonical mode switch; the status line reflects it immediately.
  // Disabled while a plan awaits review (those keys belong to accept/edit/reject).
  function cycleMode(): void {
    const next: AgentMode = mode === "normal" ? "plan" : mode === "plan" ? "auto" : "normal";
    setMode(next);
    note(`mode → ${next}`);
  }

  // ── `/` autocomplete popover handlers ──
  // The list is recomputed each render from `input`; these drive it from the
  // (stale-closure) key handler via the mirrored refs. Typing reopens it (any
  // input change clears `dismissed` and resets the selection to the top).
  function handleInputChange(value: string): void {
    setInput(value);
    setSelected(0);
    // Typing leaves history browsing — the next Up re-stashes this edited draft.
    historyIdxRef.current = null;
    if (completeDismissedRef.current) {
      completeDismissedRef.current = false;
      setCompleteDismissed(false);
    }
  }
  function moveSel(delta: number): void {
    const n = completionsRef.current.length;
    if (n === 0) return;
    setSelected((s) => ((s + delta) % n + n) % n); // wrap both ends
  }
  function dismissComplete(): void {
    completeDismissedRef.current = true;
    setCompleteDismissed(true);
  }
  function acceptCompletion(): void {
    const choice = completionsRef.current[selRef.current];
    if (!choice) return;
    setInput(choice.value);
    setCursorNonce((n) => n + 1);
    setSelected(0);
    // A trailing space means "now complete a parameter" → keep the popover open;
    // otherwise the command/value is complete → close it (Enter then submits).
    const keepOpen = choice.value.endsWith(" ");
    completeDismissedRef.current = !keepOpen;
    setCompleteDismissed(!keepOpen);
  }

  // ── prompt history (Up/Down at the input boundary) ──
  // Up walks back through submitted prompts (stashing the live draft on the first
  // press); Down walks forward, the last step restoring the stashed draft. Editing
  // the input (handleInputChange) resets browsing so the next Up re-stashes.
  function historyPrev(): void {
    const list = historyListRef.current;
    if (list.length === 0) return;
    if (historyIdxRef.current === null) {
      historyDraftRef.current = input;
      historyIdxRef.current = list.length - 1;
    } else {
      historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
    }
    setInput(list[historyIdxRef.current]!);
    setCursorNonce((n) => n + 1);
  }
  function historyNext(): void {
    if (historyIdxRef.current === null) return; // already on the live draft
    const list = historyListRef.current;
    const next = historyIdxRef.current + 1;
    if (next >= list.length) {
      historyIdxRef.current = null;
      setInput(historyDraftRef.current);
    } else {
      historyIdxRef.current = next;
      setInput(list[next]!);
    }
    setCursorNonce((n) => n + 1);
  }
  /** Record a submitted line (de-dup consecutive) and exit history browsing. */
  function recordHistory(line: string): void {
    const list = historyListRef.current;
    if (list[list.length - 1] !== line) list.push(line);
    historyIdxRef.current = null;
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
    note(`model → ${label}`);
  }

  /** List every configured model id (/model with no argument). */
  function listModels(): void {
    const ids: string[] = [];
    for (const pc of Object.values(props.config.providers)) {
      for (const m of pc.models ?? []) ids.push(m.name ? `${m.id} (${m.name})` : m.id);
    }
    note(ids.length ? `models: ${ids.join(", ")}` : "no models configured");
  }

  // ── handle a submitted input line (command or prompt) ──
  function onSubmit(value: string): void {
    const line = value.trim();
    if (!line || busy) return;
    setInput("");
    recordHistory(line);

    const action = dispatchCommand(line);
    switch (action.kind) {
      case "message":
        push({ kind: "user", text: line });
        messagesRef.current.push({ role: "user", content: [{ type: "text", text: line }] });
        void runTurn();
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
        });
        setHistory([]);
        setCost(0);
        note("conversation cleared");
        break;
      }
      case "cost": {
        const s = props.store.getSession(sessionIdRef.current);
        if (s) {
          note(`tokens: ${s.inputTokens}→${s.outputTokens} · cost: $${s.costUsd.toFixed(4)}`);
        }
        break;
      }
      case "resume":
        note("resume from the TUI isn't supported yet — start with `cc --resume`");
        break;
      case "init":
        note("`/init` (generate CC.md) is not implemented yet");
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

  function quit(): void {
    if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
    props.store.close();
    app.exit();
  }

  // Ctrl+C: if a request is in flight, abort it (like Esc) and disarm. Otherwise
  // the first press arms a quit and shows a hint; a second press within the window
  // exits. The timer disarms so a single stray Ctrl+C never quits.
  function handleCtrlC(): void {
    if (controllerRef.current) {
      controllerRef.current.abort();
      // A pending confirm holds the loop on an unresolved promise — decline it so
      // the abort can actually propagate instead of deadlocking.
      if (pendingConfirmRef.current) resolveConfirm(false, false);
      quitArmedRef.current = false;
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      return;
    }
    if (quitArmedRef.current) {
      quit();
      return;
    }
    quitArmedRef.current = true;
    note("press Ctrl+C again to quit");
    if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
    quitTimerRef.current = setTimeout(() => {
      quitArmedRef.current = false;
    }, 1500);
  }

  // Esc aborts an in-flight request; Ctrl+C aborts then (twice) quits; Ctrl+R
  // toggles verbose tool output. While a plan awaits review the a/e/r keys drive
  // accept/edit/reject (TextInput is unmounted then, so they don't reach the
  // prompt). The handler reads the plan via its ref because Ink's `useInput`
  // closure is captured once (stale state).
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      handleCtrlC();
      return;
    }
    if (key.escape) {
      // Esc dismisses the autocomplete popover first; while a confirm is pending it
      // declines the call and aborts the turn; otherwise it aborts a request.
      if (completeOpenRef.current) dismissComplete();
      else if (pendingConfirmRef.current) {
        resolveConfirm(false, false);
        controllerRef.current?.abort();
      } else if (controllerRef.current) controllerRef.current.abort();
      return;
    }
    // A pending confirm owns y/n/a (and swallows other keys) until answered.
    if (pendingConfirmRef.current) {
      const choice = confirmChoiceForKey(_input);
      if (choice === "yes") resolveConfirm(true, false);
      else if (choice === "no") resolveConfirm(false, false);
      else if (choice === "always") resolveConfirm(true, true);
      return;
    }
    // Autocomplete popover navigation: ↑/↓ or Ctrl-P/Ctrl-N move, Tab/Enter accept.
    // Other keys fall through so typing keeps filtering the list.
    if (completeOpenRef.current) {
      if (key.upArrow || (key.ctrl && _input === "p")) return moveSel(-1);
      if (key.downArrow || (key.ctrl && _input === "n")) return moveSel(1);
      if ((key.tab && !key.shift) || (key.return && !key.shift && !key.meta)) {
        return acceptCompletion();
      }
    }
    if (pendingPlanRef.current && !key.ctrl && !key.meta) {
      const choice = planChoiceForKey(_input);
      if (choice === "accept") acceptPlan();
      else if (choice === "edit") editPlan();
      else if (choice === "reject") rejectPlan();
      return;
    }
    if (key.tab && key.shift) {
      cycleMode();
      return;
    }
    if (key.ctrl && _input === "r") setVerbose((v) => !v);
  });

  const modeColor = themeModeColor(mode);
  const thinkLabel = thinking === "off" ? "no-think" : describeLevel(thinking);

  // ── `/` autocomplete suggestions, recomputed each render from the input ──
  // Only while the prompt is an in-progress slash command and the popover isn't
  // dismissed/busy/blocked by a plan. The refs are mirrored for the key handler.
  const completeActive = !busy && !pendingPlan && input.startsWith("/") && !completeDismissed;
  const suggestions = completeActive
    ? completions(input, buildCompletionContext(props.config, props.store))
    : [];
  const completeOpen = suggestions.length > 0;
  const sel = completeOpen ? Math.min(Math.max(selected, 0), suggestions.length - 1) : 0;
  completeOpenRef.current = completeOpen;
  completionsRef.current = suggestions;
  selRef.current = sel;

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(item) => <ItemView key={item.id} item={item} expanded={verbose} />}
      </Static>

      {live.length > 0 ? (
        <Box flexDirection="column">
          {live.map((item) => (
            <ItemView key={item.id} item={item} expanded={verbose} />
          ))}
        </Box>
      ) : null}

      {pendingConfirm ? (
        <ConfirmView preview={pendingConfirm} />
      ) : pendingPlan ? (
        <PlanView plan={pendingPlan} />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {completeOpen ? <Complete items={suggestions} selected={sel} /> : null}
          <Box>
            {busy ? (
              <Text color="yellow">
                <Spinner type="dots" />{" "}
              </Text>
            ) : (
              <Text color="cyan">{"› "}</Text>
            )}
            <MultilineInput
              value={input}
              onChange={handleInputChange}
              onSubmit={onSubmit}
              capture={completeOpen}
              cursorNonce={cursorNonce}
              onHistoryPrev={historyPrev}
              onHistoryNext={historyNext}
              placeholder={busy ? "working… (Esc to abort)" : "message, or /help · Shift+Enter for newline"}
            />
          </Box>
        </Box>
      )}

      <Box>
        <Text dimColor>{modelLabel}</Text>
        <Text dimColor>{" · "}</Text>
        <Text color={modeColor}>{mode}</Text>
        <Text dimColor>{` · ${thinkLabel} · $${cost.toFixed(4)}`}</Text>
        {verbose ? <Text dimColor>{" · verbose"}</Text> : null}
      </Box>
    </Box>
  );
}

/** Launch the Ink TUI. The caller resolves config/provider/system and passes them in. */
export function startTui(props: AppProps): void {
  // exitOnCtrlC:false — the App handles Ctrl+C itself (abort once, quit twice).
  render(<App {...props} />, { exitOnCtrlC: false });
}
