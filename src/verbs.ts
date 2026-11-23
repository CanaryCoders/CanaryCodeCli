// verbs.ts: what the busy row says while a tool runs.
//
// The row names the tool in plain words and is followed by the call's target
// (the command, path or task), so it always answers "what is it doing now".

/** Tool → what it is doing, shown while that tool runs. */
export const TOOL_VERB: Record<string, string> = {
  bash: "Running",
  web_fetch: "Fetching",
  github_read_file: "Reading from GitHub",
  web_search: "Searching the web",
  grep: "Searching files",
  read_file: "Reading",
  list_dir: "Listing",
  read_skill: "Loading skill",
  write_file: "Writing",
  edit_file: "Editing",
  spawn_agent: "Sub-agent working",
};
