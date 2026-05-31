#!/usr/bin/env bun
// cc — a fast, minimal terminal coding agent.
// Entry point: arg parse + mode dispatch (headless vs TUI).
// Phase 1 scaffolding — real behavior is filled in by later tasks.

const args = process.argv.slice(2);

function printUsage(): void {
  console.log(
    [
      "cc — minimal AI coding CLI",
      "",
      "Usage:",
      '  cc -p "<prompt>"   headless print mode (not yet implemented)',
      "  cc                 interactive TUI (not yet implemented)",
      "",
      "Flags:",
      "  -h, --help         show this help",
      "  --version          show version",
    ].join("\n"),
  );
}

function main(): void {
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }
  if (args.includes("--version")) {
    console.log("cc 0.0.1");
    return;
  }
  printUsage();
}

main();
