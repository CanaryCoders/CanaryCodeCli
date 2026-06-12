// loader.ts — discover and load user extensions from config directories.
//
// Two sources: ~/.canarycode/extensions/*.{ts,js} (the user put it there — implicitly
// trusted) and ./.canarycode/extensions/*.{ts,js} (arrives with a repo — approved on
// first load, tracked by content hash in ~/.canarycode/trusted-extensions.json, so a
// fresh clone never executes code silently). An extension's NAME is its
// filename stem, which makes `extensions.<name>: false` decidable BEFORE
// import — a disabled extension is never even imported; a stub keeps it
// visible in /extensions so it can be re-enabled. Every failure (untrusted,
// collision, bad shape, import error) skips that one file with a note; a user
// extension can never crash canarycode. Bun's module cache means a CHANGED file is
// re-trust-checked but not re-executed in-process — edits take effect on the
// next launch.

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { RESERVED_COMMAND_NAMES } from "../commands.ts";
import type { Config } from "../config.ts";
import type { Extension } from "../extension.ts";
import { errorMessage } from "../extension.ts";
import { BUILTIN_EXTENSIONS } from "./registry.ts";

export interface LoadUserExtensionsOpts {
  /** Status note for skips/errors (stderr in headless, scrollback in TUI). */
  note(text: string): void;
  /** Approve an untrusted project extension. Absent (headless) → skipped.
   * `changed` is true when a previous approval exists for this path (the
   * content changed since), false for a first-ever approval. */
  confirm?(info: {
    name: string;
    path: string;
    changed: boolean;
  }): Promise<boolean>;
  /** Overrides for tests. */
  userDir?: string;
  projectDir?: string;
  trustFile?: string;
}

async function readTrust(path: string): Promise<Record<string, string>> {
  try {
    const parsed = (await Bun.file(path).json()) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, string>;
  } catch {
    // Missing or corrupt store degrades to "nothing trusted" — we re-prompt.
  }
  return {};
}

/** Persist the trust store. Returns false on failure so the caller can warn
 * (a silently unwritable ~/.canarycode means eternal unexplained re-prompting). */
async function writeTrust(
  path: string,
  store: Record<string, string>,
): Promise<boolean> {
  try {
    await Bun.write(path, `${JSON.stringify(store, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function listExtensionFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // no such directory — nothing to load
  }
  return entries
    .filter((f) => [".ts", ".js"].includes(extname(f)))
    .sort()
    .map((f) => join(dir, f));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Shape-check a dynamically imported module's default export. */
function validate(
  mod: unknown,
): { ok: true; ext: Extension } | { ok: false; reason: string } {
  const ext = (mod as { default?: unknown })?.default;
  if (ext === null || typeof ext !== "object")
    return { ok: false, reason: "default export is not an object" };
  const e = ext as Record<string, unknown>;
  if (typeof e.description !== "string")
    return { ok: false, reason: "missing string `description`" };
  // Wrong-typed capabilities would crash LATER (assembly/dispatch), outside
  // the loader's try/catch — reject them here with a precise reason.
  for (const key of ["startup", "session", "providerPresets"] as const) {
    if (e[key] !== undefined && typeof e[key] !== "function")
      return { ok: false, reason: `\`${key}\` is not a function` };
  }
  if (e.commands !== undefined) {
    if (!Array.isArray(e.commands))
      return { ok: false, reason: "`commands` is not an array" };
    for (const [i, c] of (e.commands as unknown[]).entries()) {
      const cmd = c as Record<string, unknown> | null;
      if (cmd === null || typeof cmd !== "object")
        return { ok: false, reason: `\`commands[${i}]\` is not an object` };
      if (typeof cmd.name !== "string")
        return {
          ok: false,
          reason: `\`commands[${i}]\` is missing a string name`,
        };
      if (typeof cmd.run !== "function")
        return {
          ok: false,
          reason: `\`commands[${i}]\` is missing a run() function`,
        };
    }
  }
  if (!e.startup && !e.commands && !e.session && !e.providerPresets) {
    return {
      ok: false,
      reason: "no capabilities (startup/commands/session/providerPresets)",
    };
  }
  return { ok: true, ext: ext as Extension };
}

