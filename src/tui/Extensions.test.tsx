// Extensions.test.tsx — the `/extensions` checkbox picker, rendered for real
// through Ink against a fake terminal (a paused Readable feeds keys via the
// same `readable`/`read()` path Ink uses on a live stdin).

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { render } from "ink";
import type { ExtensionToggle } from "./Extensions.tsx";
import { ExtensionsView } from "./Extensions.tsx";

function fakeStdin(): Readable & { isTTY: boolean; setRawMode: () => void } {
  const stdin = new Readable({ read() {} }) as Readable & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

function fakeStdout(): NodeJS.WriteStream & { frames: string[] } {
  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream & {
    frames: string[];
  };
  stdout.frames = [];
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.write = ((chunk: string) => {
    stdout.frames.push(String(chunk));
    return true;
  }) as never;
  return stdout;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("picker renders state, space toggles, enter submits the batch", async () => {
  const items: ExtensionToggle[] = [
    { name: "codex", description: "ChatGPT models", enabled: true },
    { name: "opencode", description: "Zen models", enabled: false },
  ];
  let submitted: ExtensionToggle[] | null = null;
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const app = render(
    <ExtensionsView items={items} onSubmit={(next) => (submitted = next)} />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await tick();

  const frame = () => stdout.frames.join("");
  expect(frame()).toContain("[extensions]");
  expect(frame()).toContain("codex");
  expect(frame()).toContain("opencode");
  expect(frame()).toContain("space toggle");

  // Space on the first row (codex) flips it off…
  stdin.push(" ");
  await tick();
  // …↓ to opencode, space flips it on…
  stdin.push("\x1b[B");
  await tick();
  stdin.push(" ");
  await tick();
  // …Enter submits the whole batch.
  stdin.push("\r");
  await tick();

  expect(submitted).not.toBeNull();
  const byName = Object.fromEntries(
    (submitted ?? []).map((e: ExtensionToggle) => [e.name, e.enabled]),
  );
  expect(byName).toEqual({ codex: false, opencode: true });

  app.unmount();
});
