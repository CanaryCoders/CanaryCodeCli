// Card.test.tsx — guards the slim titled card used for each transcript unit.
// The card must (a) embed its title in the border, (b) colour the border + title
// from the same ANSI token (which the terminal theme remaps), and (c) NEVER set a
// background, so a transparent terminal shows straight through.

import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Card } from "./Card.tsx";

/** React 19 types element props as `unknown`; read them through a known shape. */
function props(el: ReactElement): Record<string, unknown> {
  return el.props as Record<string, unknown>;
}

test("Card renders a titled, column box", () => {
  const p = props(Card({ color: "cyan", title: "you", children: null }));
  expect(p.title).toBe(" you ");
  expect(p.titleAlignment).toBe("left");
  expect(p.flexDirection).toBe("column");
  expect(p.borderStyle).toBe("round");
});

test("Card colours the border and title from one token", () => {
  const p = props(Card({ color: "blue", title: "tool", children: null }));
  expect(p.borderColor).toBe("blue");
  expect(p.titleColor).toBe("blue");
});

test("Card never paints a background (terminal shows through)", () => {
  const p = props(Card({ color: "green", title: "assistant", children: null }));
  expect(p.backgroundColor).toBeUndefined();
});

test("Card forwards turn/group spacing", () => {
  const p = props(
    Card({ color: "red", title: "error", marginTop: 1, children: null }),
  );
  expect(p.marginTop).toBe(1);
});
