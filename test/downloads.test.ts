import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HtbClient } from "../src/client.js";
import {
  buildDownloadTarget,
  downloadToFile,
  sanitizeFileName,
} from "../src/downloads.js";
import { HtbError } from "../src/errors.js";
import { makeConfig } from "./helpers.js";

test("sanitizes download names and keeps paths inside the download root", () => {
  assert.equal(sanitizeFileName("../../etc/passwd", "fallback.zip"), "passwd");
  assert.equal(sanitizeFileName("evil name; rm -rf.zip", "fallback.zip"), "evil_name_rm_-rf.zip");
  assert.equal(sanitizeFileName("...", "fallback.zip"), "fallback.zip");

  const target = buildDownloadTarget(
    "/tmp/htb-downloads",
    "challenges",
    42,
    "../../escape.zip",
  );
  assert.equal(target.directory, "/tmp/htb-downloads/challenges/42");
  assert.equal(target.path, "/tmp/htb-downloads/challenges/42/escape.zip");
});

test("downloads external files without HTB credentials and hashes them", async () => {
  const downloadDir = await mkdtemp(join(tmpdir(), "htb-mcp-download-"));
  const payload = "sherlock-evidence";
  let requestedUrl = "";
  let requestHeaders: HeadersInit | undefined;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = input instanceof Request ? input.url : input.toString();
    requestHeaders = init?.headers;
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  }) as typeof fetch;

  try {
    const client = new HtbClient(
      makeConfig({ downloadDir, labsUrl: "https://labs.hackthebox.com" }),
      fetchImpl,
    );
    const target = buildDownloadTarget(
      downloadDir,
      "sherlocks",
      565,
      "evidence.zip",
    );
    const result = await downloadToFile(
      client,
      "https://cdn.example/evidence.zip?signature=abc",
      target,
    );

    assert.equal(requestedUrl, "https://cdn.example/evidence.zip?signature=abc");
    const headers = new Headers(requestHeaders);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cookie"), null);

    assert.equal(result.bytes, Buffer.byteLength(payload));
    assert.equal(result.fileName, "evidence.zip");
    assert.equal(
      result.sha256,
      createHash("sha256").update(payload).digest("hex"),
    );
    assert.equal(await readFile(result.path, "utf8"), payload);
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("rejects plain-http download URLs outside local development", async () => {
  const client = new HtbClient(
    makeConfig({ labsUrl: "https://labs.hackthebox.com" }),
    (async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch,
  );

  await assert.rejects(
    () => client.fetchExternal("http://cdn.example/file.zip"),
    (error: unknown) =>
      error instanceof HtbError && error.code === "INVALID_RESPONSE",
  );
});
