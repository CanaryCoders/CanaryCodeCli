import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import type { Extension } from "../extension.ts";
import {
  availableCommands,
  enabledExtensions,
  findCommand,
  findCommandAnywhere,
  foldPresets,
  listExtensions,
  sessionExtensions,
  setUserExtensions,
  startupExtensions,
} from "./registry.ts";

function stub(name: string, overrides: Partial<Extension> = {}): Extension {
  return { name, description: `${name} stub`, ...overrides };
}

afterEach(() => setUserExtensions([]));

describe("registry gating", () => {
  test("a disabled extension exposes no commands", () => {
    setUserExtensions([
      stub("probe", {
        commands: [
          { name: "probe-cmd", description: "x", run: async () => {} },
        ],
      }),
    ]);
    const config = defaultConfig();
    expect(findCommand(config, "probe-cmd")).toBeDefined();
    config.extensions.probe = false;
    expect(findCommand(config, "probe-cmd")).toBeUndefined();
    expect(availableCommands(config).map((c) => c.name)).not.toContain(
      "probe-cmd",
    );
    // …but findCommandAnywhere still locates it, for the CLI's clear error.
    expect(findCommandAnywhere("probe-cmd")?.extension.name).toBe("probe");
  });

  test("duplicate command names dedupe; the earlier extension wins", () => {
    setUserExtensions([
      stub("first", {
        commands: [
          { name: "dup-cmd", description: "first owner", run: async () => {} },
        ],
      }),
      stub("second", {
        commands: [
          { name: "dup-cmd", description: "second owner", run: async () => {} },
        ],
      }),
    ]);
    const dups = availableCommands(defaultConfig()).filter(
      (c) => c.name === "dup-cmd",
    );
    expect(dups).toHaveLength(1);
    expect(dups[0].description).toBe("first owner");
  });

  test("a disabled extension's startup never runs and is listed as off", async () => {
    let ran = 0;
    setUserExtensions([
      stub("probe", {
        startup: async () => {
          ran++;
          return "note: probe started";
        },
      }),
    ]);

    // Positive control: with probe enabled (default), startup runs once and
    // its returned note appears in the output.
    const enabledConfig = defaultConfig();
    const enabledNotes = await startupExtensions(enabledConfig, "live");
    expect(ran).toBe(1);
    expect(enabledNotes.join("\n")).toContain("note: probe started");

    // Negative control: flip the toggle and confirm startup does NOT run again
    // and the disabled note appears instead.
    const disabledConfig = defaultConfig();
    disabledConfig.extensions.probe = false;
    const disabledNotes = await startupExtensions(disabledConfig, "live");
    expect(ran).toBe(1);
    expect(disabledNotes.join("\n")).toContain("extensions disabled: probe");
  });

  test("a disabled extension contributes no session extension", () => {
    setUserExtensions([stub("probe", { session: () => ({ name: "probe" }) })]);
    const config = defaultConfig();
    expect(sessionExtensions(config).map((s) => s.name)).toContain("probe");
    config.extensions.probe = false;
    expect(sessionExtensions(config).map((s) => s.name)).not.toContain("probe");
  });

  test("foldPresets adds enabled presets and never clobbers user providers", () => {
    setUserExtensions([
      stub("probe", {
        providerPresets: () => ({
          probeprov: { api: "openai-compat", baseUrl: "https://probe.example" },
        }),
      }),
    ]);
    const config = defaultConfig();
    foldPresets(config);
    expect(config.providers.probeprov?.baseUrl).toBe("https://probe.example");

    const config2 = defaultConfig();
    config2.providers.probeprov = {
      api: "openai-compat",
      baseUrl: "https://mine.example",
    };
    foldPresets(config2);
    expect(config2.providers.probeprov.baseUrl).toBe("https://mine.example");

    const config3 = defaultConfig();
    config3.extensions.probe = false;
    foldPresets(config3);
    expect(config3.providers.probeprov).toBeUndefined();
  });

  test("a throwing providerPresets is contained and noted", () => {
    setUserExtensions([
      stub("bad", {
        providerPresets: () => {
          throw new Error("preset boom");
        },
      }),
      stub("good", {
        providerPresets: () => ({
          goodprov: { api: "openai-compat", baseUrl: "https://good.example" },
        }),
      }),
    ]);
    const config = defaultConfig();
    const notes: string[] = [];
    foldPresets(config, (t) => notes.push(t));
    expect(config.providers.goodprov).toBeDefined();
    expect(notes.join("\n")).toContain("preset boom");
  });

  test("a throwing session factory is contained and noted", () => {
    setUserExtensions([
      stub("bad", {
        session: () => {
          throw "session boom";
        },
      }),
      stub("good", { session: () => ({ name: "good" }) }),
    ]);
    const config = defaultConfig();
    const notes: string[] = [];
    const sessions = sessionExtensions(config, (t) => notes.push(t));
    // Built-in sessions still assemble; of the two user stubs only "good"
    // survives — "bad" threw and was skipped.
    const names = sessions.map((s) => s.name);
    expect(names.filter((n) => n === "good" || n === "bad")).toEqual(["good"]);
    expect(notes.join("\n")).toContain("session boom");
  });

  test("defaultEnabled:false stays off until explicitly enabled", () => {
    setUserExtensions([stub("optin", { defaultEnabled: false })]);
    const config = defaultConfig();
    expect(enabledExtensions(config).map((e) => e.name)).not.toContain("optin");
    config.extensions.optin = true;
    expect(enabledExtensions(config).map((e) => e.name)).toContain("optin");
  });

  test("listExtensions reports built-ins and user extensions with live state", () => {
    setUserExtensions([stub("probe")]);
    const config = defaultConfig();
    config.extensions.codex = false;
    const list = listExtensions(config);
    const byName = new Map(list.map((e) => [e.name, e.enabled]));
    expect(byName.get("codex")).toBe(false);
    expect(byName.get("websearch")).toBe(true);
    expect(byName.get("probe")).toBe(true);
  });
});
