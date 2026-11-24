import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface JsonBody {
  [key: string]: unknown;
}

test("speaks MCP over stdio and calls the mock HTB API", { timeout: 30_000 }, async () => {
  const vpnDir = await mkdtemp(join(tmpdir(), "htb-mcp-integration-"));
  const requests: string[] = [];
  let activeMachine: Record<string, unknown> | null = null;
  const mockServer = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    respond(req, res, {
      getActiveMachine: () => activeMachine,
      setActiveMachine: (machine) => {
        activeMachine = machine;
      },
    });
  });

  await new Promise<void>((resolveListen) => {
    mockServer.listen(0, "127.0.0.1", () => resolveListen());
  });

  const address = mockServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  const client = new Client({ name: "htb-mcp-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/index.js")],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return entry[1] !== undefined;
        }),
      ) as Record<string, string>),
      HTB_TOKEN: "integration-token",
      HTB_LABS_URL: baseUrl,
      HTB_VPN_DIR: vpnDir,
      HTB_MAX_RETRIES: "0",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("htb_status"));
    assert.ok(names.includes("htb_launch_machine"));
    assert.ok(names.includes("htb_vpn_resolve"));

    const statusResult = await client.callTool({
      name: "htb_status",
      arguments: {},
    });
    const status = parseToolJson(statusResult);
    assert.equal((status.user as JsonBody).name, "tester");
    assert.equal(status.activeMachine, null);

    const listResult = await client.callTool({
      name: "htb_list_machines",
      arguments: { state: "active", per_page: 5 },
    });
    const listed = parseToolJson(listResult);
    const machines = listed.machines as JsonBody[];
    assert.equal(machines[0]?.name, "Sunday");

    const switchResult = await client.callTool({
      name: "htb_vpn_switch",
      arguments: { server_id: 999 },
    });
    const switchError = parseToolError(switchResult);
    assert.equal(switchError.error, "API_ERROR");
    assert.match(String(switchError.message), /rejected/);

    const launchResult = await client.callTool({
      name: "htb_launch_machine",
      arguments: { target: "Sunday", wait_seconds: 5 },
    });
    const launched = parseToolJson(launchResult);
    assert.equal(launched.action, "spawned");
    assert.equal((launched.machine as JsonBody).ip, "10.129.1.42");

    assert.ok(requests.some((request) => request.includes("/api/v5/machines")));
    assert.ok(requests.some((request) => request === "POST /api/v4/vm/spawn"));
  } finally {
    await client.close();
    await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
    await rm(vpnDir, { recursive: true, force: true });
  }
});

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  state: {
    getActiveMachine: () => Record<string, unknown> | null;
    setActiveMachine: (machine: Record<string, unknown> | null) => void;
  },
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.headers.authorization !== "Bearer integration-token") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Unauthenticated." }));
    return;
  }

  if (url.pathname === "/api/v4/user/info") {
    send({
      info: {
        id: 7,
        name: "tester",
        email: "tester@example.com",
        isVip: false,
        rank_id: 3,
      },
    });
    return;
  }

  if (url.pathname === "/api/v5/virtual_machine/active") {
    send({ info: state.getActiveMachine() });
    return;
  }

  if (url.pathname === "/api/v4/vm/spawn" && req.method === "POST") {
    state.setActiveMachine({
      id: 305,
      name: "Sunday",
      ip: "10.129.1.42",
      isSpawning: false,
      expires_at: "2026-11-25T17:00:00.000000Z",
      type: "machine",
      vpn_server_id: 1,
    });
    send({ success: true, message: "Machine spawned." });
    return;
  }

  if (url.pathname === "/api/v5/connections") {
    send({ data: [] });
    return;
  }

  if (
    url.pathname === "/api/v4/connections/servers/switch/999" &&
    req.method === "POST"
  ) {
    send({
      status: false,
      message: "You cannot switch VPN server while a machine is active.",
    });
    return;
  }

  if (url.pathname === "/api/v5/machines") {
    send({
      data: [
        {
          id: 305,
          name: "Sunday",
          os: "Linux",
          difficultyText: "Easy",
          points: 20,
          state: "active",
          free: true,
          authUserInUserOwns: true,
          authUserInRootOwns: false,
          todo: false,
          rating: 4,
          releaseDate: "2018-08-04T16:00:00.000Z",
        },
      ],
      meta: { current_page: 1, total: 1, last_page: 1 },
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `Unhandled ${url.pathname}` }));
}

function parseToolJson(result: Awaited<ReturnType<Client["callTool"]>>): JsonBody {
  assert.equal(result.isError, undefined);
  return parseToolText(result);
}

function parseToolError(result: Awaited<ReturnType<Client["callTool"]>>): JsonBody {
  assert.equal(result.isError, true);
  return parseToolText(result);
}

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): JsonBody {
  const content = result.content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: string } | undefined;
  assert.ok(first && first.type === "text" && typeof first.text === "string");
  return JSON.parse(first.text) as JsonBody;
}
