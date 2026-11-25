import assert from "node:assert/strict";
import test from "node:test";
import { HtbApi } from "../src/api.js";
import { HtbClient } from "../src/client.js";
import { HtbError } from "../src/errors.js";
import { jsonResponse, makeConfig } from "./helpers.js";

function apiWithFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): HtbApi {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return handler(url, init ?? {});
  }) as typeof fetch;
  return new HtbApi(new HtbClient(makeConfig(), fetchImpl));
}

test("normalizes the v5 active machine response", async () => {
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v5/virtual_machine/active");
    return jsonResponse({
      info: {
        id: 351,
        name: "Cap",
        ip: "10.129.22.200",
        isSpawning: false,
        expires_at: "2026-06-26 17:03:17",
        type: "machine",
        vpn_server_id: 289,
        vpn_server_type: "Machines VIP+",
      },
    });
  });

  const active = await api.getActiveMachine();
  assert.ok(active);
  assert.equal(active.id, 351);
  assert.equal(active.name, "Cap");
  assert.equal(active.ip, "10.129.22.200");
  assert.equal(active.vpnServerId, 289);
});

test("lists machines with v5 filters and pagination", async () => {
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v5/machines");
    assert.deepEqual(url.searchParams.getAll("state"), ["active", "retired"]);
    assert.deepEqual(url.searchParams.getAll("difficulty[]"), ["easy"]);
    assert.equal(url.searchParams.get("per_page"), "50");
    return jsonResponse({
      data: [
        {
          id: 305,
          name: "Sunday",
          os: "Linux",
          difficultyText: "Easy",
          points: 20,
          state: "retired",
          free: true,
          authUserInUserOwns: true,
          authUserInRootOwns: false,
          todo: false,
          rating: 4,
          releaseDate: "2018-08-04T16:00:00.000Z",
        },
      ],
      meta: { current_page: 1, total: 1 },
    });
  });

  const result = await api.listMachines({
    state: "all",
    difficulty: "easy",
    perPage: 50,
  });

  assert.equal(result.machines.length, 1);
  assert.equal(result.machines[0]?.name, "Sunday");
  assert.equal(result.machines[0]?.difficulty, "Easy");
  assert.equal(result.machines[0]?.userOwned, true);
  assert.equal(result.meta.total, 1);
});

test("resolves a machine name via exact search", async () => {
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v5/machines");
    assert.equal(url.searchParams.get("keyword"), "Sunday");
    return jsonResponse({
      data: [
        { id: 305, name: "Sunday", os: "Linux", difficultyText: "Easy" },
        { id: 999, name: "Sunday School", os: "Linux", difficultyText: "Easy" },
      ],
    });
  });

  const machine = await api.resolveMachine("Sunday");
  assert.equal(machine.id, 305);
  assert.equal(machine.name, "Sunday");
});

test("flattens nested VPN server options and marks the assigned server", async () => {
  const api = apiWithFetch((url) => {
    if (url.pathname === "/api/v5/connections") {
      return jsonResponse({
        data: [
          {
            type: "labs",
            location_type_friendly: "US - VIP+",
            assigned_server: {
              id: 289,
              friendly_name: "US VIP+ 1",
              current_clients: 146,
              location: "US",
            },
          },
        ],
      });
    }
    if (url.pathname === "/api/v4/connections/servers") {
      return jsonResponse({
        status: true,
        data: {
          assigned: { id: 289, friendly_name: "US VIP+ 1", current_clients: 146 },
          options: {
            US: {
              "US - VIP+": {
                servers: {
                  "289": {
                    id: 289,
                    friendly_name: "US VIP+ 1",
                    current_clients: 146,
                    full: false,
                    location: "US",
                    location_type_friendly: "US - VIP+",
                  },
                  "290": {
                    id: 290,
                    friendly_name: "US VIP+ 2",
                    current_clients: 4,
                    full: false,
                    location: "US",
                    location_type_friendly: "US - VIP+",
                  },
                },
              },
            },
          },
        },
      });
    }
    throw new Error(`Unexpected URL ${url.pathname}`);
  });

  const result = await api.getVpnServers("labs");
  assert.equal(result.servers.length, 2);
  assert.equal(result.assigned?.id, 289);
  assert.equal(result.servers.find((server) => server.id === 289)?.assigned, true);
  assert.equal(result.servers.find((server) => server.id === 290)?.currentClients, 4);
  assert.deepEqual(result.warnings, []);
});

