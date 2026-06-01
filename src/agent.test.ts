// agent.test.ts — mode-to-role mapping.

import { describe, expect, test } from "bun:test";
import { roleForMode } from "./agent.ts";

describe("roleForMode", () => {
  test("plan maps to reasoning", () => {
    expect(roleForMode("plan")).toBe("reasoning");
  });

  test("normal and auto map to coding", () => {
    expect(roleForMode("normal")).toBe("coding");
    expect(roleForMode("auto")).toBe("coding");
  });
});
