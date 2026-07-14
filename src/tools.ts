// tools.ts — the agent's whole tool set in one place.
//
// Each tool is `{ name, description, schema, readOnly, run(input) }`. `run` returns
// the string that becomes the tool_result content; it throws on failure and the
// agent loop turns that into an `is_error` result. The `readOnly` flag is the
// single thing plan mode filters on: read_file/list_dir/grep are safe, the rest
// mutate the world. One file, one array — `tools`.

import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { computeDiff, type Diff } from "./diff.ts";
import { type ImageData, isImagePath, readImageFile } from "./image.ts";
import { systemShell } from "./shell.ts";

/**
 * A tool's result. Tools may simply return the string that becomes the
 * tool_result content, or — for the file-mutating tools — a `{ content, diff }`
 * object so the front-ends can show a unified diff of what changed. The `diff`
 * is display-only: it never enters the tool_result the model sees (keeping token
 * cost down); the agent loop surfaces it on the `tool_end` event instead.
 */
export interface ToolRunResult {
  content: string;
  diff?: Diff;
  /**
   * A base64 image the tool produced (read_file on an image file). The agent loop
   * attaches it to the conversation as an `image` content block for vision-capable
   * models; `content` carries a short text marker that always accompanies it.
   */
  image?: ImageData;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  schema: Record<string, unknown>;
  /** True if the tool cannot mutate anything — the gate for plan mode. */
  readOnly: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: tool inputs are dynamic JSON bags read with typeof guards.
  run(input: Record<string, any>): Promise<string | ToolRunResult>;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Pull a required string field or throw a clear, model-readable error. */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON bag, narrowed below.
function reqStr(input: Record<string, any>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return v;
}

// ── read_file ─────────────────────────────────────────────────────────────────

// Default page size when the model reads a file without asking for a window.
// Mirrors Claude Code: never dump an unbounded file into context — that is what
// blows the model's context window on large files. The model can page past this
// with `offset`/`limit`.
const READ_FILE_DEFAULT_LIMIT = 2000;

/**
 * Render a window of lines as a numbered "view" — each line prefixed with its
 * 1-based file line number, right-aligned to a `tab`. This turns read_file into
 * a navigable viewer: the model always sees the real line numbers, so it can ask
 * for any window (e.g. `offset=2001`) and page through a file of any size. The
 * numbering is display-only — edit_file matches on the raw text, not the prefix.
 */
function numberLines(lines: string[], startLine: number): string {
  const lastNum = startLine + lines.length - 1;
  const width = String(lastNum).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`)
    .join("\n");
}

const readFile: Tool = {
  name: "read_file",
  description: `Read a UTF-8 text file. Lines are returned numbered (\`<line>\\t<text>\`). Returns up to ${READ_FILE_DEFAULT_LIMIT} lines by default; pass a 1-based \`offset\` to start at any line and \`limit\` to set the window size — so you can page through a file of any size. If the window is truncated you'll see a notice with the total line count and the next \`offset\` to continue from. Image files (png/jpg/jpeg/gif/webp) are returned as an image for vision-capable models instead of text.`,
  readOnly: true,
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute or relative to cwd).",
      },
      offset: {
        type: "number",
        description: "1-based line to start from (optional).",
      },
      limit: {
        type: "number",
        description: "Max number of lines to return (optional).",
      },
    },
    required: ["path"],
  },
  async run(input) {
    const path = reqStr(input, "path");
    // An image file can't be read as text — encode it to base64 and hand the agent
    // loop an `image` payload to attach for vision models (see ToolRunResult.image).
    if (isImagePath(path)) {
      const image = await readImageFile(path);
      return { content: `[image ${path} (${image.mediaType})]`, image };
    }
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`no such file: ${path}`);
    const text = await file.text();
    const lines = text.split("\n");
    const start = Math.max(0, (input.offset ?? 1) - 1);
    // Cap unbounded reads at a default page size so a huge file can't flood the
    // model's context window. An explicit `limit` overrides the default.
    const limit = input.limit ?? READ_FILE_DEFAULT_LIMIT;
    const end = start + limit;
    const window = lines.slice(start, end);
    const body = numberLines(window, start + 1);
    const shownEnd = start + window.length;
    const truncated = shownEnd < lines.length;
    if (!truncated) return body;
    const nextOffset = shownEnd + 1; // 1-based line to resume from
    return `${body}\n\n[truncated: showing lines ${start + 1}-${shownEnd} of ${lines.length}. Continue with offset=${nextOffset}.]`;
  },
};

