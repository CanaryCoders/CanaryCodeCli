// tui/App.tsx — the Ink interactive TUI: scrollback + input box + status line.
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

import { Box, render, Static, useInput, useStdout } from "ink";
import { useEffect, useReducer, useRef } from "react";
import { describeLevel } from "../thinking.ts";
import { LiveRegion, PromptArea } from "./AppViews.tsx";
import type { AppProps } from "./app-types.ts";
import { confirmChoiceForKey } from "./confirm-helpers.ts";
import { Footer } from "./Footer.tsx";
import { ItemView } from "./Message.tsx";
import { statusVerb } from "./message-helpers.ts";
import { planChoiceForKey } from "./plan-helpers.ts";
import { Tasks } from "./Tasks.tsx";
import { modeColor as themeModeColor } from "./theme.ts";
import { useAgentSession } from "./use-agent-session.ts";
import { useApprovals } from "./use-approvals.ts";
import { useAutocomplete } from "./use-autocomplete.ts";
import { usePasteChips } from "./use-paste-chips.ts";
import { usePromptHistory } from "./use-prompt-history.ts";
import { usePromptInput } from "./use-prompt-input.ts";
import { useTranscript } from "./use-transcript.ts";

// ── The component ────────────────────────────────────────────────────────────────
// The transcript is rendered as a flat list of typed `Item`s (see Message.tsx).
// Finished items live in the `<Static>` scrollback; the in-flight turn accumulates
// in `live` and is moved into the scrollback when the turn completes.

