import assert from "node:assert/strict";
import test from "node:test";
import { HtbClient } from "../src/client.js";
import { HtbError } from "../src/errors.js";
import { jsonResponse, makeConfig, textResponse } from "./helpers.js";

type Captured = {
  url: URL;
  init: RequestInit;
};

function capturingFetch(
  responses: Array<() => Response | Promise<Response>>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(input instanceof Request ? input.url : input.toString()),
      init: init ?? {},
    });
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!response) {
      throw new Error("No mock response configured");
    }
    return response();
  }) as typeof fetch;

  return { fetchImpl, calls };
}

test("sends bearer auth, cookie, and repeated array query parameters", async () => {
  const { fetchImpl, calls } = capturingFetch([
    () => jsonResponse({ data: [] }),
  ]);
  const client = new HtbClient(
    makeConfig({ sessionCookie: "htb_session=abc" }),
    fetchImpl,
  );

  await client.get("/machines", {
    version: "v5",
    query: {
      state: ["active", "retired"],
      "difficulty[]": ["easy", "medium"],
      page: 2,
    },
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url.origin, "https://labs.hackthebox.com");
  assert.equal(call.url.pathname, "/api/v5/machines");
  assert.deepEqual(call.url.searchParams.getAll("state"), ["active", "retired"]);
  assert.deepEqual(call.url.searchParams.getAll("difficulty[]"), ["easy", "medium"]);
  assert.equal(call.url.searchParams.get("page"), "2");

  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-token");
  assert.equal(headers.get("cookie"), "htb_session=abc");
  assert.equal(headers.get("origin"), "https://app.hackthebox.com");
});

test("retries a rate-limited request using Retry-After", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({ message: "Too many requests" }, 429, {
        "retry-after": "0",
      });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const client = new HtbClient(makeConfig({ maxRetries: 1 }), fetchImpl);
  const result = await client.get<{ ok: boolean }>("/machine/active");

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("retries POST on 429 but not on 5xx", async () => {
  let post429Calls = 0;
  const retryFetch = (async () => {
    post429Calls += 1;
    return post429Calls === 1
      ? jsonResponse({ message: "slow down" }, 429, { "retry-after": "0" })
      : jsonResponse({ success: true });
  }) as typeof fetch;
  const retryClient = new HtbClient(makeConfig({ maxRetries: 1 }), retryFetch);
  await retryClient.post("/vm/spawn", { body: { machine_id: 1 } });
  assert.equal(post429Calls, 2);

  let post500Calls = 0;
  const noRetryFetch = (async () => {
    post500Calls += 1;
    return jsonResponse({ message: "upstream exploded" }, 500);
  }) as typeof fetch;
  const noRetryClient = new HtbClient(makeConfig({ maxRetries: 3 }), noRetryFetch);

  await assert.rejects(
    () => noRetryClient.post("/vm/spawn", { body: { machine_id: 1 } }),
    (error: unknown) =>
      error instanceof HtbError && error.code === "API_ERROR" && error.status === 500,
  );
  assert.equal(post500Calls, 1);
});

test("detects HTML app pages instead of treating them as JSON", async () => {
  const { fetchImpl } = capturingFetch([
    () => textResponse("<!doctype html><html><body>app</body></html>", 200, "text/html"),
  ]);
  const client = new HtbClient(makeConfig(), fetchImpl);

  await assert.rejects(
    () => client.get("/user/info"),
    (error: unknown) =>
      error instanceof HtbError &&
      error.code === "INVALID_RESPONSE" &&
      /HTML/.test(error.message),
  );
});

test("turns API errors into actionable HtbError values", async () => {
  const { fetchImpl } = capturingFetch([
    () => jsonResponse({ message: "Incorrect flag" }, 400),
  ]);
  const client = new HtbClient(makeConfig(), fetchImpl);

  await assert.rejects(
    () => client.post("/machine/own", { body: { id: 1, flag: "nope" } }),
    (error: unknown) =>
      error instanceof HtbError &&
      error.code === "API_ERROR" &&
      error.status === 400 &&
      /Incorrect flag/.test(error.message),
  );
});

test("reports auth failures with a token hint", async () => {
  const { fetchImpl } = capturingFetch([
    () => jsonResponse({ message: "Unauthenticated." }, 401),
  ]);
  const client = new HtbClient(makeConfig(), fetchImpl);

  await assert.rejects(
    () => client.get("/user/info"),
    (error: unknown) =>
      error instanceof HtbError &&
      error.code === "AUTH_FAILED" &&
      /HTB_TOKEN/.test(error.hint ?? ""),
  );
});

test("fails before the network when credentials are missing", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({});
  }) as typeof fetch;
  const client = new HtbClient(
    makeConfig({ token: undefined, sessionCookie: undefined }),
    fetchImpl,
  );

  await assert.rejects(
    () => client.get("/user/info"),
    (error: unknown) => error instanceof HtbError && error.code === "AUTH_MISSING",
  );
  assert.equal(called, false);
});