// ── write_file ────────────────────────────────────────────────────────────────

const writeFile: Tool = {
  name: "write_file",
  description:
    "Write `content` to `path`, overwriting any existing file and creating parent directories as needed. Read the file first (read_file) if it already exists — never overwrite a file blind.",
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
    const file = Bun.file(path);
    // Capture prior contents for the diff (a brand-new file diffs against "").
    const old = (await file.exists()) ? await file.text() : "";
    await Bun.write(path, content);
    return {
      content: `wrote ${content.length} bytes to ${path}`,
      diff: computeDiff(old, content),
    };
  },
};

// ── edit_file ─────────────────────────────────────────────────────────────────

const editFile: Tool = {
  name: "edit_file",
  description:
    "Replace an exact `old` string with `new` in a file. Read the file first (read_file) so your `old` text matches exactly — but strip read_file's `<line>\\t` number prefix; `old` must match the raw file text, not the numbered view. `old` must appear exactly once unless `replace_all` is true. Fails if `old` is not found.",
  readOnly: false,
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit." },
      old: {
        type: "string",
        description: "Exact text to find. Include enough context to be unique.",
      },
      new: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence (default false).",
      },
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
      if (!text.includes(oldStr))
        throw new Error(`"old" string not found in ${path}`);
      const count = text.split(oldStr).length - 1;
      const updated = text.split(oldStr).join(newStr);
      await Bun.write(path, updated);
      return {
        content: `replaced ${count} occurrence(s) in ${path}`,
        diff: computeDiff(text, updated),
      };
    }

    const first = text.indexOf(oldStr);
    if (first === -1) throw new Error(`"old" string not found in ${path}`);
    if (text.indexOf(oldStr, first + oldStr.length) !== -1) {
      throw new Error(
        `"old" string is not unique in ${path}; add more context or set replace_all`,
      );
    }
    const updated =
      text.slice(0, first) + newStr + text.slice(first + oldStr.length);
    await Bun.write(path, updated);
    return { content: `edited ${path}`, diff: computeDiff(text, updated) };
  },
};

// ── list_dir ──────────────────────────────────────────────────────────────────

const listDir: Tool = {
  name: "list_dir",
  description:
    "List the entries of a directory (defaults to cwd). Directories are suffixed with `/`.",
  readOnly: true,
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list (default: current directory).",
      },
    },
  },
  async run(input) {
    const path =
      typeof input.path === "string" && input.path ? input.path : ".";
    const entries = await readdir(path, { withFileTypes: true }).catch(
      (e: Error) => {
        throw new Error(`cannot list ${path}: ${e.message}`);
      },
    );
    if (entries.length === 0) return `(empty) ${path}`;
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};

// Cap on tool output that flows back into the model's context. A command like
// `curl <html-page>` can emit tens of thousands of tokens in one shot and blow
// the context window; keep the head and tail (errors usually live at the end)
// and drop the middle with a notice.
const BASH_OUTPUT_LIMIT = 30_000;