test("downloads the UDP profile and validates its contents", async () => {
  const profile = [
    "client",
    "dev tun",
    "proto udp",
    "remote 10.10.14.1 1337",
    "<ca>",
  ].join("\n");
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v4/access/ovpnfile/289/0");
    return new Response(profile, {
      status: 200,
      // HTB currently serves .ovpn profiles with a text/html content type.
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  const result = await api.getVpnConfig(289, "labs", "udp");
  assert.equal(result.serverId, 289);
  assert.equal(result.content, profile);
  assert.equal(result.endpoint, "/access/ovpnfile/289/0");
});

test("rejects non-profile payloads", async () => {
  const api = apiWithFetch(() =>
    new Response('{"message":"not assigned"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await assert.rejects(
    () => api.getVpnConfig(999, "labs", "udp"),
    (error: unknown) =>
      error instanceof HtbError &&
      (error.code === "INVALID_RESPONSE" || error.code === "API_ERROR"),
  );
});

test("lists challenge categories", async () => {
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v4/challenge/categories/list");
    return jsonResponse({
      info: [
        { id: 1, name: "Web", icon: "https://cdn.example/web.svg" },
        { id: 2, name: "Crypto", icon: null },
      ],
    });
  });

  const categories = await api.listChallengeCategories();
  assert.equal(categories.length, 2);
  assert.equal(categories[0]?.name, "Web");
  assert.equal(categories[1]?.icon, null);
});

test("starts and stops a challenge container through /container", async () => {
  const calls: string[] = [];
  const api = apiWithFetch((url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    assert.deepEqual(JSON.parse(String(init.body)), { containerable_id: 883 });
    if (url.pathname === "/api/v4/container/start") {
      return jsonResponse({ message: "Instance Created!", id: 1214160 });
    }
    assert.equal(url.pathname, "/api/v4/container/stop");
    return jsonResponse({ message: "Instance Stopped!" });
  });

  const started = await api.startChallengeContainer(883);
  assert.equal(started.message, "Instance Created!");
  await api.stopChallengeContainer(883);
  assert.deepEqual(calls, [
    "POST /api/v4/container/start",
    "POST /api/v4/container/stop",
  ]);
});

test("fetches a challenge download link", async () => {
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v4/challenges/883/download_link");
    return jsonResponse({
      url: "https://cdn.example/challenges/883.zip?signature=abc",
      expires_in: 300,
    });
  });

  const link = await api.getChallengeDownloadLink(883);
  assert.match(link.url, /883\.zip/);
  assert.equal(link.expiresIn, 300);
});

test("lists Sherlocks with state, difficulty, and category filters", async () => {
  const api = apiWithFetch((url) => {
    assert.equal(url.pathname, "/api/v4/sherlocks");
    assert.deepEqual(url.searchParams.getAll("state"), ["active", "retired"]);
    assert.deepEqual(url.searchParams.getAll("difficulty[]"), ["hard"]);
    assert.equal(url.searchParams.get("category[]"), "16");
    assert.equal(url.searchParams.get("per_page"), "50");
    return jsonResponse({
      data: [
        {
          id: 565,
          name: "Safecracker",
          category_name: "Malware Analysis",
          difficulty: "Hard",
          state: "active",
          is_owned: false,
          progress: 25,
          solves: 120,
          rating: 4.5,
          release_date: "2026-01-01T00:00:00.000000Z",
        },
      ],
      meta: { current_page: 1, total: 1 },
    });
  });

  const result = await api.listSherlocks({
    state: "all",
    difficulty: "hard",
    category: 16,
    perPage: 50,
  });

  assert.equal(result.sherlocks[0]?.name, "Safecracker");
  assert.equal(result.sherlocks[0]?.category, "Malware Analysis");
  assert.equal(result.sherlocks[0]?.progress, 25);
  assert.equal(result.meta.total, 1);
});

test("merges Sherlock info, play, and progress", async () => {
  const api = apiWithFetch((url) => {
    if (url.pathname === "/api/v4/sherlocks/Safecracker") {
      return jsonResponse({
        data: {
          id: 565,
          name: "Safecracker",
          category_name: "Malware Analysis",
          difficulty: "Insane",
          state: "active",
          is_owned: false,
          file_password: "sherlock",
        },
      });
    }
    if (url.pathname === "/api/v4/sherlocks/565/info") {
      return jsonResponse({
        data: {
          id: 565,
          description: "Analyse the evidence.",
          user_owns_count: 42,
          academyModules: [{ id: 7, name: "DFIR Fundamentals" }],
        },
      });
    }
    if (url.pathname === "/api/v4/sherlocks/565/play") {
      return jsonResponse({
        data: {
          scenario: "A workstation was compromised.",
          creators: [{ name: "maker" }],
          file_name: "evidence.zip",
          file_size: "12 MB",
          play_info: { status: "ready", ip: null, ports: [], expires_at: null },
          blood: { blood_user: "first" },
        },
      });
    }
    if (url.pathname === "/api/v4/sherlocks/565/progress") {
      return jsonResponse({
        data: {
          is_owned: true,
          own_rank: 2,
          progress: 50,
          tasks_answered: 3,
          total_tasks: 6,
        },
      });
    }
    throw new Error(`Unexpected URL ${url.pathname}`);
  });

  const sherlock = await api.getSherlock("Safecracker");
  assert.equal(sherlock.id, 565);
  assert.equal(sherlock.description, "Analyse the evidence.");
  assert.equal(sherlock.scenario, "A workstation was compromised.");
  assert.equal(sherlock.fileName, "evidence.zip");
  assert.deepEqual(sherlock.creators, ["maker"]);
  assert.equal(sherlock.isOwned, true);
  assert.equal(sherlock.tasksAnswered, 3);
  assert.equal(sherlock.totalTasks, 6);
});

test("submits a Sherlock task answer", async () => {
  const api = apiWithFetch((url, init) => {
    assert.equal(url.pathname, "/api/v4/sherlocks/565/tasks/2880/flag");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { flag: "10.0.0.5" });
    return jsonResponse({ message: "Task flag owned!" }, 201);
  });

  const result = await api.submitSherlockTask(565, 2880, "10.0.0.5");
  assert.equal(result.message, "Task flag owned!");
});

test("submits a machine flag through v5", async () => {
  const api = apiWithFetch((url, init) => {
    assert.equal(url.pathname, "/api/v5/machine/own");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), {
      id: 305,
      flag: "0123456789abcdef0123456789abcdef",
    });
    return jsonResponse({
      success: true,
      message: "You pwned the User Flag!",
      own_type: "User",
      points: 20,
    });
  });

  const result = await api.submitMachineFlag(
    305,
    "0123456789abcdef0123456789abcdef",
  );
  assert.equal(result.success, true);
  assert.equal(result.own_type, "User");
});
