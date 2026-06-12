import { expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import {
  githubReadFileTool,
  webFetchTool,
  webSearchExtension,
} from "./websearch.ts";

test("webSearchExtension contributes web tools", async () => {
  const ext = webSearchExtension();
  const tools = await ext.tools?.({ config: defaultConfig() } as never);
  expect(tools?.map((t) => t.name)).toEqual([
    "web_fetch",
    "github_read_file",
    "web_search",
  ]);
  expect(tools?.every((t) => t.readOnly)).toBe(true);
});

test("webSearchExtension tells models to fetch direct URLs before search", () => {
  const ext = webSearchExtension();
  const section = ext.systemPrompt?.({} as never);
  expect(section).toContain("direct URL");
  expect(section).toContain("web_fetch");
  expect(section).toContain("github_read_file");
});

test("web_fetch returns direct text content", async () => {
  const tool = webFetchTool(
    (async (_url: string) =>
      new Response("hello from docs", {
        headers: { "content-type": "text/plain" },
        status: 200,
        statusText: "OK",
      })) as never,
  );
  const out = await tool.run({ url: "https://example.com/docs" });
  expect(typeof out === "string" ? out : out.content).toContain(
    "hello from docs",
  );
});

test("web_fetch extracts readable text from HTML", async () => {
  const tool = webFetchTool(
    (async () =>
      new Response(
        "<html><head><title>Docs</title></head><body><h1>Hello</h1><script>bad()</script><p>World</p></body></html>",
        { headers: { "content-type": "text/html" } },
      )) as never,
  );
  const out = await tool.run({ url: "https://example.com" });
  const text = typeof out === "string" ? out : out.content;
  expect(text).toContain("Docs");
  expect(text).toContain("Hello");
  expect(text).toContain("World");
  expect(text).not.toContain("bad()");
});

test("github_read_file reads README from a GitHub repo URL", async () => {
  const seen: string[] = [];
  const tool = githubReadFileTool((async (url: string) => {
    seen.push(url);
    return new Response("# OpenTUI", {
      headers: { "content-type": "text/plain" },
    });
  }) as never);
  const out = await tool.run({
    repo_url: "https://github.com/anomalyco/opentui",
  });
  const text = typeof out === "string" ? out : out.content;
  expect(seen[0]).toBe(
    "https://raw.githubusercontent.com/anomalyco/opentui/HEAD/README.md",
  );
  expect(text).toContain("# OpenTUI");
});
