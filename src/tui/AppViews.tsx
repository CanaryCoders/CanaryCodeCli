// tui/AppViews.tsx — the two large render subtrees of the App shell.
//
// Pulled out of App.tsx so the component body stays focused on composing hooks and
// wiring the keyboard handler. `LiveRegion` renders the in-flight turn (height- and
// width-capped so it never overflows Ink's dynamic region); `PromptArea` renders
// whichever pause-and-ask overlay is active, or the framed input box when none is.

import { AskUserView } from "./AskUser.tsx";
import { Complete } from "./Complete.tsx";
import { ConfirmView } from "./Confirm.tsx";
import { ExtensionsView } from "./Extensions.tsx";
import { HelpOverlay } from "./Help.tsx";
import { useIcon, useSpinnerFrame } from "./Icon.tsx";
import { MultilineInput } from "./Input.tsx";
import { ActionChip } from "./Interactive.tsx";
import { type Item, ItemView } from "./Message.tsx";
import { clampLineWidth, tailLines } from "./message-helpers.ts";
import { PastePreview } from "./PastePreview.tsx";
import { PlanView } from "./Plan.tsx";
import { Box, Text } from "./primitives.tsx";
import { SPACING, SURFACE, tint } from "./theme.ts";
import { isItemExpanded } from "./tool-expansion.ts";
import type { AgentSession } from "./use-agent-session.ts";
import type { Approvals } from "./use-approvals.ts";
import type { Autocomplete } from "./use-autocomplete.ts";
import type { HelpState } from "./use-help.ts";
import type { PastePreview as PastePreviewState } from "./use-paste-preview.ts";
import type { PromptHistory } from "./use-prompt-history.ts";
import type { PromptInput } from "./use-prompt-input.ts";

/** The in-flight turn: only the currently-streaming item lives here (finished items
 *  have moved to `<Static>`). A streaming assistant/thinking block is the one item
 *  that can outgrow the viewport, so it is height-capped (`tailLines`) and
 *  width-clamped (`clampLineWidth`) — the full text lands in the scrollback when it
 *  finalises. Other kinds render compact. */
export function LiveRegion({
  live,
  history,
  verbose,
  firstToolId,
  liveCap,
  liveContentWidth,
  expandedToolIds,
  onToggleTool,
  onCopyItem,
}: {
  live: Item[];
  history: Item[];
  verbose: boolean;
  firstToolId: number | undefined;
  liveCap: number;
  liveContentWidth: number;
  expandedToolIds: ReadonlySet<number>;
  onToggleTool: (id: number) => void;
  onCopyItem?: (item: Item, kind?: "default" | "command" | "output") => void;
}): React.ReactElement | null {
  if (live.length === 0) return null;
  return (
    <Box flexDirection="column">
      {live.map((item, index) => {
        // The first live item follows the last committed scrollback item; later
        // live items follow their live predecessor. Drives group spacing so a
        // streaming answer/tool tucks under what came before it.
        const prevKind =
          index > 0
            ? live[index - 1]!.kind
            : history.length > 0
              ? history[history.length - 1]!.kind
              : undefined;
        if (item.kind === "assistant" || item.kind === "thinking") {
          // Two bounds keep this block from overflowing the redrawn dynamic region
          // (which desyncs Ink into duplicate lines): `tailLines` caps its *height*
          // to the viewport, then `clampLineWidth` caps each line's *width* so none
          // soft-wraps (a wrapped live line is what Ink mis-erases and smears
          // horizontally). Full text lands in `<Static>`.
          const clamped = tailLines(item.text, liveCap, liveContentWidth);
          const text = clampLineWidth(clamped.text, liveContentWidth);
          return (
            <Box key={item.id} flexDirection="column">
              {clamped.trimmed ? (
                <Text dimColor>
                  {
                    "  ↑ earlier lines hidden — shown in full when the turn finishes"
                  }
                </Text>
              ) : null}
              <ItemView
                item={{ ...item, text }}
                prevKind={prevKind}
                expanded={isItemExpanded(item, verbose, expandedToolIds)}
                showExpandHint={item.id === firstToolId}
                onToggleTool={onToggleTool}
                onCopyItem={onCopyItem}
              />
            </Box>
          );
        }
        // Tools/notes render compact while live — a tool's full command/output
        // could otherwise wrap past the viewport and desync the dynamic region.
        return (
          <ItemView
            key={item.id}
            item={item}
            prevKind={prevKind}
            expanded={isItemExpanded(item, verbose, expandedToolIds)}
            showExpandHint={item.id === firstToolId}
            onToggleTool={onToggleTool}
            onCopyItem={onCopyItem}
            compact
            width={liveContentWidth}
          />
        );
      })}
    </Box>
  );
}

