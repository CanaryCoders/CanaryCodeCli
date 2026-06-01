// update.ts — self-update for compiled release binaries.
//
// Two paths:
//   • Background notice. `cachedUpdateNotice()` does a synchronous read of the
//     ~/.cc/update-check.json cache and returns a one-line banner string when a
//     newer version was seen on a prior run. `refreshUpdateCache()` is the
//     fire-and-forget network refresh (throttled to once/24h) that populates that
//     cache for the next launch. Startup never blocks on the network.
//   • Manual apply. `applyUpdate()` force-checks the GitHub "latest release" API,
//     downloads the matching binary, verifies its sha256 against the release
//     checksums, and atomically swaps it over the running executable.
//
// Everything is hard-gated by `updateDisabledReason()`: source runs, Nix installs
// (CC_DISABLE_UPDATE=1 or a /nix/store path), non-writable install dirs, and
// `autoUpdate.enabled: false` all return a reason and short-circuit.

import { accessSync, chmodSync, constants as fsConstants } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Config } from "./config.ts";
import { IS_RELEASE_BUILD, VERSION } from "./version.ts";

/** GitHub repo that hosts releases. */
const REPO = "CanaryCoders/CanaryCodeCli";
/** Re-check the network at most this often (24h, in ms). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Network timeout for GitHub requests (ms). */
const NET_TIMEOUT_MS = 5000;

interface UpdateCache {
  /** Epoch ms of the last successful network check. */
  checkedAt: number;
  /** Latest release version seen (no leading "v"), or "" if unknown. */
  latest: string;
}

function cachePath(): string {
  return join(homedir(), ".cc", "update-check.json");
}

/** Asset name for the running platform, e.g. "cc-darwin-arm64". */
function assetName(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `cc-${os}-${arch}`;
}

/** Strip a leading "v" and compare two semver-ish strings. >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Why self-update is unavailable, or null when it's allowed. Checked before any
 * network or filesystem mutation so the caller can show a precise message.
 */
export function updateDisabledReason(config: Config): string | null {
  if (process.env.CC_DISABLE_UPDATE === "1")
    return "disabled via CC_DISABLE_UPDATE";
  if (!IS_RELEASE_BUILD)
    return "not a release build (running from source — use git to update)";
  if (config.autoUpdate.enabled === false)
    return "disabled via config (autoUpdate.enabled)";
  const bin = process.execPath;
  if (bin.startsWith("/nix/store"))
    return "managed by Nix (update your flake input instead)";
  try {
    accessSync(dirname(bin), fsConstants.W_OK);
  } catch {
    return `install directory is not writable (${dirname(bin)})`;
  }
  return null;
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latest === "string"
    )
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
  } catch {
    // Missing or malformed cache is fine — treat as "never checked".
  }
  return null;
}

async function writeCache(cache: UpdateCache): Promise<void> {
  try {
    await writeFile(cachePath(), JSON.stringify(cache), "utf8");
  } catch {
    // A failed cache write is non-fatal; we just re-check sooner next time.
  }
}

interface GithubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function fetchLatestRelease(): Promise<GithubRelease | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "cc-cli",
        },
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as GithubRelease;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synchronous banner string when the cache (from a previous run) shows a newer
 * version. Returns null when updates are disabled, the cache is empty, or we are
 * already current. Reads the cache file synchronously so the startup banner can
 * use it without awaiting the network.
 */
export async function cachedUpdateNotice(
  config: Config,
): Promise<string | null> {
  if (updateDisabledReason(config)) return null;
  const cache = await readCache();
  if (!cache?.latest) return null;
  if (compareVersions(cache.latest, VERSION) <= 0) return null;
  return `↑ cc ${cache.latest} available (you have ${VERSION}) — run /update`;
}

/**
 * Fire-and-forget background refresh: if the throttle window has elapsed and
 * updates are enabled, fetch the latest release and update the cache for the next
 * launch. Never throws; safe to call without awaiting.
 */
export async function refreshUpdateCache(config: Config): Promise<void> {
  if (updateDisabledReason(config)) return;
  const cache = await readCache();
  if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return;
  const release = await fetchLatestRelease();
  if (!release) return;
  await writeCache({
    checkedAt: Date.now(),
    latest: release.tag_name.replace(/^v/, ""),
  });
}

/** Parse a `sha256  filename` checksums.txt into a name→hash map. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  version?: string;
}

/**
 * Download the latest release binary for this platform, verify its sha256 against
 * the release `checksums.txt`, and atomically replace the running executable.
 * Reports progress through `log`. Aborts (without touching the binary) on any
 * network, checksum, or filesystem error.
 */
export async function applyUpdate(
  config: Config,
  log: (msg: string) => void = () => {},
): Promise<ApplyResult> {
  const reason = updateDisabledReason(config);
  if (reason) return { ok: false, message: `update unavailable: ${reason}` };

  log("checking for the latest release…");
  const release = await fetchLatestRelease();
  if (!release)
    return { ok: false, message: "could not reach GitHub releases" };
  const latest = release.tag_name.replace(/^v/, "");
  if (compareVersions(latest, VERSION) <= 0)
    return { ok: true, message: `already up to date (cc ${VERSION})` };

  const name = assetName();
  const binAsset = release.assets.find((a) => a.name === name);
  const sumAsset = release.assets.find((a) => a.name === "checksums.txt");
  if (!binAsset)
    return {
      ok: false,
      message: `no release asset for this platform (${name})`,
    };
  if (!sumAsset)
    return { ok: false, message: "release is missing checksums.txt" };

  log(`downloading cc ${latest} (${name})…`);
  const [binRes, sumRes] = await Promise.all([
    fetch(binAsset.browser_download_url, {
      headers: { "User-Agent": "cc-cli" },
    }),
    fetch(sumAsset.browser_download_url, {
      headers: { "User-Agent": "cc-cli" },
    }),
  ]);
  if (!binRes.ok || !sumRes.ok)
    return { ok: false, message: "download failed" };

  const bytes = new Uint8Array(await binRes.arrayBuffer());
  const checksums = parseChecksums(await sumRes.text());
  const expected = checksums.get(name);
  if (!expected)
    return { ok: false, message: `checksums.txt has no entry for ${name}` };

  log("verifying checksum…");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const actual = hasher.digest("hex");
  if (actual !== expected)
    return {
      ok: false,
      message: `checksum mismatch — refusing to install (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    };

  const target = process.execPath;
  const tmp = join(dirname(target), `.cc.update.${process.pid}`);
  try {
    await writeFile(tmp, bytes);
    chmodSync(tmp, 0o755);
    // rename over a running executable is safe on macOS/Linux: the open inode
    // survives until the process exits, and new launches pick up the new file.
    await rename(tmp, target);
  } catch (err) {
    return {
      ok: false,
      message: `could not replace the binary: ${(err as Error).message}`,
    };
  }

  await writeCache({ checkedAt: Date.now(), latest });
  return {
    ok: true,
    version: latest,
    message: `updated to cc ${latest} — restart cc to use it`,
  };
}
