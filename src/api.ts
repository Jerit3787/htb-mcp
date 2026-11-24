import type { ApiVersion, HtbClient, QueryValue } from "./client.js";
import { HtbError } from "./errors.js";

export interface ActiveMachine {
  id: number;
  name: string;
  ip: string | null;
  isSpawning: boolean;
  expiresAt: string | null;
  type: string | null;
  labServer: string | null;
  vpnServerId: number | null;
  vpnServerType: string | null;
  raw: Record<string, unknown>;
}

export interface MachineSummary {
  id: number;
  name: string;
  os: string | null;
  difficulty: string | null;
  points: number | null;
  state: string | null;
  free: boolean | null;
  active: boolean | null;
  retired: boolean | null;
  ip: string | null;
  userOwned: boolean;
  rootOwned: boolean;
  todo: boolean;
  rating: number | null;
  releaseDate: string | null;
  raw: Record<string, unknown>;
}

export interface MachineDetails extends MachineSummary {
  description: string | null;
  maker: string | null;
  userOwns: number | null;
  rootOwns: number | null;
  playInfo: Record<string, unknown> | null;
}

export interface VpnServer {
  id: number;
  name: string;
  location: string | null;
  tier: string | null;
  currentClients: number | null;
  full: boolean;
  product: string | null;
  assigned: boolean;
  raw: Record<string, unknown>;
}

export interface VpnConnection {
  type: string;
  locationTypeFriendly: string | null;
  assignedServer: VpnServer | null;
  machine: { id: number | null; name: string | null } | null;
  proLab: { id: number | null; name: string | null } | null;
  available: boolean | null;
  raw: Record<string, unknown>;
}

export interface UserSummary {
  id: number | null;
  name: string | null;
  email: string | null;
  rankId: number | null;
  isVip: boolean | null;
  team: string | null;
  subscription: string | null;
  raw: Record<string, unknown>;
}

export interface VpnConfigResult {
  serverId: number;
  product: string;
  protocol: "udp" | "tcp";
  endpoint: string;
  content: string;
}

export interface MachineResolution {
  id: number;
  name: string;
  raw?: Record<string, unknown>;
}

interface MachinesResponse {
  data?: unknown[];
  meta?: Record<string, unknown>;
}

interface ProfileResponse {
  info?: Record<string, unknown>;
}

export class HtbApi {
  readonly client: HtbClient;

  constructor(client: HtbClient) {
    this.client = client;
  }

  async getUser(): Promise<UserSummary> {
    const response = await this.client.get<ProfileResponse>("/user/info");
    const info = response.info ?? {};
    const team =
      info.team && typeof info.team === "object"
        ? ((info.team as Record<string, unknown>).name as string | undefined)
        : undefined;

    return {
      id: numberOrNull(info.id),
      name: stringOrNull(info.name),
      email: stringOrNull(info.email),
      rankId: numberOrNull(info.rank_id),
      isVip: booleanOrNull(info.isVip),
      team: team ?? null,
      subscription: stringOrNull(info.subscriptionType ?? info.subscription_plan),
      raw: info,
    };
  }

  async getActiveMachine(): Promise<ActiveMachine | null> {
    try {
      const response = await this.client.get<{ info?: Record<string, unknown> | null }>(
        "/virtual_machine/active",
        { version: "v5" },
      );
      const info = response.info;
      return info ? normalizeActiveMachine(info) : null;
    } catch (error) {
      if (error instanceof HtbError && error.code === "NOT_FOUND") {
        const response = await this.client.get<{ info?: Record<string, unknown> | null }>(
          "/machine/active",
        );
        return response.info ? normalizeActiveMachine(response.info) : null;
      }
      throw error;
    }
  }

