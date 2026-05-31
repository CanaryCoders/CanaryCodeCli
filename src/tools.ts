// tools.ts — the agent's whole tool set in one place.
//
// Each tool is `{ name, description, schema, readOnly, run(input) }`. `run` returns
// the string that becomes the tool_result content; it throws on failure and the
// agent loop turns that into an `is_error` result. The `readOnly` flag is the
// single thing plan mode filters on: read_file/list_dir/grep are safe, the rest
// mutate the world. One file, one array — `tools`.

import { resolve, relative, sep } from "node:path";
import { readdir } from "node:fs/promises";

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  schema: Record<string, unknown>;
  /** True if the tool cannot mutate anything — the gate for plan mode. */
  readOnly: boolean;
  run(input: Record<string, any>): Promise<string>;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Pull a required string field or throw a clear, model-readable error. */
function reqStr(input: Record<string, any>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return v;
}

// ── read_file ─────────────────────────────────────────────────────────────────

const readFile: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file. Optionally start at a 1-based line `offset` and cap the number of lines with `limit`. Returns the file contents.",
  readOnly: true,
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)." },
      offset: { type: "number", description: "1-based line to start from (optional)." },
      limit: { type: "number", description: "Max number of lines to return (optional)." },
    },
    required: ["path"],
  },
  async run(input) {
    const path = reqStr(input, "path");
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`no such file: ${path}`);
    const text = await file.text();
    const hasWindow = typeof input.offset === "number" || typeof input.limit === "number";
    if (!hasWindow) return text;
    const lines = text.split("\n");
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const end = typeof input.limit === "number" ? start + input.limit : lines.length;
    return lines.slice(start, end).join("\n");
  },
};

// ── write_file ────────────────────────────────────────────────────────────────

const writeFile: Tool = {
  name: "write_file",
  description:
    "Write `content` to `path`, overwriting any existing file and creating parent directories as needed.",
  readOnly: false,
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  async run(input) {
    const path = reqStr(input, "path");
    const content = typeof input.content === "string" ? input.content : "";
    await Bun.write(path, content);
    return `wrote ${content.length} bytes to ${path}`;
  },
};

// ── edit_file ─────────────────────────────────────────────────────────────────

const editFile: Tool = {
  name: "edit_file",
  description:
    "Replace an exact `old` string with `new` in a file. `old` must appear exactly once unless `replace_all` is true. Fails if `old` is not found.",
  readOnly: false,
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit." },
      old: { type: "string", description: "Exact text to find. Include enough context to be unique." },
      new: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old", "new"],
  },
  async run(input) {
    const path = reqStr(input, "path");
    const oldStr = reqStr(input, "old");
    const newStr = typeof input.new === "string" ? input.new : "";
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`no such file: ${path}`);
    const text = await file.text();

    if (input.replace_all) {
      if (!text.includes(oldStr)) throw new Error(`"old" string not found in ${path}`);
      const count = text.split(oldStr).length - 1;
      await Bun.write(path, text.split(oldStr).join(newStr));
      return `replaced ${count} occurrence(s) in ${path}`;
    }

    const first = text.indexOf(oldStr);
    if (first === -1) throw new Error(`"old" string not found in ${path}`);
    if (text.indexOf(oldStr, first + oldStr.length) !== -1) {
      throw new Error(`"old" string is not unique in ${path}; add more context or set replace_all`);
    }
    await Bun.write(path, text.slice(0, first) + newStr + text.slice(first + oldStr.length));
    return `edited ${path}`;
  },
};

// ── list_dir ──────────────────────────────────────────────────────────────────

const listDir: Tool = {
  name: "list_dir",
  description: "List the entries of a directory (defaults to cwd). Directories are suffixed with `/`.",
  readOnly: true,
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (default: current directory)." },
    },
  },
  async run(input) {
    const path = typeof input.path === "string" && input.path ? input.path : ".";
    const entries = await readdir(path, { withFileTypes: true }).catch((e: Error) => {
      throw new Error(`cannot list ${path}: ${e.message}`);
    });
    if (entries.length === 0) return `(empty) ${path}`;
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};

// ── bash ──────────────────────────────────────────────────────────────────────

const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command via `bash -c` and return combined stdout+stderr. Times out (default 30s). Use for builds, tests, git, etc.",
  readOnly: false,
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout: { type: "number", description: "Timeout in milliseconds (default 30000)." },
    },
    required: ["command"],
  },
  async run(input) {
    const command = reqStr(input, "command");
    const timeoutMs = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : 30_000;
    const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);

    const out = [stdout, stderr].filter((s) => s.length > 0).join("");
    if (timedOut) {
      throw new Error(`command timed out after ${timeoutMs}ms${out ? `\n${out}` : ""}`);
    }
    const trimmed = out.length ? out : "(no output)";
    return code === 0 ? trimmed : `[exit ${code}]\n${trimmed}`;
  },
};

// ── grep ──────────────────────────────────────────────────────────────────────

/** Recursive JS fallback for grep when `rg` is unavailable. */
async function jsGrep(pattern: string, root: string): Promise<string> {
  const re = new RegExp(pattern);
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", ".cache"]);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = `${dir}${sep}${e.name}`;
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        let text: string;
        try {
          text = await Bun.file(full).text();
        } catch {
          continue; // binary / unreadable
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            const rel = relative(root, full) || full;
            out.push(`${rel}:${i + 1}:${lines[i]}`);
            if (out.length >= 200) return;
          }
        }
      }
      if (out.length >= 200) return;
    }
  }

  await walk(root);
  return out.length ? out.join("\n") : "(no matches)";
}

const grep: Tool = {
  name: "grep",
  description:
    "Search file contents for a regex `pattern`. Uses ripgrep (`rg`) when available, falling back to a built-in scan. Returns `file:line:text` matches.",
  readOnly: true,
  schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory or file to search (default: cwd)." },
      glob: { type: "string", description: "Optional glob filter, e.g. '*.ts' (rg only)." },
    },
    required: ["pattern"],
  },
  async run(input) {
    const pattern = reqStr(input, "pattern");
    const path = typeof input.path === "string" && input.path ? input.path : ".";
    const args = ["rg", "--line-number", "--no-heading", "--color", "never", "--max-count", "200"];
    if (typeof input.glob === "string" && input.glob) args.push("--glob", input.glob);
    args.push(pattern, path);

    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (code === 0) return stdout.length ? stdout.trimEnd() : "(no matches)";
      if (code === 1) return "(no matches)"; // rg: no matches found
      // code 2 (or 127 if missing) → fall through to JS
      if (code !== 2 && stderr) {
        // genuine rg error other than "not found"
        if (!/command not found|No such file/i.test(stderr)) throw new Error(stderr.trim());
      }
    } catch {
      // rg not installed — fall back below
    }
    return jsGrep(pattern, resolve(path));
  },
};

// ── registry ──────────────────────────────────────────────────────────────────

/** The full tool set, in a stable order. */
export const tools: Tool[] = [readFile, writeFile, editFile, listDir, bash, grep];

/** Look up a tool by name. */
export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Tools visible in the current mode. Plan mode (readOnly) exposes only read-only
 * tools; normal mode exposes everything.
 */
export function toolsForMode(readOnlyOnly: boolean): Tool[] {
  return readOnlyOnly ? tools.filter((t) => t.readOnly) : tools;
}
