// tools.test.ts — read_file's image handling.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreTools, tools } from "./tools.ts";

const readFile = tools.find((t) => t.name === "read_file")!;

describe("read_file with images", () => {
  const path = join(tmpdir(), "canarycode-tools-image.png");
  afterEach(async () => {
    await rm(path, { force: true });
  });

  test("returns an image payload (not text) for an image file", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await Bun.write(path, bytes);
    const out = await readFile.run({ path });
    if (typeof out === "string") throw new Error("expected a ToolRunResult");
    expect(out.image).toEqual({
      mediaType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    });
    // The text content is a short human/model-readable marker, not the bytes.
    expect(out.content).toContain("image/png");
  });

  test("still reads text files as numbered text", async () => {
    const out = await readFile.run({ path: "package.json" });
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain('"name": "canarycode"');
  });
});

describe("bash", () => {
  const bash = tools.find((t) => t.name === "bash")!;

  test("returns combined output and exit-code marker", async () => {
    const ok = await bash.run({ command: "echo hi" });
    expect(typeof ok === "string" ? ok : ok.content).toBe("hi\n");
    const fail = await bash.run({ command: "echo oops; exit 3" });
    expect(typeof fail === "string" ? fail : fail.content).toContain(
      "[exit 3]",
    );
    expect(typeof fail === "string" ? fail : fail.content).toContain("oops");
  });

  test("a surviving background child does not hang the tool", async () => {
    // `sleep 5 &` inherits the stdout pipe and holds it open after the shell
    // exits; the tool must return the captured output promptly regardless.
    const started = Date.now();
    const out = await bash.run({ command: "echo started; sleep 5 &" });
    expect(typeof out === "string" ? out : out.content).toContain("started");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("times out and reports partial output", async () => {
    const started = Date.now();
    await expect(
      bash.run({ command: "echo partial; sleep 10", timeout: 500 }),
    ).rejects.toThrow(/timed out.*partial/s);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("background shells retain logs and report exit status", async () => {
    const core = createCoreTools();
    const run = core.tools.find((t) => t.name === "bash")!;
    const output = core.tools.find((t) => t.name === "bash_output")!;
    try {
      const started = await run.run({
        command: "echo first; sleep 0.1; echo second",
        run_in_background: true,
      });
      const text = typeof started === "string" ? started : started.content;
      const id = text.match(/shell_\d+/)?.[0];
      expect(id).toBeDefined();

      let logText = "";
      for (let i = 0; i < 100 && !logText.includes("Status: exited"); i++) {
        await Bun.sleep(50);
        const logs = await output.run({ shell_id: id });
        logText = typeof logs === "string" ? logs : logs.content;
      }
      expect(logText).toContain("Status: exited (code 0)");
      expect(logText).toContain("first\nsecond");
      expect(logText).toContain("next_offset=");
    } finally {
      await core.dispose();
    }
  });

  test("background shells can be killed and keep their logs", async () => {
    const core = createCoreTools();
    const run = core.tools.find((t) => t.name === "bash")!;
    const output = core.tools.find((t) => t.name === "bash_output")!;
    const kill = core.tools.find((t) => t.name === "bash_kill")!;
    try {
      const started = await run.run({
        command: "echo ready; sleep 30",
        run_in_background: true,
      });
      const text = typeof started === "string" ? started : started.content;
      const id = text.match(/shell_\d+/)?.[0];
      expect(id).toBeDefined();

      const stopped = await kill.run({ shell_id: id });
      expect(typeof stopped === "string" ? stopped : stopped.content).toContain(
        "killed",
      );
      const logs = await output.run({ shell_id: id });
      expect(typeof logs === "string" ? logs : logs.content).toContain("ready");
    } finally {
      await core.dispose();
    }
  });
});

describe("edit_file whitespace tolerance", () => {
  const edit = tools.find((t) => t.name === "edit_file")!;
  const path = join(tmpdir(), "canarycode-edit-tolerant.py");
  afterEach(async () => {
    await rm(path, { force: true });
  });

  test("matches when only spacing differs and keeps the indentation", async () => {
    await Bun.write(path, "def add(a,b):\n    return a-b\n");
    const out = await edit.run({
      path,
      old: "    return a - b",
      new: "    return a + b",
    });
    expect(typeof out === "string" ? out : out.content).toContain(
      "ignoring whitespace",
    );
    expect(await Bun.file(path).text()).toBe(
      "def add(a,b):\n    return a + b\n",
    );
  });

  test("accepts the numbered view pasted back from read_file", async () => {
    await Bun.write(path, "one\ntwo\nthree\n");
    await edit.run({ path, old: "2\ttwo\n3\tthree", new: "2\n3" });
    expect(await Bun.file(path).text()).toBe("one\n2\n3\n");
  });

  test("refuses a whitespace-insensitive match that is not unique", async () => {
    await Bun.write(path, "x = a-b\ny = a - b\n");
    await expect(
      edit.run({ path, old: "a  -  b", new: "a + b" }),
    ).rejects.toThrow(/several places/);
  });

  test("a miss names the closest line", async () => {
    await Bun.write(path, "alpha\nbeta gamma\n");
    await expect(
      edit.run({ path, old: "beta gamma\ndelta", new: "x" }),
    ).rejects.toThrow(/line 2/);
  });
});
