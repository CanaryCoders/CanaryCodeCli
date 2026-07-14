/** @jsxImportSource @opentui/react */
// tui/App.tsx — the OpenTUI interactive TUI: scrollback + input box + status line.
//
// This is the second front-end over the shared agent engine (`runAgent`). The
// headless path (index.ts) streams to stdout and exits; the TUI keeps a running
// session: a scrollback of past exchanges (Ink `<Static>`), a live region for the
// turn in flight, a prompt box, and a status line (model · mode · thinking · $cost).
//
// The component is a thin shell: it composes purpose-built hooks — the transcript
// (use-transcript), the prompt buffer (use-prompt-input), prompt history, paste
// chips, the `/` autocomplete popover (use-autocomplete), the pause-and-ask gates
// (use-approvals), and the agent-session controller that drives turns and slash
// commands (use-agent-session) — then wires their state into the keyboard handler
// and the render tree. Item rendering lives in Message.tsx.
//
// Esc and Ctrl+C share one escalation (use-agent-session's handleCancel): cancel a
// queued prompt → clear the prompt → abort the in-flight request → quit (the last
// step needs a second press). Ctrl+R toggles verbose tool output; Shift+Tab cycles
// the mode (normal → plan → auto → normal).

import { type CliRenderer, createCliRenderer } from "@opentui/core";
import {
  createRoot,
  type Root,
  useOnResize,
  useTerminalDimensions,
} from "@opentui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { describeLevel } from "../thinking.ts";
import { LiveRegion, PromptArea } from "./AppViews.tsx";
import type { AppProps } from "./app-types.ts";
import { confirmChoiceForKey } from "./confirm-helpers.ts";
import {
  copyTargetToClipboard,
  groupCopyText,
  resolveItemCopyTarget,
  writeTextToClipboard,
} from "./copy-targets.ts";
import { editPromptInEditor } from "./external-editor.ts";
import { Footer } from "./Footer.tsx";
import { IconProvider } from "./Icon.tsx";
import { ActionChip } from "./Interactive.tsx";
import { isRawEscapeInput } from "./input-helpers.ts";
import { useTuiInput } from "./keyboard.ts";
import { type Item, ItemView } from "./Message.tsx";
import { statusVerb } from "./message-helpers.ts";
import { planChoiceForKey } from "./plan-helpers.ts";
import { Box, ScrollBox } from "./primitives.tsx";
import { type TuiRuntime, TuiRuntimeContext } from "./runtime.tsx";
import { Tasks } from "./Tasks.tsx";
import { modeColor as themeModeColor } from "./theme.ts";
import { isItemExpanded, toggleToolExpanded } from "./tool-expansion.ts";
import {
  firstFocusId,
  focusGroup,
  lastFocusId,
  moveFocus,
} from "./transcript-nav.ts";
import { useAgentSession } from "./use-agent-session.ts";
import { useApprovals } from "./use-approvals.ts";
import { useAutocomplete } from "./use-autocomplete.ts";
import { useHelp } from "./use-help.ts";
import { usePasteChips } from "./use-paste-chips.ts";
import { usePastePreview } from "./use-paste-preview.ts";
import { usePromptHistory } from "./use-prompt-history.ts";
import { usePromptInput } from "./use-prompt-input.ts";
import { useScrollFollow } from "./use-scroll-follow.ts";
import { useTranscript } from "./use-transcript.ts";

// ── The component ────────────────────────────────────────────────────────────────
// The transcript is rendered as a flat list of typed `Item`s (see Message.tsx).
// Finished items live in the `<Static>` scrollback; the in-flight turn accumulates
// in `live` and is moved into the scrollback when the turn completes.

let openTuiRenderer: CliRenderer | null = null;
let openTuiRoot: Root | null = null;
// The transcript note callback, surfaced at module scope so the renderer's
// "selection" handler (registered in startTui, outside the component) can push a
// note when drag-select auto-copy falls back to a temp file. The App component
// keeps it fresh each render (see `noteRef` below).
let selectionNote: ((text: string, tone?: "info" | "error") => void) | null =
  null;