/** Whichever pause-and-ask overlay is active (confirm / ask / checkpoint / plan),
 *  or the framed input box when none is. The overlays are mutually exclusive — the
 *  agent loop is suspended on exactly one at a time. */
export function PromptArea({
  approvals,
  session,
  autocomplete,
  promptInput,
  promptHistory,
  registerPaste,
  pasteMap,
  pastePreview,
  help,
  modeColor,
  verb,
  columns,
  navMode,
  onOpenExternalEditor,
}: {
  approvals: Approvals;
  session: AgentSession;
  autocomplete: Autocomplete;
  promptInput: PromptInput;
  promptHistory: PromptHistory;
  registerPaste: (text: string) => string | null;
  pasteMap: Map<number, string>;
  pastePreview: PastePreviewState;
  help: HelpState;
  modeColor: string;
  verb: string;
  columns: number;
  /** True while the App is in keyboard transcript nav mode — the prompt goes inert
   * and a one-line vim-key hint shows in its place. */
  navMode: boolean;
  /** Open the current prompt in $VISUAL/$EDITOR and replace it on save. */
  onOpenExternalEditor: () => void;
}): React.ReactElement {
  const checkpointIcon = useIcon("checkpoint");
  const promptIcon = useIcon("prompt");
  const queuedIcon = useIcon("queued");
  // Called unconditionally (before the early-return overlays) per the rules of
  // hooks; it only animates while the turn is busy.
  const spinner = useSpinnerFrame(session.busy);

  if (approvals.pendingConfirm) {
    return (
      <ConfirmView
        preview={approvals.pendingConfirm}
        reason={approvals.pendingConfirmReason}
        columns={columns}
        onYes={() => approvals.resolveConfirm(true, false)}
        onNo={() => approvals.resolveConfirm(false, false)}
        onAlways={() => approvals.resolveConfirm(true, true)}
      />
    );
  }
  if (approvals.pendingAsk) {
    return (
      <AskUserView
        key={approvals.askKey}
        questions={approvals.pendingAsk}
        onSubmit={(answers) => approvals.resolveAsk(answers)}
      />
    );
  }
  if (approvals.pendingCheckpoint !== null) {
    return (
      <Box flexDirection="column" marginTop={SPACING.inputGap}>
        <Box>
          {/* width=2 leaves room for two-cell Nerd Font glyphs so the icon can't
              eat the following space; flexShrink=0 keeps the fixed cell from
              going fractional beside flexible text (see Message.tsx RuleRow). */}
          <Box width={2} flexShrink={0}>
            <Text color={tint("yellow")}>{checkpointIcon}</Text>
          </Box>
          <Box marginLeft={1}>
            <Text color={tint("yellow")}>
              {`${approvals.pendingCheckpoint} turns in — keep going? `}
            </Text>
            <ActionChip
              label="[y]"
              color="yellow"
              onAction={() => approvals.resolveCheckpoint(true)}
            />
            <Text dimColor>{"es / "}</Text>
            <ActionChip
              label="[n]"
              color="yellow"
              onAction={() => approvals.resolveCheckpoint(false)}
            />
            <Text dimColor>{"o stop"}</Text>
          </Box>
        </Box>
      </Box>
    );
  }
  if (approvals.pendingPlan) {
    return (
      <PlanView
        plan={approvals.pendingPlan}
        mode={session.mode}
        onAccept={session.acceptPlan}
        onEdit={session.editPlan}
        onReject={session.rejectPlan}
      />
    );
  }
  if (session.extensionsPicker) {
    return (
      <ExtensionsView
        items={session.extensionsPicker}
        onSubmit={session.applyExtensions}
      />
    );
  }
  return (
    <Box flexDirection="column" marginTop={SPACING.inputGap}>
      {session.queued.length > 0 ? (
        <Box flexDirection="column">
          {session.queued.map((item, i) => (
            <Box key={`${item.display}-${i}`}>
              {/* width=2 + flexShrink=0: see the checkpoint row above. */}
              <Box width={2} flexShrink={0}>
                <Text dimColor>{queuedIcon}</Text>
              </Box>
              <Box marginLeft={1}>
                <Text dimColor>
                  {`queued: ${item.display}${i === 0 ? " (Esc to cancel)" : ""}`}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
      {autocomplete.completeOpen ? (
        <Complete
          items={autocomplete.suggestions}
          selected={autocomplete.sel}
          onSelect={autocomplete.selectCompletion}
          onAccept={autocomplete.acceptCompletion}
        />
      ) : null}
      {/* Paste-chip preview: rendered above the input frame (like the autocomplete
          list) when a `[Pasted …]` chip is clicked. Read-only — never edits the
          buffer; while open the MultilineInput below is paused. */}
      {pastePreview.chipId !== null ? (
        <PastePreview
          chipId={pastePreview.chipId}
          text={pasteMap.get(pastePreview.chipId) ?? ""}
          columns={columns}
          onClose={pastePreview.close}
        />
      ) : null}
      {/* Keyboard & mouse help overlay: rendered above the input frame (like the
          autocomplete list / paste preview) when opened from the footer `?` chip
          or by `?` on an empty prompt. While open the MultilineInput below is
          paused so its own scoped handler owns `?`/Esc to close. */}
      {help.open ? (
        <HelpOverlay columns={columns} onClose={help.closeHelp} />
      ) : null}
      {/* Live status: spinner + verb sit on their own row just above the input
          frame while busy (so they never share the prompt line). */}
      {session.busy ? (
        <Text color={tint(modeColor)}>
          {spinner}
          <Text dimColor>{` ${verb}`}</Text>
        </Text>
      ) : null}
      {/* Nav mode: a one-line dim hint of the vim keys, shown just above the (inert)
          input frame so the user knows what the keyboard now drives. */}
      {navMode ? (
        <Box paddingLeft={SPACING.boxPadX}>
          <Text dimColor>
            {
              "nav: j/k move · g/G top/bottom · enter expand · y yank · c/o cmd/out · i/esc exit"
            }
          </Text>
        </Box>
      ) : null}
      {/* Input bar: a soft filled block in the same family as the cards (no
          border), with the prompt glyph tinted by the active mode. While in nav
          mode the prompt glyph dims and the input is inert (keys drive the
          transcript), so the bar visibly steps back. */}
      <Box
        backgroundColor={tint(SURFACE.input)}
        paddingX={SPACING.boxPadX}
        paddingY={SPACING.boxPadY}
        flexDirection="row"
      >
        <Box width={1} marginRight={1}>
          <Text
            color={navMode ? undefined : tint(modeColor)}
            dimColor={navMode}
          >
            {promptIcon}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <MultilineInput
            value={promptInput.input}
            onChange={autocomplete.handleInputChange}
            onSubmit={session.onSubmit}
            inputActive={!navMode && !help.open}
            capture={autocomplete.completeOpen}
            cursorNonce={promptInput.cursorNonce}
            onHistoryPrev={promptHistory.historyPrev}
            onHistoryNext={promptHistory.historyNext}
            registerPaste={registerPaste}
            pastes={pasteMap}
            onChipClick={pastePreview.open}
            previewActive={pastePreview.chipId !== null}
            onOpenExternalEditor={onOpenExternalEditor}
            // Inner content width = terminal − paddingX (2) − the prompt prefix +
            // 1 spare so the EOL cursor block never pushes a row past the edge.
            width={Math.max(1, columns - 2 * SPACING.boxPadX - 2 - 1)}
            placeholder={
              navMode
                ? "nav mode — i or esc to return to the prompt"
                : session.busy
                  ? "Enter to queue · Esc to cancel"
                  : "message, or /help · Shift+Enter for newline"
            }
          />
        </Box>
      </Box>
    </Box>
  );
}
