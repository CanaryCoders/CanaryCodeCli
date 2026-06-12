// commands.test.ts — slash-command parsing and autocomplete.

import { describe, expect, test } from "bun:test";
import {
  type CommandSet,
  classifyBusyAction,
  makeCommandSet,
} from "./commands.ts";

/** The extension commands the old static registry used to bake in. */
const EXT_COMMANDS = [
  {
    name: "login-codex",
    usage: "[--manual]",
    description: "sign in with your ChatGPT (OpenAI Codex) subscription",
  },
  {
    name: "logout-codex",
    description: "sign out of your ChatGPT (OpenAI Codex) subscription",
  },
  { name: "login-opencode", description: "connect OpenCode Zen" },
  { name: "logout-opencode", description: "disconnect OpenCode Zen" },
];
const set: CommandSet = makeCommandSet(EXT_COMMANDS);
const dispatchCommand = set.dispatch;
const completions = set.completions;

const ctx = {
  models: [
    { id: "opus", source: "Anthropic" },
    { id: "sonnet", source: "Anthropic" },
    { id: "gpt-5", source: "Codex" },
  ],
  sessions: [{ id: "abcdef123456", title: "recent work" }],
};

test("classifyBusyAction routes commands typed while busy", () => {
  // live: applied immediately (state/config + read-only notes)
  expect(classifyBusyAction({ kind: "set-model", model: "x" })).toBe("live");
  expect(classifyBusyAction({ kind: "set-think", level: "off" })).toBe("live");
  expect(classifyBusyAction({ kind: "set-mode", mode: "plan" })).toBe("live");
  expect(classifyBusyAction({ kind: "list-models" })).toBe("live");
  expect(classifyBusyAction({ kind: "cost" })).toBe("live");
  expect(classifyBusyAction({ kind: "help", text: "" })).toBe("live");
  // queue: injected at the next-step boundary
  expect(classifyBusyAction({ kind: "message", text: "hi" })).toBe("queue");
  expect(classifyBusyAction({ kind: "init" })).toBe("queue");
  // defer: not safe mid-turn — show a note, run nothing
  expect(classifyBusyAction({ kind: "copy-open" })).toBe("defer");
  expect(classifyBusyAction({ kind: "clear" })).toBe("defer");
  expect(classifyBusyAction({ kind: "exit" })).toBe("defer");
  expect(classifyBusyAction({ kind: "update" })).toBe("defer");
  expect(
    classifyBusyAction({ kind: "extension-command", name: "x", args: [] }),
  ).toBe("defer");
  expect(classifyBusyAction({ kind: "config", op: "summary" })).toBe("defer");
  expect(classifyBusyAction({ kind: "extensions", op: "list" })).toBe("defer");
  expect(classifyBusyAction({ kind: "resume" })).toBe("defer");
  expect(classifyBusyAction({ kind: "error", message: "" })).toBe("defer");
});

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

  test("/copy enters nav mode and shows in /help and autocomplete", () => {
    expect(dispatchCommand("/copy")).toEqual({ kind: "copy-open" });
    const help = dispatchCommand("/help");
    if (help.kind === "help") expect(help.text).toContain("/copy");
    expect(completions("/copy", ctx).map((c) => c.label)).toContain("/copy");
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

describe("dispatchCommand /extensions", () => {
  test("bare /extensions lists", () => {
    expect(dispatchCommand("/extensions")).toEqual({
      kind: "extensions",
      op: "list",
    });
  });

  test("enable/disable carry the extension name", () => {
    expect(dispatchCommand("/extensions enable opencode")).toEqual({
      kind: "extensions",
      op: "enable",
      name: "opencode",
    });
    expect(dispatchCommand("/extensions disable websearch")).toEqual({
      kind: "extensions",
      op: "disable",
      name: "websearch",
    });
  });

  test("a missing name is a usage error", () => {
    expect(dispatchCommand("/extensions enable").kind).toBe("error");
    expect(dispatchCommand("/extensions bogus opencode").kind).toBe("error");
  });
});

describe("dispatchCommand built-in extension commands", () => {
  test("login/logout commands dispatch generically with args", () => {
    expect(dispatchCommand("/login-codex --manual")).toEqual({
      kind: "extension-command",
      name: "login-codex",
      args: ["--manual"],
    });
    expect(dispatchCommand("/login-opencode")).toEqual({
      kind: "extension-command",
      name: "login-opencode",
      args: [],
    });
    expect(dispatchCommand("/logout-opencode")).toEqual({
      kind: "extension-command",
      name: "logout-opencode",
      args: [],
    });
  });
});

describe("completions /extensions", () => {
  test("bare arg suggests nothing so Enter submits the picker", () => {
    expect(completions("/extensions ", ctx)).toEqual([]);
  });

  test("completes the op once typed", () => {
    const ops = completions("/extensions en", ctx).map((c) => c.label);
    expect(ops).toContain("enable");
  });

  test("completes extension names after enable/disable", () => {
    const extCtx = {
      extensions: [
        { name: "websearch", description: "the web_search tool" },
        { name: "codex", description: "OpenAI Codex models" },
      ],
    };
    const names = completions("/extensions disable ", extCtx).map(
      (c) => c.label,
    );
    expect(names).toContain("websearch");
    expect(names).toContain("codex");
  });
});

describe("makeCommandSet reflects the extension set", () => {
  test("a command absent from the set is unknown", () => {
    const bare = makeCommandSet([]);
    expect(bare.dispatch("/login-codex")).toMatchObject({ kind: "error" });
    expect(
      bare
        .completions("/login", {})
        .map((c) => c.label)
        .join(" "),
    ).not.toContain("login-codex");
  });

  test("help lists extension commands only when present", () => {
    const withExt = makeCommandSet(EXT_COMMANDS);
    const helpWith = withExt.dispatch("/help");
    expect(helpWith.kind).toBe("help");
    if (helpWith.kind === "help")
      expect(helpWith.text).toContain("login-codex");
    const bare = makeCommandSet([]);
    const helpBare = bare.dispatch("/help");
    expect(helpBare.kind).toBe("help");
    if (helpBare.kind === "help")
      expect(helpBare.text).not.toContain("login-codex");
  });

  test("an extension command cannot shadow a built-in", () => {
    const set = makeCommandSet([
      { name: "clear", description: "evil shadow" },
      { name: "q", description: "alias shadow" },
    ]);
    expect(set.dispatch("/clear")).toEqual({ kind: "clear" });
    expect(set.dispatch("/q")).toEqual({ kind: "exit" });
    expect(set.specs.filter((c) => c.name === "clear")).toHaveLength(1);
  });
});
