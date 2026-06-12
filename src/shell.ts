// shell.ts — resolve the shell that runs `bash`-tool commands and lifecycle hooks.
//
// `bash -c` was previously hardcoded, which breaks on systems that don't ship
// bash in PATH (minimal containers, BSDs, Windows). A user's *login* shell
// (fish, nushell, …) is deliberately NOT a candidate: the model writes
// POSIX/bash syntax, and feeding that to fish produces confusing errors. So we
// resolve once per process: bash → sh, or cmd.exe on Windows. The resolved
// shell is surfaced to the model in the system prompt (see assemble.ts) so it
// writes syntax the actual shell understands.

export interface SystemShell {
  /** Executable path (e.g. /bin/bash) or bare name when resolution failed. */
  path: string;
  /** Short display name: "bash", "sh", "cmd". */
  name: string;
  /** Syntax family the model should write for. */
  flavor: "bash" | "posix-sh" | "cmd";
  /** Build the argv that runs `command` through this shell. */
  argv(command: string): string[];
}

let cached: SystemShell | null = null;

/** The shell `bash`-tool commands and hooks run in, resolved once per process. */
export function systemShell(): SystemShell {
  if (cached) return cached;
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    cached = {
      path: comspec,
      name: "cmd",
      flavor: "cmd",
      argv: (command) => [comspec, "/d", "/s", "/c", command],
    };
    return cached;
  }
  const bash = Bun.which("bash");
  // /bin/sh is the POSIX-guaranteed fallback; the bare "sh" path only happens
  // when even that probe fails, and lets spawn produce its own clear error.
  const path = bash ?? Bun.which("sh") ?? "/bin/sh";
  cached = {
    path,
    name: path.split("/").pop() ?? "sh",
    flavor: bash ? "bash" : "posix-sh",
    argv: (command) => [path, "-c", command],
  };
  return cached;
}

/** Reset the per-process cache (tests only). */
export function resetSystemShellForTests(): void {
  cached = null;
}

/**
 * The environment lines appended to the system prompt so the model knows what
 * it is running on — and, crucially, which shell its commands execute in. The
 * user's login shell may be fish/nushell/…; tool commands never run there, so
 * the model must not write for it (but should when handing the *user* a
 * command to paste).
 */
export function describeEnvironment(): string {
  const shell = systemShell();
  const lines = [
    "## Environment",
    `- OS: ${process.platform} (${process.arch})`,
    `- Working directory: ${process.cwd()}`,
    `- Today's date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  if (shell.flavor === "cmd") {
    lines.push(
      `- The \`bash\` tool runs commands via ${shell.name} (Windows cmd.exe, NOT a POSIX shell) — write cmd syntax.`,
    );
  } else if (shell.flavor === "posix-sh") {
    lines.push(
      `- The \`bash\` tool runs commands via \`${shell.path} -c\` (plain POSIX sh — bash is NOT installed). Avoid bashisms: no [[ ]], arrays, process substitution, or \`set -o pipefail\`.`,
    );
  } else {
    lines.push(`- The \`bash\` tool runs commands via \`${shell.path} -c\`.`);
  }
  const login = process.env.SHELL?.split("/").pop();
  if (login && login !== shell.name) {
    lines.push(
      `- The user's interactive shell is ${login}. Your tool commands do NOT run in it — keep writing ${shell.flavor === "cmd" ? "cmd" : "POSIX/bash"} syntax for tools, but use ${login} syntax when you suggest a command for the user to run themselves.`,
    );
  }
  return lines.join("\n");
}
