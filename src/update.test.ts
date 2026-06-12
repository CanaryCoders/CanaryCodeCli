// update.test.ts — pure helpers behind the self-updater.

import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import {
  compareVersions,
  extractChangelog,
  parseChecksums,
  updateDisabledReason,
} from "./update.ts";

describe("compareVersions", () => {
  test("orders by major/minor/patch", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  test("ignores a leading v and tolerates short versions", () => {
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("v1.3", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1", "1.0.0")).toBe(0);
  });
});

describe("parseChecksums", () => {
  test("maps filename to hash, ignoring junk lines and the optional binary star", () => {
    const hash = "a".repeat(64);
    const other = "b".repeat(64);
    const text = `${hash}  cc-darwin-arm64\n${other} *cc-linux-x64\n\n# comment\n`;
    const map = parseChecksums(text);
    expect(map.get("cc-darwin-arm64")).toBe(hash);
    expect(map.get("cc-linux-x64")).toBe(other);
    expect(map.size).toBe(2);
  });
});

describe("extractChangelog", () => {
  const changelog = [
    "# Changelog",
    "",
    "Intro prose that is not a release section.",
    "",
    "## 0.2.0 - 2026-07-01",
    "",
    "### Added",
    "- second thing",
    "",
    "## 0.1.0 - 2026-06-12",
    "",
    "First public release.",
    "- first thing",
    "",
  ].join("\n");

  test("returns one version's section, stopping at the next heading", () => {
    expect(extractChangelog(changelog, "0.2.0")).toBe(
      "### Added\n- second thing",
    );
    expect(extractChangelog(changelog, "0.1.0")).toBe(
      "First public release.\n- first thing",
    );
  });

  test("tolerates a leading v and bracketed headings", () => {
    expect(extractChangelog(changelog, "v0.2.0")).toBe(
      "### Added\n- second thing",
    );
    expect(extractChangelog("## [0.3.0] - 2026-08-01\nbody\n", "0.3.0")).toBe(
      "body",
    );
  });

  test("returns null for unknown versions and empty sections", () => {
    expect(extractChangelog(changelog, "9.9.9")).toBeNull();
    expect(
      extractChangelog("## 0.4.0\n\n## 0.3.0\nbody\n", "0.4.0"),
    ).toBeNull();
  });
});

describe("updateDisabledReason", () => {
  test("refuses to self-update from a source/dev run", async () => {
    // The test runner is `bun`, not a compiled release binary, so there is no
    // injected BUILD_VERSION and updates must be disabled.
    const config = await loadConfig("/nonexistent/cc-config.json");
    expect(updateDisabledReason(config)).toBe(
      "not a release build (running from source — use git to update)",
    );
  });
});
