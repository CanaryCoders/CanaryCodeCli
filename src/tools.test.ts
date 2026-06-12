// tools.test.ts — read_file's image handling.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "./tools.ts";

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
});