function App(props: AppProps): React.ReactNode {
  const dimensions = useTerminalDimensions();
  const [resizeNonce, bumpResize] = useReducer((n: number) => n + 1, 0);
  useOnResize(() => {
    bumpResize();
    openTuiRenderer?.requestRender();
  });

  // The in-flight request's abort controller is shared between the agent session
  // (which creates/aborts it) and the approval gate (whose AI safety check reads
  // its signal), so it lives here in the shell and is passed to both.
  const controllerRef = useRef<AbortController | null>(null);

  // The rendered transcript: finished scrollback + the live turn, plus `push`/`note`
  // and the id allocator the other hooks build on. The launch banner is the first
  // <Static> item so it scrolls away naturally; startup notes follow it.
  const transcript = useTranscript({
    banner: {
      kind: "banner",
      appName: "canarycode",
      version: props.version,
      cwd: process.cwd(),
      model: props.modelLabel,
      provider: props.provider.id,
    },
    startupNotes: props.startupNotes,
  });

  // The prompt buffer + its cursor nonce (bumped on out-of-band sets).
  const promptInput = usePromptInput();

  // Keyboard transcript nav mode: null = insert mode (prompt active); a non-null id
  // is the focused scrollback item (nav mode). Entry is Ctrl+Up / Ctrl+K / `/copy`;
  // j/k/g/G walk it, Enter expands a tool, y/Y/c/o yank, i/Esc returns to the prompt.
  const [focusedId, setFocusedId] = useState<number | null>(null);

  // Transcript scroll-follow: tracks whether the scrollbox is pinned to the
  // newest content (drives the "jump to latest" banner) and exposes the jump
  // actions the banner click and End/Home keys route to.
  const scrollFollow = useScrollFollow();

  // Pasted-text chips: a large paste is stored by id and embedded in the input
  // buffer as a single sentinel char (see Input.tsx). The buffer carries sentinels;
  // they are expanded to real text only when a prompt is sent.
  const { pasteMap, registerPaste } = usePasteChips();

  // Paste-chip preview: clicking a `[Pasted …]` chip in the prompt opens a
  // read-only popover (above the input frame) showing the stored text. While it is
  // open the editor pauses; `pastePreview.openRef` lets the global Esc handler tell
  // the preview is open and close it without escalating the cancel chain.
  const pastePreview = usePastePreview();

  // Keyboard & mouse help overlay: the footer `?` chip (and `?` on an empty
  // prompt) opens a modal cheat-sheet above the input frame. While it is open the
  // editor pauses; `help.openRef` lets the global key handler tell it is open and
  // close it on Esc without escalating the cancel chain (and swallow stray keys).
  const help = useHelp();
  const [externalEditorOpen, setExternalEditorOpen] = useState(false);
  const externalEditorOpenRef = useRef(false);

  // Dismissing a pending ask_user question takes a deliberate SECOND Esc. A single
  // Esc — a mis-tap, or a focus/paste/response byte some terminals emit that the key
  // parser surfaces as an escape — must NOT silently drop the question and feed the
  // model a false "dismissed"; that was the box "flashing away" with no keypress.
  // The first Esc only arms a hint (auto-disarmed after a moment, or by any other
  // key); the second confirms. A dismiss resolves the ask as unanswered but does
  // NOT abort the turn — Ctrl+C stays the hard "cancel everything" escape hatch.
  const askDismissArmedRef = useRef(false);
  const askDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pause-and-ask interactions (confirm / checkpoint / ask_user / plan review) and
  // the composed approval gate — each suspends the agent loop on a promise until
  // the user answers.
  const approvals = useApprovals({
    config: props.config,
  });

  // Shell-style prompt history (Up/Down at the input boundary).
  const promptHistory = usePromptHistory({
    getInput: () => promptInput.inputRef.current,
    setInput: promptInput.setInput,
    bumpCursor: promptInput.bumpCursor,
  });

  // The `/` autocomplete popover — suggestions recomputed each render from the input.
  const autocomplete = useAutocomplete({
    input: promptInput.input,
    planActive: approvals.pendingPlan !== null,
    setInput: promptInput.setInput,
    bumpCursor: promptInput.bumpCursor,
    onEdit: promptHistory.resetBrowsing,
    config: props.config,
    store: props.store,
  });

  const openExternalEditor = useCallback(() => {
    if (externalEditorOpenRef.current) return;
    externalEditorOpenRef.current = true;
    setExternalEditorOpen(true);
    editPromptInEditor({
      initialText: promptInput.inputRef.current,
      renderer: openTuiRenderer,
    })
      .then((next) => {
        if (next === null) return;
        autocomplete.handleInputChange(next);
        promptInput.bumpCursor();
      })
      .catch((err: unknown) => {
        noteRef.current(`editor failed: ${(err as Error).message}`, "error");
      })
      .finally(() => {
        externalEditorOpenRef.current = false;
        setExternalEditorOpen(false);
        openTuiRenderer?.requestRender();
      });
  }, [
    autocomplete.handleInputChange,
    promptInput.bumpCursor,
    promptInput.inputRef,
  ]);

  const runtime = useMemo<TuiRuntime>(
    () => ({
      clear: () => openTuiRenderer?.requestRender(),
      exit: () => {
        openTuiRoot?.unmount();
        openTuiRenderer?.destroy();
        openTuiRoot = null;
        openTuiRenderer = null;
      },
      columns: () => dimensions.width ?? 80,
      rows: () => dimensions.height ?? 24,
    }),
    [dimensions.width, dimensions.height],
  );

  // `/copy` enters nav mode (focus the newest block). Nav state lives here in the
  // shell; the session calls this through a ref so it always reaches the freshest
  // transcript. No-op when there's nothing focusable.
  const enterNavMode = useCallback(() => {
    setFocusedId((id) => lastFocusId(transcript.history) ?? id);
  }, [transcript.history]);

  // The agent-session controller: run state + every turn-driving action.
  const session = useAgentSession({
    props,
    transcript,
    approvals,
    promptInput,
    promptHistory,
    pasteMap,
    controllerRef,
    runtime,
    enterNavMode,
  });

  // Assemble the session once the UI has painted — runTui defers it here (rather
  // than awaiting before launch) so a slow MCP server (assembly connects them)
  // never delays first paint. The call is idempotent; the ref keeps the mount-once
  // effect off the session's per-render identity without a stale closure.
  const startSessionRef = useRef(session.startSession);
  startSessionRef.current = session.startSession;
  const noteRef = useRef(transcript.note);
  noteRef.current = transcript.note;
  // Keep the module-level note callback pointed at the live transcript so the
  // renderer's "selection" handler (outside this component) can surface the
  // auto-copy temp-file fallback path.
  selectionNote = transcript.note;
  useEffect(() => {
    // Per-feature errors (per-server MCP failures, etc.) are reported inside
    // assembly via the note callback; this catch guards an unexpected throw so it
    // cannot become an invisible unhandled rejection.
    startSessionRef.current().catch((err: unknown) => {
      noteRef.current(
        `session startup failed: ${(err as Error).message}`,
        "error",
      );
    });
  }, []);

  // Esc and Ctrl+C share handleCancel (cancel queue → clear prompt → abort →
  // quit); Ctrl+R toggles verbose tool output. While a plan awaits review the a/e/r
  // keys drive accept/edit/reject (TextInput is unmounted then, so they don't reach
  // the prompt). Pending gates own the keyboard until answered. The handler reads
  // live state via refs (Ink rebinds it each render, but the async loop mutates
  // state between renders).
  useTuiInput((_input, key) => {
    if (externalEditorOpenRef.current) return;
    if (key.ctrl && _input === "c") {
      session.handleCancel("Ctrl+C");
      return;
    }
    // A pending ask_user question owns the keyboard: AskUserView's own useInput
    // drives the wizard (↑/↓/space/enter). App intercepts ONLY Esc here — BEFORE the
    // Esc-cancel branch below — so an ask can never escalate to a turn abort, and a
    // lone stray/mis-parsed escape can't drop the question. Dismissing is a
    // deliberate two-step and resolves the ask as unanswered WITHOUT aborting; every
    // other key is left to AskUserView (we bow out so mode-cycle/verbose don't fire).
    if (approvals.pendingAskRef.current) {
      if (key.escape || isRawEscapeInput(_input)) {
        if (askDismissTimerRef.current)
          clearTimeout(askDismissTimerRef.current);
        if (askDismissArmedRef.current) {
          askDismissArmedRef.current = false;
          approvals.resolveAsk(null);
          return;
        }
        askDismissArmedRef.current = true;
        noteRef.current("press Esc again to dismiss the question", "info");
        askDismissTimerRef.current = setTimeout(() => {
          askDismissArmedRef.current = false;
        }, 1500);
        return;
      }
      // Any other key means the user is engaging with the wizard — disarm a
      // half-pressed dismiss so a stray Esc can't linger and combine with a later one.
      if (askDismissArmedRef.current) {
        askDismissArmedRef.current = false;
        if (askDismissTimerRef.current)
          clearTimeout(askDismissTimerRef.current);
      }
      return;
    }
    // Keyboard nav mode owns the keyboard while a scrollback item is focused: j/k
    // (or ↑/↓) walk it, g/G jump to top/bottom, Enter/Space toggle a focused tool,
    // y/Y/c/o yank, i/Esc return to the prompt. Handled BEFORE the Esc escalation so
    // Esc here only exits nav (never aborts/quits). Any other key is swallowed so a
    // stray letter can't leak into the (inert) prompt. This whole block is skipped
    // when not in nav mode, so every binding below stays intact.
    if (focusedId !== null) {
      const history = transcript.history;
      const focused = history.find((i) => i.id === focusedId);
      if (key.escape || isRawEscapeInput(_input) || _input === "i") {
        setFocusedId(null);
        return;
      }
      if (_input === "j" || key.downArrow) {
        setFocusedId((id) => moveFocus(history, id, 1));
        return;
      }
      if (_input === "k" || key.upArrow) {
        setFocusedId((id) => moveFocus(history, id, -1));
        return;
      }
      if (_input === "g") {
        setFocusedId(firstFocusId(history));
        return;
      }
      if (_input === "G") {
        setFocusedId(lastFocusId(history));
        return;
      }
      if ((key.return && !key.shift && !key.meta) || _input === " ") {
        // Enter/Space expands or collapses a focused tool card; a no-op otherwise.
        if (focused?.kind === "tool") toggleTool(focused.id);
        return;
      }
      if (_input === "y") {
        if (focused) void copyItem(focused, "default");
        return;
      }
      if (_input === "Y") {
        // Yank the whole answer group the focused item belongs to.
        if (focused) yankGroup(focusGroup(history, focused.id));
        return;
      }
      if (_input === "c") {
        if (focused?.kind === "tool") void copyItem(focused, "command");
        return;
      }
      if (_input === "o") {
        if (focused?.kind === "tool") void copyItem(focused, "output");
        return;
      }
      // Swallow every other key so it can't leak into the inert prompt.
      return;
    }
    if (key.escape || isRawEscapeInput(_input)) {
      // Esc dismisses the autocomplete popover first, then an open extensions
      // picker; otherwise it escalates the same way as Ctrl+C: cancel queued
      // prompt → clear prompt → abort → quit. A rapid Esc repeat can arrive as
      // raw "\x1b" bytes without key.escape set; handle that here so the prompt
      // input never inserts visible ^[ text.
      if (help.openRef.current) help.closeHelp();
      else if (pastePreview.openRef.current) pastePreview.close();
      else if (autocomplete.completeOpenRef.current)
        autocomplete.dismissComplete();
      else if (session.extensionsOpenRef.current) session.cancelExtensions();
      else session.handleCancel("Esc");
      return;
    }
    // The help overlay owns its keys (`?`/Esc handled by its own scoped handler;
    // Esc also handled above) — bow out for every other key so nothing leaks to
    // nav/mode-cycle/the prompt while it's open. Mirrors the paste-preview gate.
    if (help.openRef.current) return;
    if (
      key.ctrl &&
      _input === "g" &&
      !autocomplete.completeOpenRef.current &&
      !approvals.pendingPlanRef.current
    ) {
      openExternalEditor();
      return;
    }
    // Same for the `/extensions` picker — ExtensionsView owns ↑/↓/space/enter.
    if (session.extensionsOpenRef.current) return;
    // The paste-preview popover owns its keys (`y` copy; Esc handled above) — bow
    // out so no stray letter leaks to nav/mode-cycle while it's open.
    if (pastePreview.openRef.current) return;
    // A pending confirm owns y/n/a (and swallows other keys) until answered.
    if (approvals.pendingConfirmRef.current) {
      const choice = confirmChoiceForKey(_input);
      if (choice === "yes") approvals.resolveConfirm(true, false);
      else if (choice === "no") approvals.resolveConfirm(false, false);
      else if (choice === "always") approvals.resolveConfirm(true, true);
      return;
    }
    // A pending checkpoint owns y/n (Esc/Ctrl+C handled above stop the run).
    if (approvals.pendingCheckpointRef.current !== null) {
      const k = _input.toLowerCase();
      if (k === "y") approvals.resolveCheckpoint(true);
      else if (k === "n") approvals.resolveCheckpoint(false);
      return;
    }
    // Enter nav mode (focus the newest block) with Ctrl+Up or Ctrl+K — only when
    // idle and nothing else owns the keyboard (gates handled above, autocomplete
    // closed). A no-op when there's nothing focusable. `/copy` is the discoverable
    // equivalent. Placed after the gate early returns so it can't steal their keys.
    if (
      key.ctrl &&
      (key.upArrow || _input === "k") &&
      !autocomplete.completeOpenRef.current &&
      !approvals.pendingPlanRef.current
    ) {
      const last = lastFocusId(transcript.history);
      if (last !== null) setFocusedId(last);
      return;
    }
    // End/Home scroll the transcript when nothing else owns those keys: the
    // autocomplete popover is closed, no plan review is pending, and the prompt is
    // empty. The empty-prompt guard scopes this to the idle case so it never
    // interferes while typing a message. End jumps to the newest output and
    // re-engages sticky-follow; Home jumps to the oldest. PageUp/PageDown are left
    // to the scrollbox's own native handling.
    if (
      (key.end || key.home) &&
      !key.ctrl &&
      !key.meta &&
      !autocomplete.completeOpenRef.current &&
      !approvals.pendingPlanRef.current &&
      promptInput.inputRef.current === ""
    ) {
      if (key.end) scrollFollow.jumpToLatest();
      else scrollFollow.jumpToOldest();
      return;
    }
    // `?` opens the help overlay — but only when idle and safe: the prompt is
    // empty (so `?` still types into a non-empty message), no plan review is
    // pending, and the autocomplete popover is closed. The gates/nav/preview above
    // already early-returned, so reaching here means none own the keyboard. Guarded
    // like the End/Home block so it never shadows a typed `?`.
    if (
      _input === "?" &&
      !key.ctrl &&
      !key.meta &&
      !autocomplete.completeOpenRef.current &&
      !approvals.pendingPlanRef.current &&
      promptInput.inputRef.current === ""
    ) {
      help.openHelp();
      return;
    }
    // Autocomplete popover navigation: ↑/↓ or Ctrl-P/Ctrl-N move, Tab/Enter accept.
    // Other keys fall through so typing keeps filtering the list.
    if (autocomplete.completeOpenRef.current) {
      if (key.upArrow || (key.ctrl && _input === "p"))
        return autocomplete.moveSel(-1);
      if (key.downArrow || (key.ctrl && _input === "n"))
        return autocomplete.moveSel(1);
      if ((key.tab && !key.shift) || (key.return && !key.shift && !key.meta)) {
        return autocomplete.acceptCompletion();
      }
    }
    if (approvals.pendingPlanRef.current && !key.ctrl && !key.meta) {
      const choice = planChoiceForKey(_input);
      if (choice === "accept") session.acceptPlan();
      else if (choice === "edit") session.editPlan();
      else if (choice === "reject") session.rejectPlan();
      return;
    }
    if (key.tab && key.shift) {
      session.cycleMode();
      return;
    }
    if (key.ctrl && _input === "r") session.setVerbose((v) => !v);
    // Ctrl+V: paste an image from the clipboard (\x16 is the raw SYN some
    // terminals send for Ctrl+V). Text pastes arrive via the input itself.
    if (key.ctrl && (_input === "v" || _input === "\x16"))
      session.attachClipboardImage();
  });

  const modeColor = themeModeColor(session.mode);
  const thinkLabel =
    session.thinking === "off" ? "no-think" : describeLevel(session.thinking);

  // The session's first tool call gets a one-time `click/enter expands · ctrl+r
  // expands all` hint so the user discovers the expand affordances. Its id is
  // stable, so every other tool (and re-render) leaves the hint to that single item.
  const firstToolId = [...transcript.history, ...transcript.live].find(
    (i) => i.kind === "tool",
  )?.id;

  // Per-tool expansion: clicking one tool card toggles just that tool, tracked
  // by id. This is independent of `session.verbose` (Ctrl+R = expand all) —
  // `isItemExpanded` ORs the two together.
  const [expandedToolIds, setExpandedToolIds] = useState<Set<number>>(
    () => new Set(),
  );
  const toggleTool = useCallback((id: number) => {
    setExpandedToolIds((s) => toggleToolExpanded(s, id));
  }, []);

  // Copy a transcript item (or one of a tool card's command/output chips) to the
  // system clipboard, falling back to a temp file when no clipboard tool exists.
  // Either way the outcome is surfaced as a scrollback note. transcript.note is
  // read through a ref so this callback stays stable across renders.
  const copyItem = useCallback(
    async (item: Item, kind: "default" | "command" | "output" = "default") => {
      const target = resolveItemCopyTarget(item, kind);
      if (!target) {
        noteRef.current("nothing to copy", "info");
        return;
      }
      // Success and the temp-file fallback are both informative outcomes, so
      // both land as info notes — copyTargetToClipboard frames the wording. A
      // rejection is guarded so it can't become an unhandled rejection,
      // mirroring yankGroup's .catch path.
      try {
        noteRef.current(await copyTargetToClipboard(target), "info");
      } catch (err) {
        noteRef.current(`copy failed: ${(err as Error).message}`, "error");
      }
    },
    [],
  );

  // Yank a whole answer group (nav `Y`): concatenate the members' source text and
  // copy it as one "group" target, surfacing the outcome as a note — mirroring
  // copyItem's note path. A rejection is guarded so it can't become an unhandled
  // rejection. note() reads through a ref so this stays stable across renders.
  const yankGroup = useCallback((items: Item[]): void => {
    const text = groupCopyText(items);
    if (!text) {
      noteRef.current("nothing to copy", "info");
      return;
    }
    copyTargetToClipboard({ kind: "message", label: "group", text })
      .then((msg) => noteRef.current(msg, "info"))
      .catch((err) =>
        noteRef.current(`copy failed: ${(err as Error).message}`, "error"),
      );
  }, []);

  // Short status verb shown beside the busy spinner ("thinking…", "running
  // bash…", "searching…"), derived from the live transcript's most recent item.
  const verb = statusVerb(transcript.live);

  // History always renders in Ink's <Static>: its output is written once and never
  // re-erased, so it is immune to the dynamic-region redraw desync (Ink miscounts a
  // tall/full-width frame's height and leaks its topmost line). Keeping the banner
  // in the dynamic region — to repaint its model text on an early `/model` — caused
  // exactly that: one duplicate banner top border per keystroke. The footer already
  // reflects the live model, so the banner stays a launch-time snapshot.
  const renderHistoryItem = (
    item: (typeof transcript.history)[number],
    index: number,
  ) => (
    <ItemView
      key={item.id}
      item={item}
      prevKind={index > 0 ? transcript.history[index - 1]!.kind : undefined}
      expanded={isItemExpanded(item, session.verbose, expandedToolIds)}
      showExpandHint={item.id === firstToolId}
      columns={columns}
      // Nav focus: tools highlight via `focusedToolId`; box-less items via
      // `itemFocused`. Both resolve from the same focused id (null in insert mode).
      focusedToolId={focusedId}
      itemFocused={item.id === focusedId}
      onToggleTool={toggleTool}
      onCopyItem={copyItem}
    />
  );

  // Cap the live (in-flight) region to the terminal viewport. `live` holds only
  // the currently-streaming item (finished items have moved to `<Static>`), so the
  // one thing that can outgrow the screen is a long assistant/thinking block — we
  // show just its trailing lines while it streams. The complete, correctly-parsed
  // text still lands in the scrollback when the block finalises. Reserve rows for
  // the input frame, footer, gaps, and the trim marker; over-reserving only trims
  // a little more tail, which is harmless.
  const rows = runtime.rows();
  const columns = runtime.columns();
  // Reserve rows for the input bar, footer, gaps, the trim marker, AND the
  // streaming assistant card's chrome (title row + top/bottom vertical padding +
  // above-gap). Over-reserving only trims a little more tail, which is harmless.
  const liveCap = Math.max(3, rows - 14);
  // Clamp each live line so it never soft-wraps (a wrapped live line occupies a
  // terminal row `tailLines` never budgeted). Reserve for the *deepest* place a
  // live line can sit: inside the assistant card (2 padding cells), plus the
  // 2-cell `│ ` markdown rule that code-fence/indented lines nest in, with a
  // little slack.
  const liveContentWidth = Math.max(1, columns - 6);

  return (
    <TuiRuntimeContext.Provider value={runtime}>
      <IconProvider config={props.config}>
        {/* Viewport-height column: the transcript scrolls inside a flexGrow
            scrollbox while the tasks panel, input box, and footer stay pinned to
            the bottom of the terminal (they were scrolling off-screen when a long
            conversation overflowed a plain column). */}
        <Box flexDirection="column" height={rows}>
          {/* Finished transcript scrolls inside the flexGrow scrollbox; it's the
              only flexible child (flexShrink + minHeight:0), so it gives up height
              first and the bottom chrome below it never gets squeezed. */}
          <ScrollBox
            key={`transcript-${resizeNonce}`}
            ref={scrollFollow.ref}
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            width={columns}
            stickyScroll
            stickyStart="bottom"
            scrollY
          >
            <Box flexDirection="column" width={columns}>
              {transcript.history.map(renderHistoryItem)}
              <LiveRegion
                live={transcript.live}
                history={transcript.history}
                verbose={session.verbose}
                firstToolId={firstToolId}
                liveCap={liveCap}
                liveContentWidth={liveContentWidth}
                expandedToolIds={expandedToolIds}
                onToggleTool={toggleTool}
                onCopyItem={copyItem}
              />
            </Box>
          </ScrollBox>

          {/* Bottom chrome — the jump-to-latest banner, tasks, input box, and footer
              — pinned to the terminal bottom. flexShrink:0 keeps it at full height
              (it was getting compacted/clipped when the scrollbox grew). The
              in-flight turn renders in the transcript scrollbox above, so the
              toolbar top stays reserved for queue/spinner/status rows only. */}
          <Box flexDirection="column" flexShrink={0}>
            {/* Shown only while the user has scrolled up away from the newest
                content. It lives OUTSIDE the scrollbox so its click isn't swallowed
                by the scroll region's mouse handling. Clicking it (or pressing End)
                jumps to the latest output and re-engages sticky-follow. */}
            {!scrollFollow.atBottom && (
              <Box paddingLeft={1}>
                <ActionChip
                  label="↓ new messages · jump to latest"
                  color="gray"
                  onAction={scrollFollow.jumpToLatest}
                />
              </Box>
            )}

            <Tasks tasks={session.tasks} />

            <PromptArea
              approvals={approvals}
              session={session}
              autocomplete={autocomplete}
              promptInput={promptInput}
              promptHistory={promptHistory}
              registerPaste={registerPaste}
              pasteMap={pasteMap}
              pastePreview={pastePreview}
              help={help}
              modeColor={modeColor}
              verb={verb}
              columns={columns}
              navMode={focusedId !== null || externalEditorOpen}
              onOpenExternalEditor={openExternalEditor}
            />

            <Footer
              modelLabel={session.modelLabel}
              mode={session.mode}
              modeColor={modeColor}
              thinkLabel={thinkLabel}
              cost={session.cost}
              costKnown={session.costKnown}
              tokens={session.tokens}
              verbose={session.verbose}
              onCycleMode={session.cycleMode}
              onToggleVerbose={() => session.setVerbose((v) => !v)}
              onOpenHelp={help.openHelp}
              onOpenExternalEditor={openExternalEditor}
            />
          </Box>
        </Box>
      </IconProvider>
    </TuiRuntimeContext.Provider>
  );
}