function capOutput(text: string, limit = BASH_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n[... ${dropped} characters truncated ...]\n\n${tail}`;
}

// ── bash ──────────────────────────────────────────────────────────────────────

interface BackgroundShell {
  id: string;
  command: string;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: { text: string };
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  killed: boolean;
  reads: Promise<void>;
}

/** Session-owned process registry. Background shells survive tool calls and
 * turns, then are terminated when the assembled session is disposed. */
class BackgroundShells {
  private readonly shells = new Map<string, BackgroundShell>();
  private nextId = 1;

  start(command: string): BackgroundShell {
    const proc = Bun.spawn(systemShell().argv(command), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // A process group lets cleanup terminate a dev server's descendants too.
      detached: true,
    });
    const shell: BackgroundShell = {
      id: `shell_${this.nextId++}`,
      command,
      proc,
      output: { text: "" },
      startedAt: Date.now(),
      killed: false,
      reads: Promise.resolve(),
    };
    shell.reads = Promise.all([
      drainStream(proc.stdout, shell.output),
      drainStream(proc.stderr, shell.output),
    ]).then(() => {});
    this.shells.set(shell.id, shell);
    void proc.exited.then(async (code) => {
      shell.exitCode = code;
      shell.exitedAt = Date.now();
      await shell.reads;
    });
    return shell;
  }

  get(id: string): BackgroundShell {
    const shell = this.shells.get(id);
    if (!shell) throw new Error(`unknown background shell: ${id}`);
    return shell;
  }

  async kill(id: string): Promise<BackgroundShell> {
    const shell = this.get(id);
    if (shell.exitCode === undefined) {
      shell.killed = true;
      killProcessGroup(shell.proc);
      await Promise.race([
        shell.proc.exited,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (shell.exitCode === undefined) killProcessGroup(shell.proc, 9);
    }
    return shell;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.shells.values()]
        .filter((shell) => shell.exitCode === undefined)
        .map((shell) => this.kill(shell.id).catch(() => {})),
    );
  }
}

function killProcessGroup(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  signal?: number,
): void {
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {}
  }
}

function shellStatus(shell: BackgroundShell): string {
  if (shell.exitCode === undefined) return "running";
  if (shell.killed) return `killed (exit ${shell.exitCode})`;
  return `exited (code ${shell.exitCode})`;
}

function createShellTools(background: BackgroundShells): Tool[] {
  const bash: Tool = {
    name: "bash",
    // The shell is resolved per-system (bash → sh → cmd.exe; see shell.ts), so the
    // description names what the command will ACTUALLY run in.
    description: `Run a shell command via \`${systemShell().name} -c\` and return combined stdout+stderr. Times out (default 30s). Set \`run_in_background\` for long-lived processes such as dev servers; use \`bash_output\` to read their logs and status, and \`bash_kill\` to stop them.`,
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000).",
        },
        run_in_background: {
          type: "boolean",
          description:
            "Start the command in the background and return immediately with a shell ID.",
        },
      },
      required: ["command"],
    },
    async run(input) {
      const command = reqStr(input, "command");
      if (input.run_in_background === true) {
        const shell = background.start(command);
        // Yield once so commands that print immediately usually include their
        // startup line without delaying long-lived servers.
        await new Promise((resolve) => setTimeout(resolve, 25));
        const output = shell.output.text;
        return [
          `Background shell started: ${shell.id} (pid ${shell.proc.pid})`,
          `Status: ${shellStatus(shell)}`,
          output ? `Output:\n${capOutput(output)}` : "Output: (none yet)",
          `Use bash_output with shell_id "${shell.id}" to read logs.`,
        ].join("\n");
      }

      const timeoutMs =
        typeof input.timeout === "number" && input.timeout > 0
          ? input.timeout
          : 30_000;
      const proc = Bun.spawn(systemShell().argv(command), {
        stdout: "pipe",
        stderr: "pipe",
      });

      // Drain both pipes while the process runs; otherwise a full pipe can
      // deadlock it. Foreground output uses separate sinks to preserve the
      // historical stdout-then-stderr rendering contract.
      const out = { text: "" };
      const errOut = { text: "" };
      const reads = Promise.all([
        drainStream(proc.stdout, out),
        drainStream(proc.stderr, errOut),
      ]);

      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        killTimer = setTimeout(() => {
          try {
            proc.kill(9);
          } catch {}
        }, 2000);
      }, timeoutMs);

      const code = await proc.exited;
      await Promise.race([reads, new Promise((r) => setTimeout(r, 250))]);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      const combined = [out.text, errOut.text]
        .filter((s) => s.length > 0)
        .join("");
      if (timedOut) {
        throw new Error(
          `command timed out after ${timeoutMs}ms${combined ? `\n${combined}` : ""}`,
        );
      }
      const trimmed = capOutput(combined.length ? combined : "(no output)");
      return code === 0 ? trimmed : `[exit ${code}]\n${trimmed}`;
    },
  };

  const bashOutput: Tool = {
    name: "bash_output",
    description:
      "Read logs and status from a background shell started by bash. Pass offset to read only newer output; the response includes next_offset for polling.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "Background shell ID." },
        offset: {
          type: "number",
          description: "Character offset to start reading from (default 0).",
        },
        limit: {
          type: "number",
          description: "Maximum characters to return (default 30000).",
        },
      },
      required: ["shell_id"],
    },
    async run(input) {
      const shell = background.get(reqStr(input, "shell_id"));
      const offset =
        typeof input.offset === "number" && input.offset > 0
          ? Math.floor(input.offset)
          : 0;
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.floor(input.limit)
          : BASH_OUTPUT_LIMIT;
      const end = Math.min(shell.output.text.length, offset + limit);
      const output = shell.output.text.slice(offset, end);
      return [
        `Shell: ${shell.id}`,
        `Command: ${shell.command}`,
        `Status: ${shellStatus(shell)}`,
        `Output (${offset}-${end}, next_offset=${end}):`,
        output || "(no new output)",
      ].join("\n");
    },
  };

  const bashKill: Tool = {
    name: "bash_kill",
    description:
      "Stop a background shell and its child processes. Its captured logs remain available through bash_output.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "Background shell ID." },
      },
      required: ["shell_id"],
    },
    async run(input) {
      const shell = await background.kill(reqStr(input, "shell_id"));
      return `Shell ${shell.id}: ${shellStatus(shell)}`;
    },
  };

  return [bash, bashOutput, bashKill];
}

