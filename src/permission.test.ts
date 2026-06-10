// permission.test.ts — AI permission checker: fail-open default, opt-in fail-closed.

import { expect, test } from "bun:test";
import { checkCommandSafety } from "./permission.ts";
import type { Provider, StreamEvent } from "./provider.ts";

/** A provider whose stream throws immediately (network down). */
const throwingProvider = {
  id: "f",
  stream: () => {
    throw new Error("net down");
  },
} as unknown as Provider;

/** A provider that streams text with no parseable verdict. */
const gibberishProvider = {
  id: "f",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "I am not JSON at all" };
    yield { type: "done", stopReason: "end_turn" } as StreamEvent;
  },
} as unknown as Provider;

test("checkCommandSafety fails open by default", async () => {
  const v = await checkCommandSafety(throwingProvider, "m", {
    name: "bash",
    input: {},
  });
  expect(v.safe).toBe(true);
  expect(v.reason).toContain("net down");
});

test("checkCommandSafety fails closed when asked", async () => {
  const v = await checkCommandSafety(
    throwingProvider,
    "m",
    { name: "bash", input: {} },
    undefined,
    { failClosed: true },
  );
  expect(v.safe).toBe(false);
  expect(v.reason).toContain("net down");
});

test("no parseable verdict fails open by default", async () => {
  const v = await checkCommandSafety(gibberishProvider, "m", {
    name: "bash",
    input: {},
  });
  expect(v.safe).toBe(true);
});

test("no parseable verdict fails closed when asked", async () => {
  const v = await checkCommandSafety(
    gibberishProvider,
    "m",
    { name: "bash", input: {} },
    undefined,
    { failClosed: true },
  );
  expect(v.safe).toBe(false);
  expect(v.reason).toContain("no verdict");
});
