// tui/Tasks.tsx — the live task-list panel.
//
// Renders the agent's current todo list (from the update_tasks tool) just above
// the input region, so the user can watch the plan progress. Completed tasks are
// dimmed, the in-progress one is tinted and shows its `activeForm` label, pending
// tasks are plain. Presentation only — state lives in App.

import { Box, Text } from "ink";
import { statusMark, type Task } from "../tasks.ts";
import { SPACING, tint } from "./theme.ts";

interface TasksProps {
  tasks: Task[];
}

export function Tasks({ tasks }: TasksProps) {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <Box marginTop={SPACING.inputGap} flexDirection="column">
      <Text dimColor>{`Tasks (${done}/${tasks.length})`}</Text>
      {tasks.map((t, i) => {
        const mark = statusMark(t.status);
        // The in-progress task shows its present-continuous label when given.
        const label =
          t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        if (t.status === "completed") {
          return (
            <Text key={`${i}-${t.content}`} dimColor>
              {`  ${mark} ${label}`}
            </Text>
          );
        }
        if (t.status === "in_progress") {
          return (
            <Text key={`${i}-${t.content}`} color={tint("yellow")}>
              {`  ${mark} ${label}`}
            </Text>
          );
        }
        return <Text key={`${i}-${t.content}`}>{`  ${mark} ${label}`}</Text>;
      })}
    </Box>
  );
}
