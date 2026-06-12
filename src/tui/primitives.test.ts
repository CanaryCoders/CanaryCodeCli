// primitives.test.ts — guards the <text>-vs-<span> decision in the Text
// primitive. OpenTUI's <text> (a TextRenderable) rejects a nested <text> child
// ("TextNodeRenderable only accepts strings, …"), which crashed the whole TUI at
// first paint. A Text nested inside another Text must therefore emit an inline
// <span>. These tests exercise the pure builder so no live renderer is needed.

import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { buildTextElement, OpenTuiBox } from "./primitives.tsx";

/** React 19 types element props as `unknown`; read them through a known shape. */
function props(el: ReactElement): Record<string, unknown> {
  return el.props as Record<string, unknown>;
}

test("top-level Text emits a block <text> element", () => {
  expect(buildTextElement({ children: "hi" }, false).type).toBe("text");
});

test("nested Text emits an inline <span> (never a nested <text>)", () => {
  expect(buildTextElement({ children: "run" }, true).type).toBe("span");
});

test("a block <text> flags its subtree inside-text so children become spans", () => {
  const el = buildTextElement({ children: "x" }, false);
  // The single child is a context provider carrying value=true; any Text
  // rendered within it reads that and switches to <span>.
  const child = props(el).children as ReactElement;
  expect(props(child).value).toBe(true);
});

test("styling props pass through on both block and inline variants", () => {
  const block = buildTextElement(
    { color: "cyan", backgroundColor: "black" },
    false,
  );
  expect(props(block).fg).toBe("cyan");
  expect(props(block).bg).toBe("black");
  const inline = buildTextElement(
    { color: "cyan", backgroundColor: "black" },
    true,
  );
  expect(props(inline).fg).toBe("cyan");
  expect(props(inline).bg).toBe("black");
});

test("block-only wrap props apply to <text> but not <span>", () => {
  expect(props(buildTextElement({ wrap: "truncate" }, false)).truncate).toBe(
    true,
  );
  expect(
    props(buildTextElement({ wrap: "truncate" }, true)).truncate,
  ).toBeUndefined();
});

// Ink's <Box> defaults to flexDirection="row"; OpenTUI/Yoga defaults to
// "column". The TUI was authored against Ink, so Box must default to row or
// horizontal containers (footer bar, completion rows) stack vertically.
test("Box defaults to flexDirection=row to match Ink semantics", () => {
  expect(props(OpenTuiBox({ children: null })).flexDirection).toBe("row");
});

test("Box honours an explicit flexDirection", () => {
  expect(
    props(OpenTuiBox({ children: null, flexDirection: "column" }))
      .flexDirection,
  ).toBe("column");
});

// OpenTUI draws `title` into the border run, so a bordered Box reads as a titled
// card. The primitive must forward the title props onto the host <box>.
test("Box forwards title props to the host box element", () => {
  const p = props(
    OpenTuiBox({
      children: null,
      title: " you ",
      titleColor: "cyan",
      titleAlignment: "left",
    }),
  );
  expect(p.title).toBe(" you ");
  expect(p.titleColor).toBe("cyan");
  expect(p.titleAlignment).toBe("left");
});

test("Box forwards mouse props and cursor style", () => {
  const onMouseOver = () => {};
  const onMouseOut = () => {};
  const onMouseDown = () => {};
  const p = props(
    OpenTuiBox({
      children: null,
      cursor: "pointer",
      onMouseOver,
      onMouseOut,
      onMouseDown,
    }),
  );
  expect(p.cursor).toBe("pointer");
  expect(p.onMouseOver).toBe(onMouseOver);
  expect(p.onMouseOut).toBe(onMouseOut);
  expect(p.onMouseDown).toBe(onMouseDown);
});

test("Text forwards mouse props and cursor style", () => {
  const onMouseUp = () => {};
  const onMouseScroll = () => {};
  const p = props(
    buildTextElement(
      { children: "click", cursor: "pointer", onMouseUp, onMouseScroll },
      false,
    ),
  );
  expect(p.cursor).toBe("pointer");
  expect(p.onMouseUp).toBe(onMouseUp);
  expect(p.onMouseScroll).toBe(onMouseScroll);
});
