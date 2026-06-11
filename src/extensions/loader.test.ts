// loader.test.ts — user-extension discovery, trust gating, and skip notes.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { loadUserExtensions } from "./loader.ts";

async function setup(): Promise<{
  userDir: string;
  projectDir: string;
  trustFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cc-loader-"));
  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { userDir, projectDir, trustFile: join(root, "trust.json") };
}

const EXT_SOURCE = `export default {
  name: "declared-name-is-ignored",
  description: "a test extension",
  commands: [{ name: "hello-cmd", description: "hi", run: async () => {} }],
};`;

describe("loadUserExtensions", () => {
  test("loads a user-dir extension; name comes from the filename stem", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.userDir, "myext.ts"), EXT_SOURCE);
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
    });
    expect(exts.map((e) => e.name)).toEqual(["myext"]);
    expect(exts[0].description).toBe("a test extension");
    expect(exts[0].commands?.[0]?.name).toBe("hello-cmd");
  });

  test("a disabled extension is never imported but stays visible as a stub", async () => {
    const dirs = await setup();
    const sentinel = join(dirs.userDir, "sentinel.txt");
    await writeFile(
      join(dirs.userDir, "spy.ts"),
      `await Bun.write(${JSON.stringify(sentinel)}, "imported");
export default { description: "spy", commands: [] };`,
    );
    const config = defaultConfig();
    config.extensions.spy = false;
    const exts = await loadUserExtensions(config, { ...dirs, note: () => {} });
    expect(exts.map((e) => e.name)).toEqual(["spy"]);
    expect(exts[0].commands).toBeUndefined(); // the stub has no capabilities
    expect(await Bun.file(sentinel).exists()).toBe(false); // never executed
  });

  test("project extensions need approval; approval persists by content hash", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.projectDir, "proj.ts"), EXT_SOURCE);
    const asked: { name: string; path: string; changed: boolean }[] = [];
    const confirm = async (info: {
      name: string;
      path: string;
      changed: boolean;
    }) => {
      asked.push(info);
      return true;
    };
    const first = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
      confirm,
    });
    expect(first.map((e) => e.name)).toEqual(["proj"]);
    expect(asked.map((i) => i.name)).toEqual(["proj"]);
    expect(asked[0].changed).toBe(false); // first-ever approval
    // Second load: hash unchanged → trusted, no re-prompt.
    await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
      confirm,
    });
    expect(asked.map((i) => i.name)).toEqual(["proj"]);
    // Content change → re-prompt. (Module cache means the OLD module is
    // returned in-process; only the prompt behavior is asserted here.)
    await writeFile(
      join(dirs.projectDir, "proj.ts"),
      `${EXT_SOURCE}\n// changed`,
    );
    await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
      confirm,
    });
    expect(asked.map((i) => i.name)).toEqual(["proj", "proj"]);
    expect(asked[1].changed).toBe(true); // a previous approval exists
  });

  test("with no confirm (headless) an unapproved project extension is skipped", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.projectDir, "proj.ts"), EXT_SOURCE);
    const notes: string[] = [];
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: (t) => notes.push(t),
    });
    expect(exts).toEqual([]);
    expect(notes.join("\n")).toContain("not approved");
  });

  test("a denied project extension is skipped and not persisted", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.projectDir, "proj.ts"), EXT_SOURCE);
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
      confirm: async () => false,
    });
    expect(exts).toEqual([]);
    expect(await Bun.file(dirs.trustFile).exists()).toBe(false);
  });

  test("a broken module is skipped with a note, never thrown", async () => {
    const dirs = await setup();
    await writeFile(
      join(dirs.userDir, "broken.ts"),
      "throw new Error('boom');",
    );
    await writeFile(join(dirs.userDir, "shapeless.ts"), "export default 42;");
    await writeFile(join(dirs.userDir, "good.ts"), EXT_SOURCE);
    const notes: string[] = [];
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: (t) => notes.push(t),
    });
    expect(exts.map((e) => e.name)).toEqual(["good"]);
    expect(notes.join("\n")).toContain("broken");
    expect(notes.join("\n")).toContain("shapeless");
  });

  test("a name collision with a built-in is skipped", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.userDir, "codex.ts"), EXT_SOURCE);
    const notes: string[] = [];
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: (t) => notes.push(t),
    });
    expect(exts).toEqual([]);
    expect(notes.join("\n")).toContain("codex");
  });

  test("on a user/project name collision the user-dir file wins", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.userDir, "dup.ts"), EXT_SOURCE);
    await writeFile(
      join(dirs.projectDir, "dup.ts"),
      `export default { description: "project copy", commands: [] };`,
    );
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
      confirm: async () => true,
    });
    expect(exts.map((e) => e.name)).toEqual(["dup"]);
    expect(exts[0].description).toBe("a test extension");
  });

  test("a directory named dir.ts in the project dir is skipped, not thrown", async () => {
    const dirs = await setup();
    await mkdir(join(dirs.projectDir, "dir.ts"));
    await writeFile(join(dirs.projectDir, "good.ts"), EXT_SOURCE);
    const notes: string[] = [];
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: (t) => notes.push(t),
      confirm: async () => true,
    });
    expect(exts.map((e) => e.name)).toEqual(["good"]);
    expect(notes.join("\n")).toContain("dir.ts");
  });

  test("a .js extension file in the user dir loads", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.userDir, "jsext.js"), EXT_SOURCE);
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: () => {},
    });
    expect(exts.map((e) => e.name)).toEqual(["jsext"]);
    expect(exts[0].description).toBe("a test extension");
  });

  test("a disabled project extension stubs without ever prompting", async () => {
    const dirs = await setup();
    await writeFile(join(dirs.projectDir, "proj.ts"), EXT_SOURCE);
    const asked: unknown[] = [];
    const config = defaultConfig();
    config.extensions.proj = false;
    const exts = await loadUserExtensions(config, {
      ...dirs,
      note: () => {},
      confirm: async (info) => {
        asked.push(info);
        return true;
      },
    });
    expect(exts.map((e) => e.name)).toEqual(["proj"]);
    expect(exts[0].description).toContain("disabled");
    expect(asked).toEqual([]); // disabled is decided BEFORE the trust gate
  });

  test("an extension command shadowing a built-in is dropped with a note", async () => {
    const dirs = await setup();
    await writeFile(
      join(dirs.userDir, "shadow.ts"),
      `export default { description: "shadow", commands: [
        { name: "clear", description: "evil", run: async () => {} },
        { name: "fine-cmd", description: "ok", run: async () => {} },
      ] };`,
    );
    const notes: string[] = [];
    const exts = await loadUserExtensions(defaultConfig(), {
      ...dirs,
      note: (t) => notes.push(t),
    });
    expect(exts[0].commands?.map((c) => c.name)).toEqual(["fine-cmd"]);
    expect(notes.join("\n")).toContain("/clear");
  });
});
