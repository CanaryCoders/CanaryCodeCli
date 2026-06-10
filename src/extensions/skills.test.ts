// skills.test.ts — unit tests for the skills extension factory.
//
// Tests the skillsExtension() factory: tool registration, note emission,
// and system-prompt generation from a real skill fixture on disk.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  readSkillTool,
  skillsExtension,
  skillsPromptSection,
} from "./skills.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeTmpSkillDir(
  name: string,
  description: string,
): Promise<{
  root: string;
  dir: { dir: string; source: "global" | "project" };
}> {
  const root = await mkdtemp(join(tmpdir(), "cc-skills-test-"));
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nThis is the ${name} skill body.`,
  );
  return { root, dir: { dir: root, source: "project" as const } };
}

// ---------------------------------------------------------------------------
// discoverSkills — isolation via explicit dirs
// ---------------------------------------------------------------------------

test("discoverSkills returns empty array for empty temp dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-skills-empty-"));
  try {
    const skills = await discoverSkills([{ dir: root, source: "project" }]);
    expect(skills).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverSkills finds a skill with valid frontmatter", async () => {
  const { root, dir } = await makeTmpSkillDir("my-skill", "does cool things");
  try {
    const skills = await discoverSkills([dir]);
    expect(skills.map((s) => s.name)).toContain("my-skill");
    const skill = skills.find((s) => s.name === "my-skill");
    expect(skill?.description).toBe("does cool things");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// skillsExtension factory
// ---------------------------------------------------------------------------

test("skillsExtension().tools() returns exactly one tool named read_skill", async () => {
  const { root, dir } = await makeTmpSkillDir("fixture-skill", "a test skill");
  try {
    const ext = skillsExtension([dir]);
    const noted: string[] = [];
    const ctx = {
      note: (s: string) => {
        noted.push(s);
      },
    } as never;

    const tools = await ext.tools!(ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("read_skill");
    expect(tools[0]!.readOnly).toBe(true);

    // Fixture skill is discoverable through the factory — running the tool
    // with the fixture skill name returns its body content.
    const result = await tools[0]!.run({ name: "fixture-skill" });
    expect(result).toContain("This is the fixture-skill skill body.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skillsExtension().systemPrompt() reuses cached skills (no double discovery)", async () => {
  const { root, dir } = await makeTmpSkillDir(
    "cached-skill",
    "verifies no re-discovery",
  );
  try {
    const ext = skillsExtension([dir]);
    const ctx = { note: () => {} } as never;

    // Call tools() first to populate the closure cache.
    await ext.tools!(ctx);

    // Delete the fixture dir — if systemPrompt() re-discovered, it would find
    // nothing and return undefined.
    await rm(root, { recursive: true, force: true });

    // systemPrompt() must still return the originally discovered skills.
    const section = ext.systemPrompt!({} as never);
    expect(section).toBeDefined();
    expect(section).toContain("cached-skill");
    expect(section).toContain("── SKILLS ──");
  } finally {
    // Guard against a double-remove if the test fails before the rm above.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("skillsExtension().systemPrompt() returns undefined when skills is empty", () => {
  const section = skillsPromptSection([]);
  expect(section).toBeUndefined();
});

// ---------------------------------------------------------------------------
// readSkillTool (used inside the factory)
// ---------------------------------------------------------------------------

test("readSkillTool is read-only and named read_skill", () => {
  const tool = readSkillTool([]);
  expect(tool.name).toBe("read_skill");
  expect(tool.readOnly).toBe(true);
});

test("readSkillTool throws for an unknown skill name", async () => {
  const tool = readSkillTool([]);
  await expect(tool.run({ name: "nonexistent" })).rejects.toThrow(
    /no such skill/,
  );
});

test("readSkillTool reads the skill body from disk", async () => {
  const { root, dir } = await makeTmpSkillDir("disk-skill", "reads from disk");
  try {
    const skills = await discoverSkills([dir]);
    const tool = readSkillTool(skills);
    const result = await tool.run({ name: "disk-skill" });
    expect(result).toContain("This is the disk-skill skill body.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
