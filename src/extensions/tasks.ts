// tasks.ts — the `update_tasks` tool: the agent's own todo list.
//
// The model calls `update_tasks` with the full task list (each item carries a
// status); the front-end records it and shows it live. This is a planning and
// orchestration aid, NOT a change to the world — so it is read-only and the list
// is ephemeral (it lives in the front-end for the session, never persisted).
//
// Like askuser.ts this module is framework-agnostic on purpose: the pure helpers
// (validation, formatting) and the tool factory live here so both the Ink TUI
// and the headless CLI share them. The TUI wires `onUpdate` to React state that
// renders a panel; headless wires it to a compact stderr checklist.
//
// The whole list is sent on every call (a snapshot, not a diff) — simplest for
// the model to reason about and for the UI to render. The agent flips a task to
// `in_progress` before working it and to `completed` when done, typically while
// dispatching one sub-agent per task via spawn_agent.

import type { Config } from "../config.ts";
import type { SessionExtension } from "../extension.ts";
import { iconFor } from "../icons.ts";
import type { Tool } from "../tools.ts";

/** A task's lifecycle state. Exactly one task should be `in_progress` at a time. */
export type TaskStatus = "pending" | "in_progress" | "completed";

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"];

/** One task in the agent's todo list. */
export interface Task {
  /** Imperative description of the work, e.g. "Fix the broken X import". */
  content: string;
  /** Lifecycle state. */
  status: TaskStatus;
  /** Optional present-continuous form shown while in progress, e.g. "Fixing X". */
  activeForm?: string;
}

/**
 * Resolve a task-list update. The TUI wires this to its panel state; headless
 * wires it to a stderr checklist. Returns nothing — recording the list cannot
 * fail in a way the model needs to handle.
 */
export type TaskUpdateFn = (tasks: Task[]) => void;

/** Throw a clear, model-readable error unless `v` is a non-empty string. */
function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`update_tasks: ${what} must be a non-empty string`);
  }
  return v;
}

/**
 * Validate and normalize the model's raw tool input into `Task[]`. Throws on
 * anything malformed (non-empty array; each item has a content string and a
 * valid status) — the agent loop turns the throw into an `is_error` tool_result
 * so the model can correct itself. At most one task may be `in_progress`.
 */
export function parseTasks(input: Record<string, unknown>): Task[] {
  const raw = input.tasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("update_tasks: 'tasks' must be a non-empty array");
  }
  const tasks = raw.map((t, i) => {
    if (typeof t !== "object" || t === null) {
      throw new Error(`update_tasks: tasks[${i}] must be an object`);
    }
    const o = t as Record<string, unknown>;
    const content = asString(o.content, `tasks[${i}].content`);
    const status = o.status;
    if (
      typeof status !== "string" ||
      !STATUSES.includes(status as TaskStatus)
    ) {
      throw new Error(
        `update_tasks: tasks[${i}].status must be one of ${STATUSES.join(", ")}`,
      );
    }
    const activeForm =
      typeof o.activeForm === "string" && o.activeForm.length > 0
        ? o.activeForm
        : undefined;
    return { content, status: status as TaskStatus, activeForm };
  });
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  if (inProgress > 1) {
    throw new Error(
      "update_tasks: at most one task may be 'in_progress' at a time",
    );
  }
  return tasks;
}

/** Status → a single-glyph marker for compact rendering. */
export function statusMark(status: TaskStatus, config?: Config): string {
  const nerdFont = config?.ui.nerdFont === true;
  if (status === "completed") return iconFor("taskDone", nerdFont);
  if (status === "in_progress") return iconFor("taskProgress", nerdFont);
  return iconFor("taskPending", nerdFont);
}

/**
 * Format the list into the string the tool returns to the model, so it sees the
 * recorded state (and a one-line progress tally) on its next turn.
 */
export function formatTasks(tasks: Task[], config?: Config): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const lines = tasks.map(
    (t) => `${statusMark(t.status, config)} ${t.content}`,
  );
  return [`Task list updated (${done}/${tasks.length} done):`, ...lines].join(
    "\n",
  );
}

const DESCRIPTION = [
  "Record or update your task list — your own todo list for the current request.",
  "Pass the COMPLETE list every time (a full snapshot, not a diff); each task has",
  "`content` (imperative), `status` (pending | in_progress | completed), and an",
  "optional `activeForm` (present-continuous label shown while it runs). Keep exactly",
  "one task `in_progress` at a time: mark a task in_progress before you start it and",
  "completed the moment it is done. Use this for any request that spans multiple",
  "distinct issues or is a large multi-step feature — lay out the tasks first, then",
  "work them sequentially. Tracking-only: it changes nothing",
  "in the project.",
].join(" ");

/**
 * Build the `update_tasks` tool around an updater. `readOnly` is true — recording
 * the list mutates nothing, so it is allowed in plan mode and never trips the
 * approval gate.
 */
export function updateTasksTool(onUpdate: TaskUpdateFn, config?: Config): Tool {
  return {
    name: "update_tasks",
    description: DESCRIPTION,
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          description: "The complete task list (a full snapshot every call).",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Imperative description of the task.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "The task's lifecycle state.",
              },
              activeForm: {
                type: "string",
                description:
                  "Present-continuous label shown while in progress (optional).",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["tasks"],
    },
    async run(input) {
      const tasks = parseTasks(input);
      onUpdate(tasks);
      return formatTasks(tasks, config);
    },
  };
}

const TASKS_PROMPT_SECTION = [
  "## Tasks",
  "When a request spans multiple distinct issues or is a large multi-step",
  "feature, call update_tasks FIRST to lay the work out as a task list (one",
  "task per issue or major step), then keep it current — in_progress before",
  "you start a task, completed the moment it is done. For a single small,",
  "self-contained request, skip the task list and just do the work.",
].join("\n");

export function tasksExtension(onUpdate: TaskUpdateFn): SessionExtension {
  return {
    name: "tasks",
    tools: (ctx) => [updateTasksTool(onUpdate, ctx.config)],
    systemPrompt: () => TASKS_PROMPT_SECTION,
  };
}
