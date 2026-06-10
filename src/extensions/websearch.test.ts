import { expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import { webSearchExtension } from "./websearch.ts";

test("webSearchExtension contributes web_search", async () => {
  const ext = webSearchExtension();
  const tools = await ext.tools?.({ config: defaultConfig() } as never);
  expect(tools?.map((t) => t.name)).toEqual(["web_search"]);
});
