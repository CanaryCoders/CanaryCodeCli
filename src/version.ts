// version.ts — single source of truth for the app version + build provenance.
//
// A real release binary is produced with `bun build --compile --define
// BUILD_VERSION='"<tag>"'`, which replaces the bareword `BUILD_VERSION` with the
// tag string at compile time. Running from source (`bun run src/index.ts`) leaves
// it undefined, so we fall back to package.json's version and mark the run as a
// non-release build. The auto-updater keys off `IS_RELEASE_BUILD`: source runs
// never try to replace themselves.

import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const BUILD_VERSION: string | undefined;

/** The injected tag version, or undefined when running from source. */
function injectedVersion(): string | undefined {
  // typeof on an undeclared global is safe; the bareword in the truthy branch is
  // only evaluated once the define has replaced it with a string literal.
  return typeof BUILD_VERSION === "string" ? BUILD_VERSION : undefined;
}

/** package.json version, read at runtime — only used for source/dev runs. */
function devVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** True when this is a compiled release binary (a tag version was injected). */
export const IS_RELEASE_BUILD = injectedVersion() !== undefined;

/** App version, shown by `--version` and the TUI launch banner. */
export const VERSION = injectedVersion() ?? devVersion();
