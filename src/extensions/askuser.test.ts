// askuser.test.ts — the pure logic behind the ask_user tool: input validation,
// the recommended-option pick (which drives headless auto-answer and the initial
// cursor), and the answer-formatting the model reads back. Run with `bun test`.

import { describe, expect, test } from "bun:test";
import {
  type AskQuestion,
  askUserExtension,
  askUserTool,
  autoAnswer,
  formatAnswers,
  parseQuestions,
  recommendedIndex,
} from "./askuser.ts";

const Q: AskQuestion = {
  header: "DB",
  question: "Which database?",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "relational" },
    { label: "SQLite", description: "embedded" },
  ],
};

describe("parseQuestions", () => {
  test("accepts a well-formed question set", () => {
    const out = parseQuestions({
      questions: [
        {
          header: "DB",
          question: "Which database?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.multiSelect).toBe(false);
    expect(out[0]!.options).toHaveLength(2);
  });

  test("defaults multiSelect to false and drops non-string descriptions", () => {
    const out = parseQuestions({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [{ label: "a", description: 5 }, { label: "b" }],
        },
      ],
    });
    expect(out[0]!.multiSelect).toBe(false);
    expect(out[0]!.options[0]!.description).toBeUndefined();
  });

  test("rejects an empty questions array", () => {
    expect(() => parseQuestions({ questions: [] })).toThrow(/non-empty array/);
  });

  test("rejects more than 4 questions", () => {
    const q = {
      header: "h",
      question: "q",
      options: [{ label: "a" }, { label: "b" }],
    };
    expect(() => parseQuestions({ questions: [q, q, q, q, q] })).toThrow(
      /at most 4/,
    );
  });

  test("rejects a question with fewer than 2 options", () => {
    expect(() =>
      parseQuestions({
        questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
      }),
    ).toThrow(/at least 2 options/);
  });

  test("rejects an option without a label", () => {
    expect(() =>
      parseQuestions({
        questions: [
          { header: "h", question: "q", options: [{ label: "a" }, {}] },
        ],
      }),
    ).toThrow(/label must be a non-empty string/);
  });
});

describe("recommendedIndex", () => {
  test("defaults to the first option", () => {
    expect(recommendedIndex(Q)).toBe(0);
  });

  test("honors an explicit (Recommended) marker, case-insensitively", () => {
    const q: AskQuestion = {
      ...Q,
      options: [{ label: "Postgres" }, { label: "SQLite (recommended)" }],
    };
    expect(recommendedIndex(q)).toBe(1);
  });
});

describe("autoAnswer", () => {
  test("picks each question's recommended option", () => {
    const q2: AskQuestion = {
      header: "Cache",
      question: "Enable caching?",
      multiSelect: false,
      options: [{ label: "No" }, { label: "Yes (Recommended)" }],
    };
    expect(autoAnswer([Q, q2])).toEqual([
      { selected: ["Postgres"] },
      { selected: ["Yes (Recommended)"] },
    ]);
  });
});

describe("formatAnswers", () => {
  test("renders preset, multi, custom, and missing answers", () => {
    const questions: AskQuestion[] = [
      Q,
      { ...Q, question: "Pick langs", multiSelect: true },
      { ...Q, question: "Anything else?" },
      { ...Q, question: "Skipped?" },
    ];
    const out = formatAnswers(questions, [
      { selected: ["Postgres"] },
      { selected: ["TypeScript", "Go"] },
      { selected: [], custom: "use Bun" },
      { selected: [] },
    ]);
    expect(out).toContain("Q: Which database?\nA: Postgres");
    expect(out).toContain("A: TypeScript, Go");
    expect(out).toContain("A: [wrote their own] use Bun");
    expect(out).toContain("A: (no answer)");
  });
});

describe("askUserTool", () => {
  test("is a read-only tool named ask_user", () => {
    const tool = askUserTool(async () => null);
    expect(tool.name).toBe("ask_user");
    expect(tool.readOnly).toBe(true);
  });

  test("formats the resolver's answers for the model", async () => {
    const tool = askUserTool(async (qs) =>
      qs.map(() => ({ selected: ["Postgres"] })),
    );
    const result = await tool.run({
      questions: [
        {
          header: "DB",
          question: "Which database?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
      ],
    });
    expect(result).toBe("Q: Which database?\nA: Postgres");
  });

  test("reports dismissal when the resolver returns null", async () => {
    const tool = askUserTool(async () => null);
    const result = await tool.run({
      questions: [
        {
          header: "DB",
          question: "Which?",
          options: [{ label: "a" }, { label: "b" }],
        },
      ],
    });
    expect(result).toBe("The user dismissed the questions without answering.");
  });

  test("propagates a validation error for malformed input", async () => {
    const tool = askUserTool(async () => null);
    await expect(tool.run({ questions: [] })).rejects.toThrow(
      /non-empty array/,
    );
  });
});

test("askUserExtension contributes ask_user and threads the answerer", async () => {
  const seen: unknown[] = [];
  const ext = askUserExtension(async (questions) => {
    seen.push(questions);
    return questions.map(() => ({ selected: ["Postgres"] }));
  });
  const tools = await ext.tools?.({} as never);
  expect(tools?.map((t) => t.name)).toEqual(["ask_user"]);
  expect(tools?.[0]?.readOnly).toBe(true);
  await tools?.[0]?.run({
    questions: [
      {
        header: "DB",
        question: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      },
    ],
  });
  expect(seen.length).toBe(1);
});
