// tasks.test.ts — unit tests for the framework-agnostic update_tasks helpers.

import { describe, expect, test } from "bun:test";
import { formatTasks, parseTasks, statusMark, type Task } from "./tasks.ts";

describe("parseTasks", () => {
  test("parses a minimal valid list", () => {
    const tasks = parseTasks({
      tasks: [
        { content: "Fix X", status: "pending" },
        { content: "Fix Y", status: "in_progress", activeForm: "Fixing Y" },
      ],
    });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].content).toBe("Fix X");
    expect(tasks[1].activeForm).toBe("Fixing Y");
  });

  test("throws when tasks is missing or empty", () => {
    expect(() => parseTasks({})).toThrow("non-empty array");
    expect(() => parseTasks({ tasks: [] })).toThrow("non-empty array");
  });

  test("throws on a missing content string", () => {
    expect(() => parseTasks({ tasks: [{ status: "pending" }] })).toThrow(
      "content",
    );
  });

  test("throws on an invalid status", () => {
    expect(() =>
      parseTasks({ tasks: [{ content: "X", status: "done" }] }),
    ).toThrow("status must be one of");
  });

  test("throws when more than one task is in_progress", () => {
    expect(() =>
      parseTasks({
        tasks: [
          { content: "A", status: "in_progress" },
          { content: "B", status: "in_progress" },
        ],
      }),
    ).toThrow("at most one task");
  });

  test("drops an empty activeForm to undefined", () => {
    const tasks = parseTasks({
      tasks: [{ content: "X", status: "pending", activeForm: "" }],
    });
    expect(tasks[0].activeForm).toBeUndefined();
  });
});

describe("statusMark", () => {
  test("maps each status to an ASCII-safe mark by default", () => {
    expect(statusMark("pending")).toBe("[ ]");
    expect(statusMark("in_progress")).toBe("[*]");
    expect(statusMark("completed")).toBe("[x]");
  });
});

describe("formatTasks", () => {
  test("reports the done tally and lists each task", () => {
    const tasks: Task[] = [
      { content: "Fix X", status: "completed" },
      { content: "Fix Y", status: "in_progress" },
      { content: "Fix Z", status: "pending" },
    ];
    const out = formatTasks(tasks);
    expect(out).toContain("1/3 done");
    expect(out).toContain("Fix X");
    expect(out).toContain("Fix Z");
  });
});
