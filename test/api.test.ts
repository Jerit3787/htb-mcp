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
      headers: { "content-type": "application/x-openvpn-profile" },
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