function App(props: AppProps): React.ReactElement {
  // Terminal size, used to cap the live (in-flight) region so it never grows past
  // the viewport — overflowing the dynamic region desyncs Ink's redraw and
  // duplicates lines into the scrollback. `<Static>` scrollback is printed once
  // and is unaffected by height.
  const { stdout } = useStdout();
  // Ink's `useStdout` does NOT subscribe to terminal resizes, so dimensions read
  // during render would otherwise go stale until an unrelated re-render. Force a
  // re-render on every `resize` event so the live-region cap and content widths
  // recompute against the new size.
  const [, bumpResize] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      // On resize the terminal reflows the previously-written dynamic frame to the
      // new width, but Ink's eraser only erases `previousLineCount` lines measured
      // at the OLD width — so when the terminal narrows the frame now occupies more
      // physical rows than Ink erases, and the un-erased top rows survive as the
      // broken/duplicated input boxes. Ink's own resize handler can't fix this
      // (same stale count). Wipe the whole viewport ourselves, then reset Ink's
      // line bookkeeping via clear() so its next render redraws from a clean slate,
      // and bump a re-render so content widths recompute against the new size.
      // Erase only the visible screen (not the scrollback buffer — no \x1b[3J — so
      // history the user scrolled past is preserved) and home the cursor.
      stdout.write("\x1b[2J\x1b[H");
      props.inkInstance?.current?.clear();
      bumpResize();
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, props.inkInstance]);

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
      appName: "cc",
      version: props.version,
      cwd: process.cwd(),
      model: props.modelLabel,
      provider: props.provider.id,
    },
    startupNotes: props.startupNotes,
  });

  // The prompt buffer + its cursor nonce (bumped on out-of-band sets).
  const promptInput = usePromptInput();

  // Pasted-text chips: a large paste is stored by id and embedded in the input
  // buffer as a single sentinel char (see Input.tsx). The buffer carries sentinels;
  // they are expanded to real text only when a prompt is sent.
  const { pasteMap, registerPaste } = usePasteChips();

  // Pause-and-ask interactions (confirm / checkpoint / ask_user / plan review) and
  // the composed approval gate — each suspends the agent loop on a promise until
  // the user answers.
  const approvals = useApprovals({
    config: props.config,
    note: transcript.note,
    getSignal: () => controllerRef.current?.signal,
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

  // The agent-session controller: run state + every turn-driving action.
  const session = useAgentSession({
    props,
    transcript,
    approvals,
    promptInput,
    promptHistory,
    pasteMap,
    controllerRef,
  });

  // Esc and Ctrl+C share handleCancel (cancel queue → clear prompt → abort →
  // quit); Ctrl+R toggles verbose tool output. While a plan awaits review the a/e/r
  // keys drive accept/edit/reject (TextInput is unmounted then, so they don't reach
  // the prompt). Pending gates own the keyboard until answered. The handler reads
  // live state via refs (Ink rebinds it each render, but the async loop mutates
  // state between renders).
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      session.handleCancel("Ctrl+C");
      return;
    }
    if (key.escape) {
      // Esc dismisses the autocomplete popover first; otherwise it escalates the
      // same way as Ctrl+C: cancel queued prompt → clear prompt → abort → quit.
      if (autocomplete.completeOpenRef.current) autocomplete.dismissComplete();
      else session.handleCancel("Esc");
      return;
    }
    // A pending ask owns the keyboard — AskUserView's own useInput drives the
    // wizard (↑/↓/space/enter); bow out so mode-cycle/verbose don't also fire.
    if (approvals.pendingAskRef.current) return;
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
  });

  const modeColor = themeModeColor(session.mode);
  const thinkLabel =
    session.thinking === "off" ? "no-think" : describeLevel(session.thinking);

  // The session's first tool call gets a one-time `ctrl+r to expand` hint so the
  // user discovers the verbose affordance. Its id is stable, so every other tool
  // (and re-render) leaves the hint to that single item.
  const firstToolId = [...transcript.history, ...transcript.live].find(
    (i) => i.kind === "tool",
  )?.id;

  // Short status verb shown beside the busy spinner ("thinking…", "running
  // bash…", "searching…"), derived from the live transcript's most recent item.
  const verb = statusVerb(transcript.live);

  // Ink's <Static> output is permanent, so keep the startup banner/notes dynamic
  // until a real conversation item exists. That lets an early `/model ...` repaint
  // the banner; once the conversation starts, history returns to static scrollback.
  const staticScrollback = transcript.history.some(
    (item) => item.kind !== "banner" && item.kind !== "note",
  );
  const renderHistoryItem = (
    item: (typeof transcript.history)[number],
    index: number,
  ) => (
    <ItemView
      key={item.id}
      item={item}
      prevKind={index > 0 ? transcript.history[index - 1]!.kind : undefined}
      expanded={session.verbose}
      showExpandHint={item.id === firstToolId}
    />
  );

  // Cap the live (in-flight) region to the terminal viewport. `live` holds only
  // the currently-streaming item (finished items have moved to `<Static>`), so the
  // one thing that can outgrow the screen is a long assistant/thinking block — we
  // show just its trailing lines while it streams. The complete, correctly-parsed
  // text still lands in the scrollback when the block finalises. Reserve rows for
  // the input frame, footer, gaps, and the trim marker; over-reserving only trims
  // a little more tail, which is harmless.
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  const liveCap = Math.max(3, rows - 10);
  // Reserve for the *deepest* nested gutter a live line can sit behind: the 2-cell
  // speaker gutter, plus the 2-cell `│ ` markdown rule that code-fence/indented
  // lines get nested inside it. Clamping to `columns - 2` left code lines 2 cols
  // too wide, so they soft-wrapped mid-word in the live region — and a wrapped
  // live line occupies a terminal row `tailLines` never budgeted, overflowing the
  // dynamic region and desyncing Ink into a flood of blank/duplicate lines.
  const liveContentWidth = Math.max(1, columns - 4);

  return (
    <Box flexDirection="column">
      {staticScrollback ? (
        <Static items={transcript.history}>{renderHistoryItem}</Static>
      ) : (
        <Box flexDirection="column">
          {transcript.history.map(renderHistoryItem)}
        </Box>
      )}

      <LiveRegion
        live={transcript.live}
        history={transcript.history}
        verbose={session.verbose}
        firstToolId={firstToolId}
        liveCap={liveCap}
        liveContentWidth={liveContentWidth}
      />

      <Tasks tasks={session.tasks} />

      <PromptArea
        approvals={approvals}
        session={session}
        autocomplete={autocomplete}
        promptInput={promptInput}
        promptHistory={promptHistory}
        registerPaste={registerPaste}
        pasteMap={pasteMap}
        modeColor={modeColor}
        verb={verb}
        columns={columns}
      />

      <Footer
        modelLabel={session.modelLabel}
        mode={session.mode}
        modeColor={modeColor}
        thinkLabel={thinkLabel}
        cost={session.cost}
        tokens={session.tokens}
        verbose={session.verbose}
      />
    </Box>
  );
}

/** Launch the Ink TUI. The caller resolves config/provider/system and passes them in. */
export function startTui(props: AppProps): void {
  // exitOnCtrlC:false — the App handles Ctrl+C itself (abort once, quit twice).
  // The instance ref lets the App clear the screen via Ink's own clear() (see
  // the /clear handler) instead of writing raw escape sequences, which desync
  // Ink's renderer and cause duplicated lines / runaway layout.
  const inkInstance: { current: { clear: () => void } | null } = {
    current: null,
  };
  const instance = render(<App {...props} inkInstance={inkInstance} />, {
    exitOnCtrlC: false,
  });
  inkInstance.current = instance;
}