/** Launch the OpenTUI TUI. The caller resolves config/provider/system and passes them in. */
export function startTui(props: AppProps): void {
  // exitOnCtrlC:false — the App handles Ctrl+C itself (abort once, quit twice).
  void createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    enableMouseMovement: true,
  }).then((renderer) => {
    openTuiRenderer = renderer;
    // Select-to-copy (every message kind): the renderer emits "selection" once,
    // on drag release (finishSelection). Copy the highlighted text to the system
    // clipboard, then clear the highlight so the copy "consumes" the selection.
    // A clean copy stays silent (a note on every drag-select would be noise); only
    // the temp-file fallback — when no clipboard tool exists — surfaces its path so
    // the text isn't silently stranded. The promise is fire-and-forget with a
    // guarded .catch so a write failure can't become an unhandled rejection.
    renderer.on(
      "selection",
      (selection: { getSelectedText(): string } | null) => {
        const text = selection?.getSelectedText() ?? "";
        if (text.length === 0) return;
        writeTextToClipboard(text)
          .then((r) => {
            if (!r.ok)
              selectionNote?.(
                `clipboard unavailable — wrote selection to ${r.path}`,
                "info",
              );
          })
          .catch(() => {});
        renderer.clearSelection();
      },
    );
    openTuiRoot = createRoot(renderer);
    openTuiRoot.render(<App {...props} />);
  });
}
