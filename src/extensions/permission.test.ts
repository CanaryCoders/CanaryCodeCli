// permission.test.ts — AI permission checker: fail-open default, opt-in fail-closed.

import { expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import type { Provider, StreamEvent } from "../provider.ts";
import {
  buildPermissionGate,
  checkCommandSafety,
  composeGates,
} from "./permission.ts";

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

test("an aborted check fails open even under failClosed", async () => {
  const controller = new AbortController();
  // Aborts mid-stream: one partial delta, then the user cancels the run.
  const abortingProvider = {
    id: "f",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: '{"verdict":' };
      controller.abort();
      yield { type: "text_delta", text: '"unsafe","reason":"x"}' };
      yield { type: "done", stopReason: "end_turn" } as StreamEvent;
    },
  } as unknown as Provider;
  const v = await checkCommandSafety(
    abortingProvider,
    "m",
    { name: "bash", input: {} },
    controller.signal,
    { failClosed: true },
  );
  expect(v.safe).toBe(true);
  expect(v.reason).toBe("check aborted");
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

// ── buildPermissionGate ─────────────────────────────────────────────────────
// These exercise the unresolvable-model branches (no network call): a bogus
// permission model id forces resolveModel to miss, so the gate is built purely
// from config + failClosed without ever streaming a verdict.

/** A config whose permission checker model cannot resolve: with no providers,
 * resolveModel finds no match AND has nothing to fall back to → undefined. */
function unresolvableConfig(failClosed: boolean) {
  const config = defaultConfig();
  config.providers = {};
  config.permission = {
    mode: "ai",
    model: "no-such-model-xyz",
    scope: "writes",
    failClosed,
  };
  return config;
}

const signal = new AbortController().signal;

test("buildPermissionGate: unresolvable model, failClosed=false → undefined (disabled)", () => {
  const notes: string[] = [];
  const gate = buildPermissionGate({
    config: unresolvableConfig(false),
    signal,
    note: (t) => notes.push(t),
  });
  expect(gate).toBeUndefined();
  expect(notes.some((n) => n.includes("AI safety check disabled"))).toBe(true);
});

test("buildPermissionGate: unresolvable model, failClosed=true → denies in-scope, allows out-of-scope", async () => {
  const notes: string[] = [];
  const gate = buildPermissionGate({
    config: unresolvableConfig(true),
    signal,
    note: (t) => notes.push(t),
  });
  expect(gate).toBeDefined();
  expect(notes.some((n) => n.includes("gated calls will be blocked"))).toBe(
    true,
  );
  // bash is in the "writes" scope → blocked.
  const inScope = await gate!({ id: "1", name: "bash", input: {} });
  expect(inScope.allow).toBe(false);
  expect(inScope.reason).toContain("permission.failClosed is set");
  // read_file is not a mutating tool → allowed through.
  const outOfScope = await gate!({ id: "2", name: "read_file", input: {} });
  expect(outOfScope.allow).toBe(true);
});

// ── composeGates ────────────────────────────────────────────────────────────

const allowGate = async () => ({ allow: true });

test("composeGates: aiGate deny short-circuits the frontend gate", async () => {
  let frontendCalled = false;
  const denying = async () => ({ allow: false, reason: "no" });
  const frontend = async () => {
    frontendCalled = true;
    return { allow: true };
  };
  const gate = composeGates(denying, frontend);
  const v = await gate!({ id: "1", name: "bash", input: {} });
  expect(v.allow).toBe(false);
  expect(frontendCalled).toBe(false);
});

test("composeGates: both allow → allow", async () => {
  const gate = composeGates(allowGate, allowGate);
  const v = await gate!({ id: "1", name: "bash", input: {} });
  expect(v.allow).toBe(true);
});

test("composeGates: both undefined → undefined", () => {
  expect(composeGates(undefined, undefined)).toBeUndefined();
});
