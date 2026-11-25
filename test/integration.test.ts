import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const downloadDir = await mkdtemp(join(tmpdir(), "htb-mcp-downloads-"));
  const requests: string[] = [];
  let activeMachine: Record<string, unknown> | null = null;
  let challengeRunning = false;
  const mockServer = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    respond(req, res, {
      getActiveMachine: () => activeMachine,
      setActiveMachine: (machine) => {
        activeMachine = machine;
      },
      isChallengeRunning: () => challengeRunning,
      setChallengeRunning: (running) => {
        challengeRunning = running;
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
      HTB_DOWNLOAD_DIR: downloadDir,
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

    const challengeListResult = await client.callTool({
      name: "htb_list_challenges",
      arguments: { state: "active", per_page: 5 },
    });
    const challengeList = parseToolJson(challengeListResult);
    assert.equal((challengeList.challenges as JsonBody[])[0]?.name, "Flag Command");

    const challengeStartResult = await client.callTool({
      name: "htb_start_challenge",
      arguments: { target: 883, wait_seconds: 5 },
    });
    const challengeStarted = parseToolJson(challengeStartResult);
    assert.equal(challengeStarted.action, "started");
    assert.equal((challengeStarted.container as JsonBody).ip, "10.10.10.10");

    const challengeStatusResult = await client.callTool({
      name: "htb_challenge_status",
      arguments: { target: 883 },
    });
    const challengeStatus = parseToolJson(challengeStatusResult);
    assert.equal(challengeStatus.running, true);
    assert.deepEqual((challengeStatus.container as JsonBody).ports, [31337]);

    const challengeDownloadResult = await client.callTool({
      name: "htb_download_challenge",
      arguments: { target: 883 },
    });
    const challengeDownload = parseToolJson(challengeDownloadResult);
    assert.match(String(challengeDownload.path), /challenges\/883\/challenge\.zip$/);
    assert.equal(
      await readFile(String(challengeDownload.path), "utf8"),
      "challenge-bytes",
    );

    const challengeStopResult = await client.callTool({
      name: "htb_stop_challenge",
      arguments: { target: 883 },
    });
    assert.equal(parseToolJson(challengeStopResult).action, "stopped");

    const sherlockListResult = await client.callTool({
      name: "htb_list_sherlocks",
      arguments: { state: "active", per_page: 5 },
    });
    const sherlockList = parseToolJson(sherlockListResult);
    assert.equal((sherlockList.sherlocks as JsonBody[])[0]?.name, "Safecracker");

    const sherlockResult = await client.callTool({
      name: "htb_get_sherlock",
      arguments: { target: "Safecracker" },
    });
    const sherlock = parseToolJson(sherlockResult);
    assert.equal(sherlock.description, "Analyse the evidence.");
    assert.equal(sherlock.scenario, "A workstation was compromised.");
    assert.equal(sherlock.totalTasks, 6);

    const tasksResult = await client.callTool({
      name: "htb_sherlock_tasks",
      arguments: { target: 565 },
    });
    const tasks = parseToolJson(tasksResult);
    assert.equal((tasks.tasks as JsonBody[])[0]?.id, 2880);

    const answerResult = await client.callTool({
      name: "htb_submit_sherlock_answer",
      arguments: { target: 565, task_id: 2880, flag: "10.0.0.5" },
    });
    const answer = parseToolJson(answerResult);
    assert.equal((answer.result as JsonBody).message, "Task flag owned!");

    assert.ok(requests.some((request) => request.includes("/api/v5/machines")));
    assert.ok(requests.some((request) => request === "POST /api/v4/vm/spawn"));
    assert.ok(requests.some((request) => request === "POST /api/v4/container/start"));
    assert.ok(requests.some((request) => request === "POST /api/v4/container/stop"));
  } finally {
    await client.close();
    await new Promise<void>((resolveClose) => mockServer.close(() => resolveClose()));
    await rm(vpnDir, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  state: {
    getActiveMachine: () => Record<string, unknown> | null;
    setActiveMachine: (machine: Record<string, unknown> | null) => void;
    isChallengeRunning: () => boolean;
    setChallengeRunning: (running: boolean) => void;
  },
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
  const send = (body: unknown): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Presigned downloads intentionally carry no Authorization header.
  if (url.pathname === "/files/883.zip") {
    res.writeHead(200, { "content-type": "application/zip" });
    res.end("challenge-bytes");
    return;
  }

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

  if (url.pathname === "/api/v4/challenges") {
    send({
      data: [
        {
          id: 883,
          name: "Flag Command",
          category_name: "Web",
          difficulty: "Easy",
          points: 20,
          state: "active",
          download: true,
          docker: true,
          is_owned: false,
          solves: 100,
          rating: 4.5,
          release_date: "2026-01-01T00:00:00.000000Z",
        },
      ],
      meta: { current_page: 1, total: 1 },
    });
    return;
  }

  if (url.pathname === "/api/v4/challenge/info/883") {
    const running = state.isChallengeRunning();
    send({
      challenge: {
        id: 883,
        name: "Flag Command",
        category_name: "Web",
        difficulty: "Easy",
        points: 20,
        state: "active",
        description: "Find the hidden command.",
        creator_name: "maker",
        download: true,
        docker: true,
        file_name: "challenge.zip",
        file_password: "hackthebox",
        docker_status: running ? "ready" : null,
        docker_ip: running ? "10.10.10.10" : null,
        docker_ports: running ? [31337] : [],
        play_info: running
          ? {
              status: "ready",
              ip: "10.10.10.10",
              ports: [31337],
              expires_at: "2026-11-25T17:00:00.000000Z",
            }
          : null,
        authUserSolve: false,
        is_owned: false,
        solves: 100,
        rating: 4.5,
        release_date: "2026-01-01T00:00:00.000000Z",
      },
    });
    return;
  }

  if (url.pathname === "/api/v4/challenges/883/download_link") {
    send({ url: `${origin}/files/883.zip`, expires_in: 300 });
    return;
  }

  if (url.pathname === "/api/v4/container/start" && req.method === "POST") {
    state.setChallengeRunning(true);
    send({ message: "Instance Created!", id: 1214160 });
    return;
  }

  if (url.pathname === "/api/v4/container/stop" && req.method === "POST") {
    state.setChallengeRunning(false);
    send({ message: "Instance Stopped!" });
    return;
  }

  if (url.pathname === "/api/v4/sherlocks") {
    send({
      data: [
        {
          id: 565,
          name: "Safecracker",
          category_name: "Malware Analysis",
          difficulty: "Hard",
          state: "active",
          is_owned: false,
          progress: 50,
          solves: 120,
          rating: 4.5,
          release_date: "2026-01-01T00:00:00.000000Z",
        },
      ],
      meta: { current_page: 1, total: 1 },
    });
    return;
  }

  if (
    url.pathname === "/api/v4/sherlocks/Safecracker" ||
    url.pathname === "/api/v4/sherlocks/565"
  ) {
    send({
      data: {
        id: 565,
        name: "Safecracker",
        category_name: "Malware Analysis",
        difficulty: "Hard",
        state: "active",
        is_owned: false,
        file_password: "sherlock",
      },
    });
    return;
  }

  if (url.pathname === "/api/v4/sherlocks/565/info") {
    send({
      data: {
        id: 565,
        description: "Analyse the evidence.",
        user_owns_count: 42,
        academyModules: [{ id: 7, name: "DFIR Fundamentals" }],
      },
    });
    return;
  }

  if (url.pathname === "/api/v4/sherlocks/565/play") {
    send({
      data: {
        scenario: "A workstation was compromised.",
        creators: [{ name: "maker" }],
        file_name: "evidence.zip",
        file_size: "12 MB",
        play_info: { status: "ready", ip: null, ports: [], expires_at: null },
      },
    });
    return;
  }

  if (url.pathname === "/api/v4/sherlocks/565/progress") {
    send({
      data: {
        is_owned: false,
        own_rank: null,
        progress: 50,
        tasks_answered: 3,
        total_tasks: 6,
      },
    });
    return;
  }

  if (url.pathname === "/api/v4/sherlocks/565/tasks") {
    send({
      data: [
        {
          id: 2880,
          title: "What is the attacker IP?",
          description: "Find the source address in the logs.",
          hint: null,
          completed: false,
          masked_flag: "10.0.0.*",
          task_type: { id: 1, text: "input" },
          options: [],
          prerequisite_id: null,
        },
      ],
    });
    return;
  }

  if (
    url.pathname === "/api/v4/sherlocks/565/tasks/2880/flag" &&
    req.method === "POST"
  ) {
    send({ message: "Task flag owned!" });
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
