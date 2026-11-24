import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ActiveMachine,
  HtbApi,
  VpnConfigResult,
  VpnServer,
} from "../src/api.js";
import { HtbError } from "../src/errors.js";
import {
  chooseBestVpnServer,
  ensureInsideVpnDir,
  parseVpnProfile,
  resolveAndSaveVpnConfig,
} from "../src/vpn.js";
import { makeConfig } from "./helpers.js";

const PROFILE = [
  "client",
  "dev tun0",
  "proto udp",
  "remote vpn.example.test 1337",
  "remote backup.example.test 1338 tcp",
  "remote-random",
  "<ca>",
].join("\n");

function server(
  id: number,
  clients: number,
  overrides: Partial<VpnServer> = {},
): VpnServer {
  return {
    id,
    name: `Server ${id}`,
    location: "US",
    tier: "US - Machines VIP+",
    currentClients: clients,
    full: false,
    product: "labs",
    assigned: false,
    raw: {},
    ...overrides,
  };
}

function activeMachine(): ActiveMachine {
  return {
    id: 1,
    name: "Cap",
    ip: "10.129.1.1",
    isSpawning: false,
    expiresAt: null,
    type: "machine",
    labServer: "vip_lab",
    vpnServerId: 1,
    vpnServerType: "Machines VIP+",
    raw: {},
  };
}

function fakeApi(overrides: {
  servers?: VpnServer[];
  assigned?: VpnServer | null;
  active?: ActiveMachine | null;
  onSwitch?: (id: number) => void;
  config?: VpnConfigResult;
}): HtbApi {
  const assigned =
    overrides.assigned === undefined ? server(1, 100, { assigned: true }) : overrides.assigned;
  return {
    getVpnServers: async () => ({
      servers: overrides.servers ?? [server(1, 100, { assigned: true }), server(2, 2)],
      assigned,
      connections: [],
      warnings: [],
    }),
    getActiveMachine: async () => overrides.active ?? null,
    switchVpnServer: async (id: number) => {
      overrides.onSwitch?.(id);
      return { success: true };
    },
    getVpnConfig: async (
      serverId: number,
      product: string,
      protocol: "udp" | "tcp",
    ): Promise<VpnConfigResult> =>
      overrides.config ?? {
        serverId,
        product,
        protocol,
        endpoint: `/access/ovpnfile/${serverId}/0`,
        content: PROFILE,
      },
  } as unknown as HtbApi;
}

test("parses remote endpoints, protocol, and device", () => {
  const profile = parseVpnProfile(PROFILE);
  assert.equal(profile.device, "tun0");
  assert.equal(profile.proto, "udp");
  assert.deepEqual(profile.remotes, [
    { host: "vpn.example.test", port: 1337, protocol: null },
    { host: "backup.example.test", port: 1338, protocol: "tcp" },
  ]);
});

test("parses a remote without an explicit port as 1194", () => {
  const profile = parseVpnProfile("client\nremote vpn.example.test\n");
  assert.deepEqual(profile.remotes, [
    { host: "vpn.example.test", port: 1194, protocol: null },
  ]);
});

test("selects the least-busy server in the assigned tier", () => {
  const assigned = server(1, 90, { assigned: true });
  const best = chooseBestVpnServer(
    [
      assigned,
      server(2, 10),
      server(3, 1, { tier: "EU - Machines VIP+" }),
      server(4, 0, { full: true }),
    ],
    assigned,
  );

  assert.equal(best?.id, 2);
});

test("falls back to the assigned server when no candidate is available", () => {
  const assigned = server(1, 90, { assigned: true });
  assert.equal(chooseBestVpnServer([assigned], assigned)?.id, 1);
  assert.equal(chooseBestVpnServer([], assigned)?.id, 1);
});

test("rejects OpenVPN profiles outside the managed directory", () => {
  const config = makeConfig({ vpnDir: "/tmp/htb-mcp-vpn" });
  assert.throws(
    () => ensureInsideVpnDir(config, "/etc/openvpn/evil.ovpn"),
    (error: unknown) => error instanceof HtbError && error.code === "VPN_ERROR",
  );
  assert.equal(
    ensureInsideVpnDir(config, "/tmp/htb-mcp-vpn/profile.ovpn"),
    "/tmp/htb-mcp-vpn/profile.ovpn",
  );
});

test("auto-selects a server, switches, and writes a 0600 profile", async () => {
  const vpnDir = await mkdtemp(join(tmpdir(), "htb-mcp-test-"));
  const switches: number[] = [];

  try {
    const api = fakeApi({
      onSwitch: (id) => switches.push(id),
    });
    const saved = await resolveAndSaveVpnConfig(api, makeConfig({ vpnDir }), {
      serverId: undefined,
      product: "labs",
      protocol: "udp",
      selectBest: true,
      force: false,
      probe: false,
    });

    assert.deepEqual(switches, [2]);
    assert.equal(saved.serverId, 2);
    assert.equal(saved.path, join(vpnDir, "htb-labs-2-udp.ovpn"));
    assert.equal(await readFile(saved.path, "utf8"), PROFILE);
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  } finally {
    await rm(vpnDir, { recursive: true, force: true });
  }
});

test("does not switch when download is requested without auto-selection", async () => {
  const vpnDir = await mkdtemp(join(tmpdir(), "htb-mcp-test-"));
  const switches: number[] = [];

  try {
    const api = fakeApi({ onSwitch: (id) => switches.push(id) });
    const saved = await resolveAndSaveVpnConfig(api, makeConfig({ vpnDir }), {
      serverId: undefined,
      product: "labs",
      protocol: "tcp",
      selectBest: false,
      force: false,
      probe: false,
    });

    assert.deepEqual(switches, []);
    assert.equal(saved.serverId, 1);
    assert.equal(saved.protocol, "tcp");
  } finally {
    await rm(vpnDir, { recursive: true, force: true });
  }
});

test("blocks a server switch while a machine is active unless forced", async () => {
  const vpnDir = await mkdtemp(join(tmpdir(), "htb-mcp-test-"));

  try {
    const api = fakeApi({ active: activeMachine() });
    await assert.rejects(
      () =>
        resolveAndSaveVpnConfig(api, makeConfig({ vpnDir }), {
          serverId: undefined,
          product: "labs",
          protocol: "udp",
          selectBest: true,
          force: false,
          probe: false,
        }),
      (error: unknown) =>
        error instanceof HtbError &&
        error.code === "CONFLICT" &&
        /terminate/.test(error.message),
    );
  } finally {
    await rm(vpnDir, { recursive: true, force: true });
  }
});
