// clipboard.ts — read an image off the system clipboard (Ctrl+V image paste).
//
// A terminal only delivers *text* over stdin on paste, so a copied image never
// reaches the TUI as bytes. To support pasting a screenshot we go out-of-band and
// ask the OS clipboard directly. Under SSH this means the *remote* OS clipboard,
// not the local terminal's clipboard; there is no portable OSC 52 equivalent for
// reading local clipboard images. macOS ships AppleScript (`osascript`), so we
// cast the clipboard to PNG and write it to a temp file — no extra dependency.
// Other platforms return null for now (callers fall back to file-path attachment).

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageData } from "./image.ts";

/**
 * Read an image from the clipboard as base64 PNG, or null when there's no image
 * (or on an unsupported platform). `platform` is injectable for testing.
 */
export async function readClipboardImage(
  platform: NodeJS.Platform = process.platform,
): Promise<ImageData | null> {
  if (platform !== "darwin") return null;

  const out = join(tmpdir(), `canarycode-clip-${process.pid}.png`);
  // AppleScript: cast the clipboard to PNG data and write it out; "none" when the
  // clipboard holds no image (the «class PNGf» coercion fails).
  const script = [
    "try",
    "set png to (the clipboard as «class PNGf»)",
    `set fp to open for access POSIX file ${JSON.stringify(out)} with write permission`,
    "set eof fp to 0",
    "write png to fp",
    "close access fp",
    'return "ok"',
    "on error",
    "try",
    "close access fp",
    "end try",
    'return "none"',
    "end try",
  ];
  const args = ["osascript"];
  for (const line of script) args.push("-e", line);

  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (stdout.trim() !== "ok") return null;
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    if (bytes.length === 0) return null;
    return {
      mediaType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    };
  } catch {
    return null;
  } finally {
    await rm(out, { force: true }).catch(() => {});
  }
}
