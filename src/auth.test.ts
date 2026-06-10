// auth.test.ts — account-id extraction from the id_token JWT.

import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdFromIdToken, loadCredentials } from "./auth.ts";

/** Build a (signature-less, unverified) JWT carrying the given payload object. */
function jwt(payload: Record<string, unknown>): string {
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

describe("accountIdFromIdToken", () => {
  test("reads the OpenAI-namespaced claim", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    expect(accountIdFromIdToken(token)).toBe("acct_123");
  });

  test("falls back to a top-level chatgpt_account_id", () => {
    const token = jwt({ chatgpt_account_id: "acct_top" });
    expect(accountIdFromIdToken(token)).toBe("acct_top");
  });

  test("falls back to the first organization id", () => {
    const token = jwt({
      organizations: [{ id: "org_first" }, { id: "org_2" }],
    });
    expect(accountIdFromIdToken(token)).toBe("org_first");
  });

  test("prefers the namespaced claim over the fallbacks", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_ns" },
      chatgpt_account_id: "acct_top",
      organizations: [{ id: "org_first" }],
    });
    expect(accountIdFromIdToken(token)).toBe("acct_ns");
  });

  test("returns undefined for a malformed token", () => {
    expect(accountIdFromIdToken("not-a-jwt")).toBeUndefined();
    expect(accountIdFromIdToken("")).toBeUndefined();
  });

  test("returns undefined when no account claim is present", () => {
    expect(accountIdFromIdToken(jwt({ sub: "u1" }))).toBeUndefined();
  });
});

describe("loadCredentials", () => {
  test("a corrupt auth.json resolves undefined and warns instead of throwing", async () => {
    const tmpPath = join(tmpdir(), `cc-auth-corrupt-${Date.now()}.json`);
    await Bun.write(tmpPath, "{broken");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(loadCredentials(tmpPath)).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("corrupt");
    } finally {
      errSpy.mockRestore();
      await Bun.file(tmpPath).delete();
    }
  });
});
