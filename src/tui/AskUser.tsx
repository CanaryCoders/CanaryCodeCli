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
import { useReducer, useRef } from "react";
import type { AskAnswer, AskQuestion } from "../extensions/askuser.ts";
import { recommendedIndex } from "../extensions/askuser.ts";
import { useIcon } from "./Icon.tsx";
import { MultilineInput } from "./Input.tsx";
import { SPACING, tint } from "./theme.ts";

const CUSTOM_LABEL = "Write my own answer";
const ACCENT = "magenta";

/** The wizard's full UI state: which question, cursor + picks, and the
 *  free-text answer field. */
interface State {
  /** Index of the question currently shown. */
  qIndex: number;
  /** Row the cursor is on (an option index, or the "write my own" row). */
  cursor: number;
  /** Toggled option indices on a multiSelect question. */
  picks: Set<number>;
  /** Whether the free-text field has replaced the option list. */
  writing: boolean;
  /** The in-progress free-text answer. */
  draft: string;
}

type Action =
  | { type: "moveCursor"; rowCount: number; delta: number }
  | { type: "togglePick"; index: number }
  | { type: "startWriting" }
  | { type: "setDraft"; draft: string }
  | { type: "cancelWriting" }
  | { type: "nextQuestion"; cursor: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "moveCursor": {
      const { rowCount, delta } = action;
      return {
        ...state,
        cursor: (state.cursor + delta + rowCount) % rowCount,
      };
    }
    case "togglePick": {
      const picks = new Set(state.picks);
      if (picks.has(action.index)) picks.delete(action.index);
      else picks.add(action.index);
      return { ...state, picks };
    }
    case "startWriting":
      return { ...state, writing: true };
    case "setDraft":
      return { ...state, draft: action.draft };
    case "cancelWriting":
      return { ...state, writing: false, draft: "" };
    case "nextQuestion":
      return {
        qIndex: state.qIndex + 1,
        cursor: action.cursor,
        picks: new Set(),
        writing: false,
        draft: "",
      };
  }
}

interface AskUserViewProps {
  questions: AskQuestion[];
  /** All questions answered — the collected answers, in order. */
  onSubmit: (answers: AskAnswer[]) => void;
}

export function AskUserView({
  questions,
  onSubmit,
}: AskUserViewProps): React.ReactElement {
  // Cursor starts on the recommended option so a bare Enter picks the default.
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    qIndex: 0,
    cursor: recommendedIndex(questions[0]!),
    picks: new Set<number>(),
    writing: false,
    draft: "",
  }));
  const { qIndex, cursor, picks, writing, draft } = state;
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
    dispatch({
      type: "nextQuestion",
      cursor: recommendedIndex(questions[next]!),
    });
  };

  // Confirm the preset selection: toggled picks if any (multiSelect), else the
  // single option under the cursor.
  const confirmPresets = (): void => {
    if (q.multiSelect && picks.size > 0) {
      const labels = [...picks]
        .toSorted((a, b) => a - b)
        .map((i) => q.options[i]!.label);
      advance({ selected: labels });
    } else {
      advance({ selected: [q.options[cursor]!.label] });
    }
  };

  useInput(
    (input, key) => {
      if (key.upArrow)
        return dispatch({ type: "moveCursor", rowCount, delta: -1 });
      if (key.downArrow)
        return dispatch({ type: "moveCursor", rowCount, delta: 1 });
      // Space toggles a pick on multiSelect questions (not on the custom row).
      if (input === " " && q.multiSelect && cursor !== customRow) {
        return dispatch({ type: "togglePick", index: cursor });
      }
      if (key.return) {
        if (cursor === customRow) dispatch({ type: "startWriting" });
        else confirmPresets();
      }
    },
    // While the free-text field is open it owns the keyboard.
    { isActive: !writing },
  );

  const accent = tint(ACCENT);
  const promptIcon = useIcon("prompt");
  const selectedIcon = useIcon("choiceSelected");
  const emptyIcon = useIcon("choiceEmpty");
  const writeCustomIcon = useIcon("writeCustom");

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
            <Box width={1} marginRight={1}>
              <Text color={accent}>{promptIcon}</Text>
            </Box>
            <MultilineInput
              value={draft}
              onChange={(v) => dispatch({ type: "setDraft", draft: v })}
              onSubmit={(v) => {
                const text = v.trim();
                // Empty submit backs out to the option list; otherwise it's the answer.
                if (!text) {
                  dispatch({ type: "cancelWriting" });
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
              <Box key={`${i}:${o.label}`}>
                <Box width={1} marginRight={1}>
                  <Text color={isSel ? accent : undefined}>
                    {isSel ? promptIcon : " "}
                  </Text>
                </Box>
                {q.multiSelect ? (
                  <Box width={1} marginRight={1}>
                    <Text color={isSel ? accent : undefined}>
                      {checked ? selectedIcon : emptyIcon}
                    </Text>
                  </Box>
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
            <Box width={1} marginRight={1}>
              <Text color={cursor === customRow ? accent : undefined}>
                {cursor === customRow ? promptIcon : " "}
              </Text>
            </Box>
            <Box width={1} marginRight={1}>
              <Text color={cursor === customRow ? accent : undefined}>
                {writeCustomIcon}
              </Text>
            </Box>
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