/** Append a stream's bytes to `sink.text` as they arrive (best-effort: a
 * stream error after a kill just stops the capture, never throws). */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  sink: { text: string },
): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      sink.text += decoder.decode(chunk, { stream: true });
    }
    sink.text += decoder.decode();
  } catch {
    // partial output already captured
  }
}

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
      pattern: {
        type: "string",
        description: "Regular expression to search for.",
      },
      path: {
        type: "string",
        description: "Directory or file to search (default: cwd).",
      },
      glob: {
        type: "string",
        description: "Optional glob filter, e.g. '*.ts' (rg only).",
      },
    },
    required: ["pattern"],
  },
  async run(input) {
    const pattern = reqStr(input, "pattern");
    const path =
      typeof input.path === "string" && input.path ? input.path : ".";
    const args = [
      "rg",
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      "200",
    ];
    if (typeof input.glob === "string" && input.glob)
      args.push("--glob", input.glob);
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
        if (!/command not found|No such file/i.test(stderr))
          throw new Error(stderr.trim());
      }
    } catch {
      // rg not installed — fall back below
    }
    return jsGrep(pattern, resolve(path));
  },
};

// ── registry ──────────────────────────────────────────────────────────────────

/** A fresh core tool set. Background shell state is deliberately per-session. */
export function createCoreTools(): {
  tools: Tool[];
  dispose(): Promise<void>;
} {
  const background = new BackgroundShells();
  return {
    tools: [
      readFile,
      writeFile,
      editFile,
      listDir,
      ...createShellTools(background),
      grep,
    ],
    dispose: () => background.dispose(),
  };
}

/** Default tool set retained for direct consumers and focused unit tests.
 * Sessions use createCoreTools() so their background processes are isolated. */
export const tools: Tool[] = createCoreTools().tools;
