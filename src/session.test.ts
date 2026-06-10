// session.test.ts — unit tests for the bun:sqlite SessionStore.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "./provider.ts";
import { SessionStore } from "./session.ts";

describe("SessionStore.loadMessages", () => {
  test("skips a corrupt turn row instead of throwing", () => {
    const path = join(tmpdir(), `cc-test-${crypto.randomUUID()}.db`);
    try {
      let store = SessionStore.open(path);
      // Transcripts may hold secrets — the store must keep the db owner-only.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const id = store.createSession({ model: "test-model", cwd: "/tmp" });
      const user: Message = {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      };
      const assistant: Message = {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      };
      store.appendTurn(id, user);
      store.appendTurn(id, assistant);
      store.close();

      // Corrupt the first turn's JSON behind the store's back (simulates a
      // partial write or manual edit).
      const raw = new Database(path);
      raw.run("UPDATE turns SET content = '{broken' WHERE idx = 0");
      raw.close();

      store = SessionStore.open(path);
      const messages = store.loadMessages(id);
      store.close();

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toEqual([{ type: "text", text: "hi there" }]);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(path + suffix, { force: true });
      }
    }
  });

  test("returns all appended turns in order when nothing is corrupt", () => {
    const store = SessionStore.open(":memory:");
    try {
      const id = store.createSession({ model: "test-model", cwd: "/tmp" });
      const turns: Message[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi there" }] },
        { role: "user", content: [{ type: "text", text: "how are you?" }] },
      ];
      for (const turn of turns) {
        store.appendTurn(id, turn);
      }

      const messages = store.loadMessages(id);

      expect(messages).toEqual(turns);
    } finally {
      store.close();
    }
  });
});
