// tui/AskUser.tsx — the interactive "agent asks the user" box.
//
// When the model calls `ask_user`, App pauses the loop and renders this box in the
// input area (the prompt is unmounted, like the confirm/plan boxes). Questions are
// shown ONE AT A TIME (a wizard): ↑/↓ move the cursor over the options, Enter
// selects and advances, and a persistent "✎ Write my own answer" row drops into a
// text field for a free-text reply. multiSelect questions add Space to toggle
// several options before Enter submits them together. After the last question all
// answers resolve back through `onSubmit`.
//
// This component owns its own keys via `useInput` (the navigation is too rich for
// App's global y/n/a handler), so App's handler bows out while a question is up
// (see the `pendingAsk` early-return there). The custom-answer field reuses
// MultilineInput; while it's active this box's own `useInput` is disabled so the
// two never fight over a keypress.

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import type { AskAnswer, AskQuestion } from "../askuser.ts";
import { recommendedIndex } from "../askuser.ts";
import { MultilineInput } from "./Input.tsx";
import { SPACING, tint } from "./theme.ts";

const CUSTOM_LABEL = "✎ Write my own answer";
const ACCENT = "magenta";

interface AskUserViewProps {
  questions: AskQuestion[];
  /** All questions answered — the collected answers, in order. */
  onSubmit: (answers: AskAnswer[]) => void;
}

export function AskUserView({
  questions,
  onSubmit,
}: AskUserViewProps): React.ReactElement {
  const [qIndex, setQIndex] = useState(0);
  // Cursor starts on the recommended option so a bare Enter picks the default.
  const [cursor, setCursor] = useState(() => recommendedIndex(questions[0]!));
  const [picks, setPicks] = useState<Set<number>>(new Set());
  // `writing` swaps the option list for the free-text field; `draft` holds it.
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  // Answers accumulate in a ref so advancing past the last question can submit
  // them synchronously without waiting for a state flush.
  const answersRef = useRef<AskAnswer[]>([]);

  const q = questions[qIndex]!;
  const customRow = q.options.length; // the "write my own" pseudo-row
  const rowCount = q.options.length + 1;

  // Record an answer and move to the next question (or finish).
  const advance = (answer: AskAnswer): void => {
    answersRef.current = [...answersRef.current, answer];
    const next = qIndex + 1;
    if (next >= questions.length) {
      onSubmit(answersRef.current);
      return;
    }
    setQIndex(next);
    setCursor(recommendedIndex(questions[next]!));
    setPicks(new Set());
    setWriting(false);
    setDraft("");
  };

  // Confirm the preset selection: toggled picks if any (multiSelect), else the
  // single option under the cursor.
  const confirmPresets = (): void => {
    if (q.multiSelect && picks.size > 0) {
      const labels = [...picks]
        .sort((a, b) => a - b)
        .map((i) => q.options[i]!.label);
      advance({ selected: labels });
    } else {
      advance({ selected: [q.options[cursor]!.label] });
    }
  };

  useInput(
    (input, key) => {
      if (key.upArrow) return setCursor((c) => (c - 1 + rowCount) % rowCount);
      if (key.downArrow) return setCursor((c) => (c + 1) % rowCount);
      // Space toggles a pick on multiSelect questions (not on the custom row).
      if (input === " " && q.multiSelect && cursor !== customRow) {
        return setPicks((prev) => {
          const next = new Set(prev);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
      }
      if (key.return) {
        if (cursor === customRow) setWriting(true);
        else confirmPresets();
      }
    },
    // While the free-text field is open it owns the keyboard.
    { isActive: !writing },
  );

  const accent = tint(ACCENT);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={SPACING.boxPadX}
      marginTop={SPACING.inputGap}
    >
      <Box>
        <Text color={accent} bold>{`[${q.header}]`}</Text>
        {questions.length > 1 ? (
          <Text dimColor>{`  (${qIndex + 1}/${questions.length})`}</Text>
        ) : null}
      </Box>
      <Text bold>{q.question}</Text>

      {writing ? (
        <Box flexDirection="column" marginTop={SPACING.blockGap}>
          <Box>
            <Text color={accent}>{"› "}</Text>
            <MultilineInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => {
                const text = v.trim();
                // Empty submit backs out to the option list; otherwise it's the answer.
                if (!text) {
                  setWriting(false);
                  setDraft("");
                  return;
                }
                advance({ selected: [], custom: text });
              }}
              placeholder="type your answer…"
            />
          </Box>
          <Text dimColor>
            {"enter submit · empty enter to go back · shift+enter newline"}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {q.options.map((o, i) => {
            const isSel = i === cursor;
            const checked = q.multiSelect && picks.has(i);
            return (
              <Box key={i}>
                <Text color={isSel ? accent : undefined}>
                  {isSel ? "› " : "  "}
                </Text>
                {q.multiSelect ? (
                  <Text color={isSel ? accent : undefined}>
                    {checked ? "◉ " : "○ "}
                  </Text>
                ) : null}
                <Text color={isSel ? accent : undefined} bold={isSel}>
                  {o.label}
                </Text>
                {o.description ? (
                  <Text dimColor>{`  ${o.description}`}</Text>
                ) : null}
              </Box>
            );
          })}
          <Box>
            <Text color={cursor === customRow ? accent : undefined}>
              {cursor === customRow ? "› " : "  "}
            </Text>
            <Text
              color={cursor === customRow ? accent : undefined}
              bold={cursor === customRow}
            >
              {CUSTOM_LABEL}
            </Text>
          </Box>
          <Text dimColor>
            {q.multiSelect
              ? "↑/↓ move · space toggle · enter submit"
              : "↑/↓ move · enter select"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
