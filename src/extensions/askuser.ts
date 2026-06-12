// askuser.ts — the `ask_user` tool: let the agent ask the user a question.
//
// The model calls `ask_user` with one or more multiple-choice questions; the
// front-end pauses, shows them, and the user either picks an option (or several,
// for multiSelect) or writes their own answer. The chosen answers come back as a
// readable string the model reads on its next turn.
//
// This module is framework-agnostic on purpose: the pure helpers (validation,
// the recommended-option pick, answer formatting) and the tool factory live here
// so both the TUI and the headless CLI share them. The interactive box is the
// only React piece (tui/AskUser.tsx); headless supplies a resolver that auto-picks
// each question's recommended option, so the model can't tell the difference and
// never gets a lever to "skip" a genuine question.

import type { SessionExtension } from "../extension.ts";
import type { Tool } from "../tools.ts";

/** One selectable answer: a short `label` plus an optional explanatory `description`. */
export interface AskOption {
  label: string;
  description?: string;
}

/** A single question: a header chip, the prompt, its options, and a multi-pick flag. */
export interface AskQuestion {
  /** Short label shown as a chip (≤ ~12 chars), e.g. "Database". */
  header: string;
  /** The full question text. */
  question: string;
  /** When true the user may toggle several options before submitting. */
  multiSelect: boolean;
  /** 2–4 preset choices. */
  options: AskOption[];
}

/**
 * The user's answer to one question: either the chosen preset `selected` labels,
 * or a free-text `custom` answer (the two are mutually exclusive — choosing
 * "write my own" replaces any preset selection).
 */
export interface AskAnswer {
  /** Chosen preset option labels (empty when the answer is custom). */
  selected: string[];
  /** Free-text answer when the user wrote their own (overrides `selected`). */
  custom?: string;
}

/**
 * Resolve a set of questions to answers. Resolving `null` means the user
 * dismissed the prompt without answering (e.g. aborted the turn). The TUI wires
 * this to its interactive box; headless wires it to `autoAnswer`.
 */
export type AskUserFn = (
  questions: AskQuestion[],
) => Promise<AskAnswer[] | null>;

/** Throw a clear, model-readable error unless `v` is a non-empty string. */
function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`ask_user: ${what} must be a non-empty string`);
  }
  return v;
}

/**
 * Validate and normalize the model's raw tool input into `AskQuestion[]`. Throws
 * on anything malformed (1–4 questions, each with a header, a question, and 2–4
 * options that each have a label) — the agent loop turns the throw into an
 * `is_error` tool_result so the model can correct itself.
 */
export function parseQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("ask_user: 'questions' must be a non-empty array");
  }
  if (raw.length > 4) throw new Error("ask_user: at most 4 questions allowed");

  return raw.map((q, qi) => {
    if (typeof q !== "object" || q === null) {
      throw new Error(`ask_user: questions[${qi}] must be an object`);
    }
    const o = q as Record<string, unknown>;
    const header = asString(o.header, `questions[${qi}].header`);
    const question = asString(o.question, `questions[${qi}].question`);

    const optsRaw = o.options;
    if (!Array.isArray(optsRaw) || optsRaw.length < 2) {
      throw new Error(`ask_user: questions[${qi}] needs at least 2 options`);
    }
    if (optsRaw.length > 4) {
      throw new Error(`ask_user: questions[${qi}] allows at most 4 options`);
    }
    const options = optsRaw.map((opt, oi) => {
      if (typeof opt !== "object" || opt === null) {
        throw new Error(
          `ask_user: questions[${qi}].options[${oi}] must be an object`,
        );
      }
      const oo = opt as Record<string, unknown>;
      return {
        label: asString(oo.label, `questions[${qi}].options[${oi}].label`),
        description:
          typeof oo.description === "string" ? oo.description : undefined,
      };
    });

    return { header, question, multiSelect: Boolean(o.multiSelect), options };
  });
}

/**
 * Index of a question's recommended option: the one whose label is marked
 * "(Recommended)", else the first option (the convention the model is told to
 * follow — put the recommended choice first). Used to seed the cursor and to
 * auto-answer in non-interactive mode.
 */
export function recommendedIndex(q: AskQuestion): number {
  const i = q.options.findIndex((o) => /\(recommended\)/i.test(o.label));
  return i >= 0 ? i : 0;
}

/**
 * Non-interactive auto-answer: pick each question's recommended option. Headless
 * mode uses this so a model `ask_user` call resolves immediately instead of
 * hanging on input that will never come — transparently, so the model still
 * "asks" exactly as it would interactively.
 */
export function autoAnswer(questions: AskQuestion[]): AskAnswer[] {
  return questions.map((q) => {
    const opt = q.options[recommendedIndex(q)];
    return { selected: opt ? [opt.label] : [] };
  });
}

/** Render one answer to the text the model reads (custom answers are marked). */
function renderAnswer(a: AskAnswer | undefined): string {
  if (a?.custom != null && a.custom.length > 0)
    return `[wrote their own] ${a.custom}`;
  if (a && a.selected.length > 0) return a.selected.join(", ");
  return "(no answer)";
}

/** Format the answered questions into the single string the tool returns. */
export function formatAnswers(
  questions: AskQuestion[],
  answers: AskAnswer[],
): string {
  return questions
    .map((q, i) => `Q: ${q.question}\nA: ${renderAnswer(answers[i])}`)
    .join("\n\n");
}

const DESCRIPTION = [
  "Ask the user one or more multiple-choice questions and wait for their answer(s).",
  "Use this ONLY when you genuinely need the user to decide something you cannot decide yourself:",
  "a choice between real alternatives, a missing requirement, or a preference that changes what you build.",
  "Do NOT use it to ask permission to run tools, to confirm an obvious next step, or instead of investigating",
  "the project yourself. Each question offers 2–4 options (a short label plus a description) and the user can",
  "always write their own answer instead. Put the option you recommend first (optionally suffix its label with",
  '"(Recommended)"). Set multiSelect:true when several options may be chosen together. The result reports the',
  "user's choice for each question; act on it directly.",
].join(" ");

/**
 * Build the `ask_user` tool around a resolver. `readOnly` is true — asking
 * mutates nothing and should never trip the approval gate or plan-mode filter.
 */
export function askUserTool(onAskUser: AskUserFn): Tool {
  return {
    name: "ask_user",
    description: DESCRIPTION,
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "1–4 questions to ask the user, shown one at a time.",
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                description: "Short chip label for the question (≤ ~12 chars).",
              },
              question: {
                type: "string",
                description: "The full question text.",
              },
              multiSelect: {
                type: "boolean",
                description:
                  "Allow choosing several options together (default false).",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                description: "2–4 choices. List the recommended option first.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Short option text the user selects.",
                    },
                    description: {
                      type: "string",
                      description: "One line explaining the option (optional).",
                    },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["header", "question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    async run(input) {
      const questions = parseQuestions(input);
      const answers = await onAskUser(questions);
      if (!answers)
        return "The user dismissed the questions without answering.";
      return formatAnswers(questions, answers);
    },
  };
}

export function askUserExtension(answerer: AskUserFn): SessionExtension {
  return {
    name: "askuser",
    tools: () => [askUserTool(answerer)],
  };
}
