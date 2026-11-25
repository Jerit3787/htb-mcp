import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { HtbClient } from "./client.js";
import { HtbError } from "./errors.js";

export type DownloadProduct = "challenges" | "sherlocks";

export interface DownloadTarget {
  directory: string;
  path: string;
  fileName: string;
}

export interface DownloadResult {
  path: string;
  fileName: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
}

/**
 * Turn a server-provided name into a single safe path segment. Challenge and
 * Sherlock archives are not trusted, so path separators, traversal segments,
 * and shell-hostile characters are removed before the file is written.
 */
export function sanitizeFileName(value: string, fallback: string): string {
  const candidate = basename(value)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 180);
  if (candidate) {
    return candidate;
  }

  const safeFallback = fallback
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 180);
  return safeFallback || "download.bin";
}

export function buildDownloadTarget(
  rootDir: string,
  product: DownloadProduct,
  id: number,
  fileName: string,
): DownloadTarget {
  const directory = resolve(rootDir, product, String(id));
  const safeName = sanitizeFileName(fileName, `${product.slice(0, -1)}-${id}.zip`);
  const path = resolve(directory, safeName);

  if (!path.startsWith(`${directory}${sep}`)) {
    throw new HtbError({
      code: "INVALID_RESPONSE",
      message: "Refusing to write a download outside the configured directory.",
    });
  }

  return { directory, path, fileName: safeName };
}

export async function downloadToFile(
  client: HtbClient,
  url: string,
  target: DownloadTarget,
): Promise<DownloadResult> {
  const response = await client.fetchExternal(url);
  if (!response.body) {
    throw new HtbError({
      code: "INVALID_RESPONSE",
      message: "The download response had no body.",
    });
  }

  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await mkdir(target.directory, { recursive: true, mode: 0o700 });

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      meter,
      createWriteStream(target.path, { mode: 0o600 }),
    );
  } catch (error) {
    await unlink(target.path).catch(() => undefined);
    throw new HtbError({
      code: "NETWORK_ERROR",
      message: `Could not save ${target.fileName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      hint: "Check free disk space, then request a fresh download link.",
    });
  }

  return {
    path: target.path,
    fileName: target.fileName,
    bytes,
    sha256: hash.digest("hex"),
    contentType: response.headers.get("content-type"),
  };
}
