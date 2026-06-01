// commands.test.ts — slash-command parsing and autocomplete.

import { describe, expect, test } from "bun:test";
import { completions, dispatchCommand } from "./commands.ts";

const ctx = {
  models: ["opus", "sonnet", "gpt-5"],
  sessions: [{ id: "abcdef123456", title: "recent work" }],
};

describe("dispatchCommand /config", () => {
  test("parses summary/get/set/unset/reload", () => {
    expect(dispatchCommand("/config")).toEqual({
      kind: "config",
      op: "summary",
    });
    expect(dispatchCommand("/config get model")).toEqual({
      kind: "config",
      op: "get",
      path: "model",
    });
    expect(
      dispatchCommand('/config set providers.x {"api":"anthropic"}'),
    ).toEqual({
      kind: "config",
      op: "set",
      path: "providers.x",
      value: '{"api":"anthropic"}',
    });
    expect(dispatchCommand("/config unset models.coding")).toEqual({
      kind: "config",
      op: "unset",
      path: "models.coding",
    });
    expect(dispatchCommand("/config reload")).toEqual({
      kind: "config",
      op: "reload",
    });
    expect(dispatchCommand("/config reload mcp")).toEqual({
      kind: "config",
      op: "reload",
      path: "mcp",
    });
  });

  test("keeps set value as raw string", () => {
    expect(dispatchCommand("/config set confirm writes")).toEqual({
      kind: "config",
      op: "set",
      path: "confirm",
      value: "writes",
    });
    expect(dispatchCommand("/config set webSearch.apiKey hello world")).toEqual(
      {
        kind: "config",
        op: "set",
        path: "webSearch.apiKey",
        value: "hello world",
      },
    );
  });

  test("returns usage errors for malformed config commands", () => {
    expect(dispatchCommand("/config get")).toMatchObject({ kind: "error" });
    expect(dispatchCommand("/config set model")).toMatchObject({
      kind: "error",
    });
    expect(dispatchCommand("/config reload all")).toMatchObject({
      kind: "error",
    });
  });

  test("help includes config", () => {
    const action = dispatchCommand("/help");
    expect(action.kind).toBe("help");
    if (action.kind === "help") expect(action.text).toContain("/config");
  });
});

describe("completions /config", () => {
  test("suggests config command and subcommands", () => {
    expect(completions("/conf", ctx)[0]?.label).toContain("/config");
    expect(completions("/config ", ctx).map((c) => c.label)).toEqual([
      "get",
      "set",
      "unset",
      "reload",
    ]);
  });

  test("suggests common paths", () => {
    const labels = completions("/config get perm", ctx).map((c) => c.label);
    expect(labels).toContain("permission.mode");
    expect(labels).toContain("permission.scope");
  });

  test("suggests enum values and model ids for set", () => {
    expect(
      completions("/config set confirm ", ctx).map((c) => c.label),
    ).toEqual(["off", "bash", "writes"]);
    expect(
      completions("/config set ui.nerdFont ", ctx).map((c) => c.label),
    ).toEqual(["true", "false"]);
    expect(completions("/config set model ", ctx).map((c) => c.label)).toEqual([
      "opus",
      "sonnet",
      "gpt-5",
    ]);
    expect(
      completions("/config set models.coding g", ctx).map((c) => c.label),
    ).toEqual(["gpt-5"]);
  });

  test("suggests reload mcp", () => {
    expect(completions("/config reload ", ctx)).toEqual([
      { value: "/config reload mcp", label: "mcp" },
    ]);
  });
});