  async listMachines(input: {
    state: "active" | "retired" | "unreleased" | "all";
    difficulty?: string;
    os?: string;
    keyword?: string;
    page?: number;
    perPage?: number;
    free?: boolean;
    todo?: boolean;
    completed?: "complete" | "incomplete";
    sortBy?: string;
    sortType?: "asc" | "desc";
  }): Promise<{ machines: MachineSummary[]; meta: Record<string, unknown> }> {
    const query: Record<string, QueryValue> = {
      page: input.page ?? 1,
      per_page: input.perPage ?? 25,
      "difficulty[]": input.difficulty,
      "os[]": input.os,
      keyword: input.keyword,
      free: input.free === undefined ? undefined : input.free ? 1 : 0,
      todo: input.todo ? 1 : undefined,
      show_completed: input.completed,
      sort_by: input.sortBy,
      sort_type: input.sortType,
    };

    const states =
      input.state === "all"
        ? ["active", "retired"]
        : input.state === "active"
          ? ["active"]
          : [input.state];
    query.state = states;

    const response = await this.client.get<MachinesResponse>("/machines", {
      version: "v5",
      query,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return {
      machines: data
        .filter(isRecord)
        .map(normalizeMachineSummary),
      meta: response.meta ?? {},
    };
  }

  async searchMachines(keyword: string): Promise<MachineSummary[]> {
    const { machines } = await this.listMachines({
      state: "all",
      keyword,
      perPage: 100,
    });
    return machines;
  }

  async resolveMachine(target: string | number): Promise<MachineResolution> {
    if (typeof target === "number" || /^\d+$/.test(target)) {
      return this.resolveMachineById(Number(target));
    }

    const matches = await this.searchMachines(target);
    const exact = matches.find(
      (machine) => machine.name.toLowerCase() === target.trim().toLowerCase(),
    );
    if (exact) {
      return { id: exact.id, name: exact.name, raw: exact.raw };
    }

    const partial = matches.filter((machine) =>
      machine.name.toLowerCase().includes(target.trim().toLowerCase()),
    );
    if (partial.length === 1 && partial[0]) {
      return { id: partial[0].id, name: partial[0].name, raw: partial[0].raw };
    }

    try {
      const profile = await this.getMachineProfile(target);
      return { id: profile.id, name: profile.name, raw: profile.raw };
    } catch {
      // Fall through to the helpful error below.
    }

    throw new HtbError({
      code: "NOT_FOUND",
      message: `No machine named "${target}" was found.`,
      hint:
        partial.length > 1
          ? `Did you mean: ${partial
              .slice(0, 5)
              .map((machine) => machine.name)
              .join(", ")}?`
          : "Use htb_list_machines to search the catalogue.",
    });
  }

  private async resolveMachineById(id: number): Promise<MachineResolution> {
    try {
      const profile = await this.getMachineProfile(String(id));
      return { id: profile.id, name: profile.name, raw: profile.raw };
    } catch (error) {
      if (!(error instanceof HtbError) || error.code !== "NOT_FOUND") {
        throw error;
      }
      return { id, name: `machine-${id}` };
    }
  }

  async getMachineProfile(target: string): Promise<MachineDetails> {
    const response = await this.client.get<ProfileResponse>(
      `/machine/profile/${encodeURIComponent(target)}`,
    );
    const info = response.info;
    if (!info) {
      throw new HtbError({
        code: "NOT_FOUND",
        message: `Machine "${target}" was not found.`,
      });
    }

    const playInfo = isRecord(info.playInfo) ? info.playInfo : null;
    const maker = isRecord(info.maker) ? stringOrNull(info.maker.name) : null;

    return {
      ...normalizeMachineSummary(info),
      description: stringOrNull(info.synopsis),
      maker,
      userOwns: numberOrNull(info.user_owns_count),
      rootOwns: numberOrNull(info.root_owns_count),
      playInfo,
    };
  }

  async spawnMachine(machineId: number): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/vm/spawn", {
      body: { machine_id: machineId },
    });
  }

  async terminateMachine(machineId?: number): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/vm/terminate", {
      body: { machine_id: machineId ?? null },
    });
  }

  async resetMachine(machineId: number): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/vm/reset", {
      body: { machine_id: machineId },
    });
  }

  async extendMachine(machineId: number): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/vm/extend", {
      body: { machine_id: machineId },
    });
  }

  async waitForActiveMachine(
    machineId: number,
    timeoutMs: number,
    intervalMs = 3_000,
  ): Promise<ActiveMachine | null> {
    const deadline = Date.now() + timeoutMs;
    let latest: ActiveMachine | null = null;

    do {
      latest = await this.getActiveMachine();
      if (
        latest &&
        latest.id === machineId &&
        latest.ip &&
        !latest.isSpawning
      ) {
        return latest;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(intervalMs);
    } while (Date.now() < deadline);

    return latest?.id === machineId ? latest : null;
  }

  async getConnections(): Promise<VpnConnection[]> {
    const response = await this.client.get<{ data?: unknown[] }>("/connections", {
      version: "v5",
    });
    return Array.isArray(response.data)
      ? response.data.filter(isRecord).map(normalizeVpnConnection)
      : [];
  }

  async getVpnServers(product: string): Promise<{
    servers: VpnServer[];
    assigned: VpnServer | null;
    connections: VpnConnection[];
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const [connectionsResult, serversResult] = await Promise.allSettled([
      this.getConnections(),
      this.client.get<{ data?: Record<string, unknown> }>("/connections/servers", {
        query: { product },
      }),
    ]);

    const connections =
      connectionsResult.status === "fulfilled" ? connectionsResult.value : [];
    if (connectionsResult.status === "rejected") {
      warnings.push(
        `Could not load current assignments: ${errorText(connectionsResult.reason)}`,
      );
    }

    const assignedConnection = connections.find(
      (connection) => connection.type === product && connection.assignedServer,
    );
    let assigned = assignedConnection?.assignedServer ?? null;
    let servers: VpnServer[] = [];

    if (serversResult.status === "fulfilled") {
      const data = serversResult.value.data ?? {};
      const flattened: Record<string, unknown>[] = [];
      flattenServers(data, flattened);
      const seen = new Set<number>();
      servers = flattened
        .map(normalizeVpnServer)
        .filter((server) => {
          if (seen.has(server.id)) {
            return false;
          }
          seen.add(server.id);
          return true;
        });

      if (!assigned) {
        const rawAssigned = isRecord(data.assigned) ? data.assigned : null;
        if (rawAssigned) {
          assigned = normalizeVpnServer(rawAssigned);
        }
      }
    } else {
      warnings.push(`Could not load VPN server options: ${errorText(serversResult.reason)}`);
      if (connections.length > 0) {
        servers = connections
          .map((connection) => connection.assignedServer)
          .filter((server): server is VpnServer => server !== null);
      }
    }

    const assignedId = assigned?.id;
    for (const server of servers) {
      server.assigned = server.id === assignedId;
    }

    if (assigned && !servers.some((server) => server.id === assigned.id)) {
      assigned.assigned = true;
      servers.unshift(assigned);
    }

    return { servers, assigned, connections, warnings };
  }

  async switchVpnServer(serverId: number): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>(
      `/connections/servers/switch/${serverId}`,
    );
  }

  async getVpnConfig(
    serverId: number,
    product = "labs",
    protocol: "udp" | "tcp" = "udp",
  ): Promise<VpnConfigResult> {
    const candidates =
      protocol === "udp"
        ? [
            `/access/ovpnfile/${serverId}/0`,
            `/access/ovpnfile/${serverId}/${product}/udp`,
            `/access/ovpnfile/${serverId}/udp`,
          ]
        : [
            `/access/ovpnfile/${serverId}/0/1`,
            `/access/ovpnfile/${serverId}/${product}/tcp`,
            `/access/ovpnfile/${serverId}/tcp`,
          ];

    let lastError: unknown;
    for (const endpoint of candidates) {
      try {
        const content = await this.client.get<string>(endpoint, {
          responseType: "text",
        });
        if (!isOpenVpnProfile(content)) {
          lastError = new HtbError({
            code: "INVALID_RESPONSE",
            message: "HTB returned a response that does not look like an OpenVPN profile.",
            endpoint,
          });
          continue;
        }
        return { serverId, product, protocol, endpoint, content };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof HtbError
      ? lastError
      : new HtbError({
          code: "VPN_ERROR",
          message: "Could not download an OpenVPN profile from HTB.",
        });
  }

  async getConnectionStatus(): Promise<Record<string, unknown>[]> {
    const response = await this.client.get<unknown>("/connection/status");
    return Array.isArray(response) ? response.filter(isRecord) : [];
  }

  async submitMachineFlag(
    machineId: number,
    flag: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.client.post<Record<string, unknown>>("/machine/own", {
        version: "v5",
        body: { id: machineId, flag },
      });
    } catch (error) {
      if (!(error instanceof HtbError) || error.code !== "NOT_FOUND") {
        throw error;
      }
      return this.client.post<Record<string, unknown>>("/machine/own", {
        body: { id: machineId, flag },
      });
    }
  }

  async listChallenges(input: {
    state: "active" | "retired" | "unreleased" | "all";
    difficulty?: string;
    category?: number;
    keyword?: string;
    completed?: "complete" | "incompleted";
    page?: number;
    perPage?: number;
  }): Promise<{ challenges: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    const states =
      input.state === "all"
        ? ["active", "retired"]
        : [input.state];
    const response = await this.client.get<{
      data?: unknown[];
      meta?: Record<string, unknown>;
    }>("/challenges", {
      query: {
        page: input.page ?? 1,
        per_page: input.perPage ?? 25,
        status: input.completed,
        state: states,
        "difficulty[]": input.difficulty,
        "category[]": input.category,
        keyword: input.keyword,
      },
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return {
      challenges: data
        .filter(isRecord)
        .map(normalizeChallengeSummary),
      meta: response.meta ?? {},
    };
  }

  async getChallenge(target: string): Promise<Record<string, unknown>> {
    const response = await this.client.get<{
      challenge?: Record<string, unknown>;
    }>(`/challenge/info/${encodeURIComponent(target)}`);
    if (!response.challenge) {
      throw new HtbError({
        code: "NOT_FOUND",
        message: `Challenge "${target}" was not found.`,
      });
    }
    return response.challenge;
  }

  async submitChallengeFlag(
    challengeId: number,
    flag: string,
  ): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/challenge/own", {
      body: { challenge_id: challengeId, flag },
    });
  }

  async getStatus(): Promise<{
    user: UserSummary | null;
    activeMachine: ActiveMachine | null;
    connections: VpnConnection[];
    errors: string[];
  }> {
    const [user, activeMachine, connections] = await Promise.allSettled([
      this.getUser(),
      this.getActiveMachine(),
      this.getConnections(),
    ]);
    const errors: string[] = [];

    if (user.status === "rejected") {
      errors.push(`user: ${errorText(user.reason)}`);
    }
    if (activeMachine.status === "rejected") {
      errors.push(`active machine: ${errorText(activeMachine.reason)}`);
    }
    if (connections.status === "rejected") {
      errors.push(`VPN connections: ${errorText(connections.reason)}`);
    }

    return {
      user: user.status === "fulfilled" ? user.value : null,
      activeMachine:
        activeMachine.status === "fulfilled" ? activeMachine.value : null,
      connections:
        connections.status === "fulfilled" ? connections.value : [],
      errors,
    };
  }

  apiVersion(): ApiVersion {
    return "v4";
  }
}

