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

  test("a disabled extension's startup never runs and is listed as off", async () => {
    let ran = 0;
    setUserExtensions([
      stub("probe", {
        startup: async () => {
          ran++;
          return undefined;
        },
      }),
    ]);
    const config = defaultConfig();
    config.extensions.probe = false;
    const notes = await startupExtensions(config, "live");
    expect(ran).toBe(0);
    expect(notes.join("\n")).toContain("extensions disabled: probe");
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
