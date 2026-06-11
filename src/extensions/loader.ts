// loader.ts — discover and load user extensions from config directories.
//
// Two sources: ~/.cc/extensions/*.{ts,js} (the user put it there — implicitly
// trusted) and ./.cc/extensions/*.{ts,js} (arrives with a repo — approved on
// first load, tracked by content hash in ~/.cc/trusted-extensions.json, so a
// fresh clone never executes code silently). An extension's NAME is its
// filename stem, which makes `extensions.<name>: false` decidable BEFORE
// import — a disabled extension is never even imported; a stub keeps it
// visible in /extensions so it can be re-enabled. Every failure (untrusted,
// collision, bad shape, import error) skips that one file with a note; a user
// extension can never crash cc. Bun's module cache means a CHANGED file is
// re-trust-checked but not re-executed in-process — edits take effect on the
// next launch.

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { RESERVED_COMMAND_NAMES } from "../commands.ts";
import type { Config } from "../config.ts";
import type { Extension } from "../extension.ts";
import { BUILTIN_EXTENSIONS } from "./registry.ts";

export interface LoadUserExtensionsOpts {
  /** Status note for skips/errors (stderr in headless, scrollback in TUI). */
  note(text: string): void;
  /** Approve an untrusted project extension. Absent (headless) → skipped. */
  confirm?(info: { name: string; path: string }): Promise<boolean>;
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

async function writeTrust(
  path: string,
  store: Record<string, string>,
): Promise<void> {
  try {
    await Bun.write(path, `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    // Best-effort; worst case the user is re-prompted next launch.
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
  const e = ext as Partial<Extension>;
  if (typeof e.description !== "string")
    return { ok: false, reason: "missing string `description`" };
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
      dir: opts.userDir ?? join(homedir(), ".cc", "extensions"),
      trusted: true,
    },
    {
      dir: opts.projectDir ?? join(process.cwd(), ".cc", "extensions"),
      trusted: false,
    },
  ];
  const trustFile =
    opts.trustFile ?? join(homedir(), ".cc", "trusted-extensions.json");

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
      if (!trusted) {
        trust ??= await readTrust(trustFile);
        const hash = sha256(await Bun.file(path).text());
        if (trust[path] !== hash) {
          const approved = opts.confirm
            ? await opts.confirm({ name, path })
            : false;
          if (!approved) {
            opts.note(
              opts.confirm
                ? `note: project extension "${name}" not approved — skipped`
                : `note: project extension "${name}" (${path}) is not approved — launch cc interactively once to approve it`,
            );
            continue;
          }
          trust[path] = hash;
          await writeTrust(trustFile, trust);
        }
      }
      try {
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
        opts.note(
          `note: extension "${name}" (${path}) failed to load — ${(err as Error).message}`,
        );
      }
    }
  }
  return out;
}