/**
 * Discover and import user extensions. Returns the loaded Extension list
 * (including inert stubs for disabled files); the caller hands it to
 * registry.setUserExtensions. Never throws for a bad extension file.
 */
export async function loadUserExtensions(
  config: Config,
  opts: LoadUserExtensionsOpts,
): Promise<Extension[]> {
  const sources = [
    {
      dir: opts.userDir ?? join(homedir(), ".canarycode", "extensions"),
      trusted: true,
    },
    {
      dir: opts.projectDir ?? join(process.cwd(), ".canarycode", "extensions"),
      trusted: false,
    },
  ];
  const trustFile =
    opts.trustFile ?? join(homedir(), ".canarycode", "trusted-extensions.json");

  const out: Extension[] = [];
  // User dir loads first; on a name collision the user-global file wins.
  const taken = new Set(BUILTIN_EXTENSIONS.map((e) => e.name));
  let trust: Record<string, string> | undefined;

  for (const { dir, trusted } of sources) {
    for (const path of await listExtensionFiles(dir)) {
      const name = basename(path, extname(path));
      if (taken.has(name)) {
        opts.note(
          `note: extension "${name}" (${path}) skipped — name already taken`,
        );
        continue;
      }
      // Disabled by config → never imported (the stem IS the name, so this is
      // decidable without executing any extension code). The stub keeps it
      // listed in /extensions so it can be re-enabled.
      if (config.extensions[name] === false) {
        taken.add(name);
        out.push({
          name,
          description: "user extension (disabled — not loaded)",
        });
        continue;
      }
      // Everything that touches the disk or runs extension code lives in ONE
      // try/catch: a directory named `foo.ts`, an unreadable file, or a module
      // that throws can each skip only its own file, never crash the loader.
      try {
        if (!trusted) {
          trust ??= await readTrust(trustFile);
          const hash = sha256(await Bun.file(path).text());
          if (trust[path] !== hash) {
            const changed = trust[path] !== undefined;
            const approved = opts.confirm
              ? await opts.confirm({ name, path, changed })
              : false;
            if (!approved) {
              opts.note(
                opts.confirm
                  ? `note: project extension "${name}" not approved — skipped`
                  : `note: project extension "${name}" (${path}) is not approved — restart canarycode to approve it`,
              );
              continue;
            }
            // The confirm prompt blocks unbounded — re-read and re-hash so we
            // persist (and import) what's on disk NOW, not what was shown
            // before the wait. The remaining gap between this hash and
            // import()'s own disk read is irreducible without import-from-
            // string (which would break the extension's relative imports);
            // accepted for the local-attacker model.
            trust[path] = sha256(await Bun.file(path).text());
            if (!(await writeTrust(trustFile, trust))) {
              opts.note(
                "note: could not persist extension approval — you may be re-prompted next launch",
              );
            }
          }
        }
        const checked = validate((await import(path)) as unknown);
        if (!checked.ok) {
          opts.note(
            `note: extension "${name}" (${path}) skipped — ${checked.reason}`,
          );
          continue;
        }
        taken.add(name);
        // Reserved base command words win over extension commands.
        const commands = checked.ext.commands?.filter((c) => {
          if (RESERVED_COMMAND_NAMES.has(c.name)) {
            opts.note(
              `note: extension "${name}" command "/${c.name}" shadows a built-in command — ignored`,
            );
            return false;
          }
          return true;
        });
        // The filename stem IS the name: a declared `name` is overridden so
        // the config toggle, the file, and the registry can never disagree.
        out.push({ ...checked.ext, name, commands });
      } catch (err) {
        // Backstop for unexpected I/O and import errors (the specific
        // untrusted/denied/invalid-shape cases note-and-continue above).
        opts.note(
          `note: extension "${name}" (${path}) failed to load — ${errorMessage(err)}`,
        );
      }
    }
  }
  return out;
}