function normalizeActiveMachine(info: Record<string, unknown>): ActiveMachine {
  return {
    id: numberOrNull(info.id) ?? 0,
    name: stringOrNull(info.name) ?? "unknown",
    ip: stringOrNull(info.ip),
    isSpawning: Boolean(info.isSpawning),
    expiresAt: stringOrNull(info.expires_at),
    type: stringOrNull(info.type),
    labServer: stringOrNull(info.lab_server),
    vpnServerId: numberOrNull(info.vpn_server_id),
    vpnServerType: stringOrNull(info.vpn_server_type),
    raw: info,
  };
}

function normalizeMachineSummary(raw: Record<string, unknown>): MachineSummary {
  const playInfo = isRecord(raw.playInfo) ? raw.playInfo : {};
  return {
    id: numberOrNull(raw.id) ?? 0,
    name: stringOrNull(raw.name) ?? "unknown",
    os: stringOrNull(raw.os),
    difficulty: stringOrNull(raw.difficultyText ?? raw.difficulty),
    points: numberOrNull(raw.points ?? raw.static_points),
    state:
      stringOrNull(raw.state) ??
      (raw.retired === true ? "retired" : raw.active === true ? "active" : null),
    free: booleanOrNull(raw.free),
    active: booleanOrNull(raw.active ?? playInfo.isActive),
    retired: booleanOrNull(raw.retired),
    ip: stringOrNull(raw.ip),
    userOwned: Boolean(raw.authUserInUserOwns),
    rootOwned: Boolean(raw.authUserInRootOwns),
    todo: Boolean(raw.todo ?? raw.isTodo),
    rating: numberOrNull(raw.rating ?? raw.stars),
    releaseDate: stringOrNull(raw.releaseDate ?? raw.release),
    raw,
  };
}

