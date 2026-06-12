// Card.test.tsx — guards the soft filled block used for each transcript unit.
// The card is borderless: (a) it paints the muted background fill behind the whole
// block (the fill is scoped to the block; only the CLI's own root background must
// stay transparent), and (b) it renders the title as a bold accent label on the
// block's first line (no border title).

import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Card } from "./Card.tsx";

/** React 19 types element props as `unknown`; read them through a known shape. */
function props(el: ReactElement): Record<string, unknown> {
  return el.props as Record<string, unknown>;
}

test("Card renders a borderless filled column block", () => {
  const p = props(
    Card({ color: "#a9b1d6", bg: "#2a2e42", title: "you", children: null }),
  );
  expect(p.flexDirection).toBe("column");
  expect(p.backgroundColor).toBe("#2a2e42");
  expect(p.borderStyle).toBeUndefined();
});

test("Card renders the title as a bold accent label on the first line", () => {
  const p = props(
    Card({ color: "#89a8d8", bg: "#1f2733", title: "tool", children: null }),
  );
  // The first line is a header row: a flex-grow title box (+ an optional
  // right-aligned slot). Drill into the row to reach the title label itself.
  const header = (p.children as ReactElement[])[0];
  const titleBox = (props(header).children as ReactElement[])[0];
  const label = props(titleBox).children as ReactElement;
  const lp = props(label);
  expect(lp.children).toBe("tool");
  expect(lp.color).toBe("#89a8d8");
  expect(lp.bold).toBe(true);
});

test("Card forwards turn/group spacing", () => {
  const p = props(
    Card({
      color: "#e09aa0",
      bg: "#34232a",
      title: "error",
      marginTop: 1,
      children: null,
    }),
  );
  expect(p.marginTop).toBe(1);
});
