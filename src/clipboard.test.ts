// clipboard.test.ts — platform guard for the clipboard image reader.

import { describe, expect, test } from "bun:test";
import { readClipboardImage } from "./clipboard.ts";

describe("readClipboardImage", () => {
  test("returns null on non-macOS platforms (no shell-out)", async () => {
    expect(await readClipboardImage("linux")).toBeNull();
    expect(await readClipboardImage("win32")).toBeNull();
  });
});
