// image.test.ts — path/media-type detection, prompt path extraction, file reading.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractImagePaths,
  isImagePath,
  mediaTypeForPath,
  readImageFile,
} from "./image.ts";

describe("mediaTypeForPath", () => {
  test("maps known image extensions (case-insensitive)", () => {
    expect(mediaTypeForPath("a.png")).toBe("image/png");
    expect(mediaTypeForPath("a.PNG")).toBe("image/png");
    expect(mediaTypeForPath("photo.jpg")).toBe("image/jpeg");
    expect(mediaTypeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(mediaTypeForPath("anim.gif")).toBe("image/gif");
    expect(mediaTypeForPath("x.webp")).toBe("image/webp");
  });

  test("returns null for non-image paths", () => {
    expect(mediaTypeForPath("notes.txt")).toBeNull();
    expect(mediaTypeForPath("src/index.ts")).toBeNull();
    expect(mediaTypeForPath("noext")).toBeNull();
  });
});

describe("isImagePath", () => {
  test("true only for image extensions", () => {
    expect(isImagePath("/abs/shot.png")).toBe(true);
    expect(isImagePath("main.rs")).toBe(false);
  });
});

describe("extractImagePaths", () => {
  test("finds bare and @-prefixed image paths in a prompt", () => {
    expect(extractImagePaths("what is in @shot.png?")).toEqual(["shot.png"]);
    expect(extractImagePaths("compare ./a.jpg and /tmp/b.webp")).toEqual([
      "./a.jpg",
      "/tmp/b.webp",
    ]);
  });

  test("ignores non-image tokens and dedupes", () => {
    expect(extractImagePaths("see index.ts and shot.png and shot.png")).toEqual(
      ["shot.png"],
    );
  });

  test("returns empty when there are no image paths", () => {
    expect(extractImagePaths("just a normal question")).toEqual([]);
  });
});

describe("readImageFile", () => {
  const path = join(tmpdir(), "cc-image-test.png");
  afterEach(async () => {
    await rm(path, { force: true });
  });

  test("reads a file and base64-encodes it with the right media type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "‰PNG" header bytes
    await Bun.write(path, bytes);
    const img = await readImageFile(path);
    expect(img.mediaType).toBe("image/png");
    expect(img.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("throws on a missing file", async () => {
    await expect(
      readImageFile(join(tmpdir(), "cc-nope.png")),
    ).rejects.toThrow();
  });

  test("throws on a non-image extension", async () => {
    await expect(readImageFile("notes.txt")).rejects.toThrow();
  });
});
