// image.ts — turn image files into base64 content for vision-capable models.
//
// Two ingress paths feed this: image paths typed in a prompt (extractImagePaths)
// and the read_file tool when it's pointed at an image. Both end up calling
// readImageFile, which yields the provider-agnostic `{ mediaType, data }` shape
// that becomes a ContentBlock of `type: "image"` (see provider.ts).

import { extname } from "node:path";

/** Base64 image payload, ready to drop into an `image` ContentBlock. */
export interface ImageData {
  /** IANA media type, e.g. "image/png". */
  mediaType: string;
  /** Raw base64 (no `data:` prefix). */
  data: string;
}

/** Extension → IANA media type for the image formats the vision models accept. */
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The media type for a path by its extension, or null if it isn't an image. */
export function mediaTypeForPath(path: string): string | null {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? null;
}

/** Whether a path names an image file we can encode. */
export function isImagePath(path: string): boolean {
  return mediaTypeForPath(path) !== null;
}

// A whitespace-delimited token that ends in an image extension, with an optional
// leading `@` (the mention form) and optional surrounding quotes.
const IMAGE_TOKEN_RE = /@?["']?(\S+?\.(?:png|jpe?g|gif|webp))["']?/gi;

/**
 * Pull image file paths out of a typed prompt — both bare (`./a.png`) and
 * `@`-mentioned (`@shot.png`). Order-preserving and deduplicated; trailing
 * punctuation like a `?` is excluded because it can't be part of the extension.
 */
export function extractImagePaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(IMAGE_TOKEN_RE)) {
    const path = m[1]!;
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Read an image file and base64-encode it. Throws if the path isn't a known image
 * type or the file is missing — callers surface that to the user/model rather than
 * sending garbage.
 */
export async function readImageFile(path: string): Promise<ImageData> {
  const mediaType = mediaTypeForPath(path);
  if (!mediaType) throw new Error(`not a supported image file: ${path}`);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`no such file: ${path}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { mediaType, data: Buffer.from(bytes).toString("base64") };
}