function normalizeVpnConnection(raw: Record<string, unknown>): VpnConnection {
  const assigned = isRecord(raw.assigned_server)
    ? normalizeVpnServer(raw.assigned_server)
    : null;
  if (assigned) {
    assigned.assigned = true;
  }

  return {
    type: stringOrNull(raw.type) ?? "unknown",
    locationTypeFriendly: stringOrNull(raw.location_type_friendly),
    assignedServer: assigned,
    machine: isRecord(raw.machine)
      ? {
          id: numberOrNull(raw.machine.id),
          name: stringOrNull(raw.machine.name),
        }
      : null,
    proLab: isRecord(raw.pro_lab)
      ? {
          id: numberOrNull(raw.pro_lab.id),
          name: stringOrNull(raw.pro_lab.name),
        }
      : null,
    available: booleanOrNull(raw.available),
    raw,
  };
}

function normalizeVpnServer(raw: Record<string, unknown>): VpnServer {
  return {
    id: numberOrNull(raw.id) ?? 0,
    name:
      stringOrNull(raw.friendly_name ?? raw.name) ??
      `server-${numberOrNull(raw.id) ?? "unknown"}`,
    location: stringOrNull(raw.location),
    tier: stringOrNull(raw.location_type_friendly ?? raw.tier),
    currentClients: numberOrNull(raw.current_clients),
    full: Boolean(raw.full),
    product: stringOrNull(raw.product),
    assigned: Boolean(raw.is_assigned),
    raw,
  };
}

function normalizeChallengeSummary(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: numberOrNull(raw.id),
    name: stringOrNull(raw.name),
    category: stringOrNull(raw.category_name),
    difficulty: stringOrNull(raw.difficulty),
    state: stringOrNull(raw.state),
    solves: numberOrNull(raw.solves),
    rating: numberOrNull(raw.rating),
    owned: Boolean(raw.is_owned),
    releaseDate: stringOrNull(raw.release_date),
    raw,
  };
}

function flattenServers(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenServers(item, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (numberOrNull(value.id) !== null && stringOrNull(value.friendly_name ?? value.name)) {
    output.push(value);
  }

  for (const child of Object.values(value)) {
    if (child !== value) {
      flattenServers(child, output);
    }
  }
}

function isOpenVpnProfile(content: string): boolean {
  return (
    /^\s*client\b/m.test(content) &&
    /^\s*remote\s+\S+/m.test(content) &&
    !/^\s*\{/.test(content)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
