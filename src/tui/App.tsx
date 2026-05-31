// tui/App.tsx — the Ink interactive TUI: scrollback + input box + status line.
//
// This is the second front-end over the shared agent engine (`runAgent`). The
// headless path (index.ts) streams to stdout and exits; the TUI keeps a running
// session: a scrollback of past exchanges (Ink `<Static>`), a live region for the
// turn in flight, a prompt box (`ink-text-input`), and a status line
// (model · mode · thinking · $cost). Slash commands are parsed by commands.ts and
// applied against this component's state.
//
// Tool-call rendering here is intentionally simple (one line per call); the richer
// collapsed/expandable Message view and the plan accept/edit/reject box land in
// their own Phase-4 tasks. Esc aborts the in-flight request.

import { useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

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
import { dispatchCommand } from "../commands.ts";
import {
  budgetFor,
  describeLevel,
  supportsThinking,
  type ThinkingLevel,
} from "../thinking.ts";

// ── Display items ───────────────────────────────────────────────────────────────
// The transcript is rendered as a flat list of typed items. Finished items live in
// the `<Static>` scrollback; the in-flight turn accumulates in `live` and is moved
// into the scrollback when the turn completes.

type Item =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "tool"; toolId: string; name: string; input: unknown; result?: string; isError?: boolean; pending: boolean }
  | { id: number; kind: "note"; text: string; tone?: "info" | "error" };

/** Distributive `Omit` so each union member keeps its own shape (a plain
 * `Omit<Item, "id">` collapses to the members' common keys). */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type ItemInput = DistributiveOmit<Item, "id">;

/** Compact one-line rendering of a tool's input arguments. */
function fmtInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s === "{}" || s === undefined) return "";
  return s.length > 72 ? `${s.slice(0, 71)}…` : s;
}

function ItemView({ item }: { item: Item }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan" bold>{"› "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return <Text>{item.text}</Text>;
    case "thinking":
      return <Text dimColor>{`💭 ${item.text}`}</Text>;
    case "tool": {
      const mark = item.pending ? "…" : item.isError ? "✗" : "✓";
      const color = item.pending ? "yellow" : item.isError ? "red" : "green";
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color}>{`⚙ ${item.name}`}</Text>
            <Text dimColor>{` ${fmtInput(item.input)} ${mark}`}</Text>
          </Box>
          {item.isError && item.result ? (
            <Text color="red">{`  ${item.result.split("\n")[0].slice(0, 200)}`}</Text>
          ) : null}
        </Box>
      );
    }
    case "note":
      return <Text color={item.tone === "error" ? "red" : "gray"}>{item.text}</Text>;
  }
}

// ── The component ────────────────────────────────────────────────────────────────

interface AppProps {
  config: Config;
  /** Initial provider + model, already resolved by the launcher. */
  provider: Provider;
  modelName: string;
  modelLabel: string;
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
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  const [history, setHistory] = useState<Item[]>(() =>
    props.startupNotes.map((text) => ({ id: nextId(), kind: "note" as const, text })),
  );
  const [live, setLive] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AgentMode>("normal");
  const [thinking, setThinking] = useState<ThinkingLevel>("off");
  const [modelLabel, setModelLabel] = useState(props.modelLabel);
  const [cost, setCost] = useState(0);

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
  async function runTurn(): Promise<void> {
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    const runMode = mode;
    const system = systemForMode(props.baseSystem, runMode);
    let tools = buildTools(controller.signal);
    if (runMode === "plan") tools = tools.filter((t) => t.readOnly);

    const budget = supportsThinking(providerRef.current.id) ? budgetFor(thinking) : 0;
    const maxTurns = runMode === "auto" ? props.config.autoMaxTurns : 25;

    // The in-flight turn is built up here and mirrored into React state for render.
    const local: Item[] = [];
    const sync = () => setLive([...local]);
    let compacted = false;

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
      local.push({ id: nextId(), kind: "note", text: `cc: ${(err as Error).message}`, tone: "error" });
    } finally {
      flush(compacted);
      // Move the completed turn into the scrollback and clear the live region.
      const finished = [...local];
      setHistory((prev) => [...prev, ...finished]);
      setLive([]);
      controllerRef.current = null;
      setBusy(false);
    }
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
        props.store.close();
        app.exit();
        break;
      case "error":
        note(action.message, "error");
        break;
    }
  }

  // Esc aborts an in-flight request.
  useInput((_input, key) => {
    if (key.escape && controllerRef.current) controllerRef.current.abort();
  });

  const modeColor = mode === "plan" ? "cyan" : mode === "auto" ? "yellow" : "green";
  const thinkLabel = thinking === "off" ? "no-think" : describeLevel(thinking);

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <ItemView key={item.id} item={item} />}</Static>

      {live.length > 0 ? (
        <Box flexDirection="column">
          {live.map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        {busy ? (
          <Text color="yellow">
            <Spinner type="dots" />{" "}
          </Text>
        ) : (
          <Text color="cyan">{"› "}</Text>
        )}
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={busy ? "working… (Esc to abort)" : "message, or /help"}
        />
      </Box>

      <Box>
        <Text dimColor>{modelLabel}</Text>
        <Text dimColor>{" · "}</Text>
        <Text color={modeColor}>{mode}</Text>
        <Text dimColor>{` · ${thinkLabel} · $${cost.toFixed(4)}`}</Text>
      </Box>
    </Box>
  );
}

/** Launch the Ink TUI. The caller resolves config/provider/system and passes them in. */
export function startTui(props: AppProps): void {
  render(<App {...props} />);
}
