import type { HtbClient, QueryValue } from "./client.js";
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

export interface PlayInfo {
  status: string | null;
  ip: string | null;
  ports: number[];
  expiresAt: string | null;
  raw: Record<string, unknown>;
}

export interface ChallengeCategory {
  id: number;
  name: string;
  icon: string | null;
  raw: Record<string, unknown>;
}

export interface ChallengeSummary {
  id: number;
  name: string;
  category: string | null;
  categoryId: number | null;
  difficulty: string | null;
  points: number | null;
  state: string | null;
  retired: boolean | null;
  solves: number | null;
  rating: number | null;
  owned: boolean;
  todo: boolean;
  hasDownload: boolean | null;
  hasDocker: boolean | null;
  releaseDate: string | null;
  raw: Record<string, unknown>;
}

export interface ChallengeDetails extends ChallengeSummary {
  description: string | null;
  creator: string | null;
  filePassword: string | null;
  fileName: string | null;
  fileSize: string | null;
  sha256: string | null;
  dockerStatus: string | null;
  dockerIp: string | null;
  dockerPorts: number[];
  playInfo: PlayInfo | null;
}

export interface DownloadLink {
  url: string;
  expiresIn: number | null;
  raw: Record<string, unknown>;
}

export interface SherlockSummary {
  id: number;
  name: string;
  category: string | null;
  categoryId: number | null;
  difficulty: string | null;
  state: string | null;
  solves: number | null;
  rating: number | null;
  owned: boolean;
  progress: number | null;
  releaseDate: string | null;
  raw: Record<string, unknown>;
}

export interface SherlockDetails extends SherlockSummary {
  description: string | null;
  scenario: string | null;
  creators: string[];
  fileName: string | null;
  fileSize: string | null;
  filePassword: string | null;
  academyModules: Record<string, unknown>[];
  playInfo: PlayInfo | null;
  blood: Record<string, unknown> | null;
  userOwnsCount: number | null;
  isOwned: boolean;
  ownRank: number | null;
  tasksAnswered: number | null;
  totalTasks: number | null;
}

export interface SherlockTask {
  id: number;
  title: string | null;
  description: string | null;
  hint: string | null;
  completed: boolean;
  maskedFlag: string | null;
  taskType: string | null;
  taskTypeId: number | null;
  options: unknown[];
  prerequisiteId: number | null;
  raw: Record<string, unknown>;
}

export interface SherlockProgress {
  isOwned: boolean;
  ownRank: number | null;
  progress: number | null;
  tasksAnswered: number | null;
  totalTasks: number | null;
  raw: Record<string, unknown>;
}

export interface ChallengeListResult {
  challenges: ChallengeSummary[];
  meta: Record<string, unknown>;
}

export interface SherlockListResult {
  sherlocks: SherlockSummary[];
  meta: Record<string, unknown>;
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
    difficulty?: string | undefined;
    os?: string | undefined;
    keyword?: string | undefined;
    page?: number | undefined;
    perPage?: number | undefined;
    free?: boolean | undefined;
    todo?: boolean | undefined;
    completed?: "complete" | "incomplete" | undefined;
    sortBy?: string | undefined;
    sortType?: "asc" | "desc" | undefined;
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

  async waitForNoActiveMachine(
    timeoutMs: number,
    intervalMs = 2_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const active = await this.getActiveMachine();
      if (!active) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(intervalMs);
    } while (Date.now() < deadline);
    return false;
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
    const endpoint =
      protocol === "udp"
        ? `/access/ovpnfile/${serverId}/0`
        : `/access/ovpnfile/${serverId}/0/1`;
    const content = await this.client.get<string>(endpoint, {
      responseType: "text",
    });

    if (!isOpenVpnProfile(content)) {
      throw new HtbError({
        code: "INVALID_RESPONSE",
        message: "HTB returned a response that does not look like an OpenVPN profile.",
        endpoint,
        hint: "Call htb_vpn_servers to verify the assigned server, then retry.",
      });
    }

    return { serverId, product, protocol, endpoint, content };
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
    difficulty?: string | undefined;
    category?: number | undefined;
    keyword?: string | undefined;
    completed?: "complete" | "incompleted" | undefined;
    todo?: boolean | undefined;
    sortBy?: string | undefined;
    sortType?: "asc" | "desc" | undefined;
    page?: number | undefined;
    perPage?: number | undefined;
  }): Promise<ChallengeListResult> {
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
        todo: input.todo ? 1 : undefined,
        sort_by: input.sortBy,
        sort_type: input.sortType,
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

  async listChallengeCategories(): Promise<ChallengeCategory[]> {
    const response = await this.client.get<unknown>("/challenge/categories/list");
    return normalizeCategories(response);
  }

  async getChallenge(target: string): Promise<ChallengeDetails> {
    const response = await this.client.get<{
      challenge?: Record<string, unknown>;
    }>(`/challenge/info/${encodeURIComponent(target)}`);
    if (!response.challenge) {
      throw new HtbError({
        code: "NOT_FOUND",
        message: `Challenge "${target}" was not found.`,
      });
    }
    return normalizeChallengeDetails(response.challenge);
  }

  async resolveChallenge(
    target: string | number,
  ): Promise<{ id: number; name: string; raw: Record<string, unknown> }> {
    const text = String(target).trim();
    if (/^\d+$/.test(text)) {
      const challenge = await this.getChallenge(text);
      return { id: challenge.id, name: challenge.name, raw: challenge.raw };
    }

    const variants = uniqueStrings([text, slugify(text)]);
    for (const variant of variants) {
      try {
        const challenge = await this.getChallenge(variant);
        return { id: challenge.id, name: challenge.name, raw: challenge.raw };
      } catch (error) {
        if (!(error instanceof HtbError) || error.code !== "NOT_FOUND") {
          throw error;
        }
      }
    }

    const matches = await this.listChallenges({
      state: "all",
      keyword: text,
      perPage: 100,
    });
    const exact = matches.challenges.find(
      (challenge) => challenge.name.toLowerCase() === text.toLowerCase(),
    );
    if (exact) {
      return { id: exact.id, name: exact.name, raw: exact.raw };
    }

    const partial = matches.challenges.filter((challenge) =>
      challenge.name.toLowerCase().includes(text.toLowerCase()),
    );
    if (partial.length === 1 && partial[0]) {
      return { id: partial[0].id, name: partial[0].name, raw: partial[0].raw };
    }

    throw new HtbError({
      code: "NOT_FOUND",
      message: `No challenge named "${text}" was found.`,
      hint:
        partial.length > 1
          ? `Did you mean: ${partial
              .slice(0, 5)
              .map((challenge) => challenge.name)
              .join(", ")}?`
          : "Use htb_list_challenges to search the catalogue.",
    });
  }

  async startChallengeContainer(
    challengeId: number,
  ): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/container/start", {
      body: { containerable_id: challengeId },
    });
  }

  async stopChallengeContainer(
    challengeId: number,
  ): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/container/stop", {
      body: { containerable_id: challengeId },
    });
  }

  async waitForChallengeContainer(
    challengeId: number,
    timeoutMs: number,
    intervalMs = 3_000,
  ): Promise<ChallengeDetails> {
    const deadline = Date.now() + timeoutMs;
    let latest = await this.getChallenge(String(challengeId));

    do {
      if (challengeContainerReady(latest)) {
        return latest;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(intervalMs);
      latest = await this.getChallenge(String(challengeId));
    } while (Date.now() < deadline);

    return latest;
  }

  async getChallengeDownloadLink(challengeId: number): Promise<DownloadLink> {
    const endpoint = `/challenges/${challengeId}/download_link`;
    const response = await this.client.get<unknown>(endpoint);
    return normalizeDownloadLink(response, endpoint);
  }

  async submitChallengeFlag(
    challengeId: number,
    flag: string,
  ): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>("/challenge/own", {
      body: { challenge_id: challengeId, flag },
    });
  }

  async listSherlocks(input: {
    state: "active" | "retired" | "unreleased" | "all";
    difficulty?: string | undefined;
    category?: number | undefined;
    keyword?: string | undefined;
    completed?: "complete" | "incompleted" | undefined;
    sortBy?: string | undefined;
    sortType?: "asc" | "desc" | undefined;
    page?: number | undefined;
    perPage?: number | undefined;
  }): Promise<SherlockListResult> {
    const states =
      input.state === "all"
        ? ["active", "retired"]
        : [input.state];
    const response = await this.client.get<{
      data?: unknown[];
      meta?: Record<string, unknown>;
    }>("/sherlocks", {
      query: {
        page: input.page ?? 1,
        per_page: input.perPage ?? 25,
        status: input.completed,
        state: states,
        "difficulty[]": input.difficulty,
        "category[]": input.category,
        keyword: input.keyword,
        sort_by: input.sortBy,
        sort_type: input.sortType,
      },
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return {
      sherlocks: data.filter(isRecord).map(normalizeSherlockSummary),
      meta: response.meta ?? {},
    };
  }

  async listSherlockCategories(): Promise<ChallengeCategory[]> {
    const response = await this.client.get<unknown>("/sherlocks/categories/list");
    return normalizeCategories(response);
  }

  async resolveSherlock(
    target: string | number,
  ): Promise<{ id: number; name: string; raw: Record<string, unknown> }> {
    const text = String(target).trim();
    if (/^\d+$/.test(text)) {
      const named = await this.getSherlockNamed(text);
      return {
        id: numberOrNull(named.id) ?? Number(text),
        name: stringOrNull(named.name) ?? `sherlock-${text}`,
        raw: named,
      };
    }

    const variants = uniqueStrings([text, slugify(text)]);
    for (const variant of variants) {
      try {
        const named = await this.getSherlockNamed(variant);
        const id = numberOrNull(named.id);
        if (id === null) {
          continue;
        }
        return {
          id,
          name: stringOrNull(named.name) ?? variant,
          raw: named,
        };
      } catch (error) {
        if (!(error instanceof HtbError) || error.code !== "NOT_FOUND") {
          throw error;
        }
      }
    }

    const matches = await this.listSherlocks({
      state: "all",
      keyword: text,
      perPage: 100,
    });
    const exact = matches.sherlocks.find(
      (sherlock) => sherlock.name.toLowerCase() === text.toLowerCase(),
    );
    if (exact) {
      return { id: exact.id, name: exact.name, raw: exact.raw };
    }

    const partial = matches.sherlocks.filter((sherlock) =>
      sherlock.name.toLowerCase().includes(text.toLowerCase()),
    );
    if (partial.length === 1 && partial[0]) {
      return { id: partial[0].id, name: partial[0].name, raw: partial[0].raw };
    }

    throw new HtbError({
      code: "NOT_FOUND",
      message: `No Sherlock named "${text}" was found.`,
      hint:
        partial.length > 1
          ? `Did you mean: ${partial
              .slice(0, 5)
              .map((sherlock) => sherlock.name)
              .join(", ")}?`
          : "Use htb_list_sherlocks to search the catalogue.",
    });
  }

  async getSherlockNamed(target: string): Promise<Record<string, unknown>> {
    const response = await this.client.get<{ data?: Record<string, unknown> }>(
      `/sherlocks/${encodeURIComponent(target)}`,
    );
    if (!response.data) {
      throw new HtbError({
        code: "NOT_FOUND",
        message: `Sherlock "${target}" was not found.`,
      });
    }
    return response.data;
  }

  async getSherlockInfo(sherlockId: number): Promise<Record<string, unknown>> {
    const response = await this.client.get<{ data?: Record<string, unknown> }>(
      `/sherlocks/${sherlockId}/info`,
    );
    return response.data ?? {};
  }

  async getSherlockPlay(sherlockId: number): Promise<Record<string, unknown>> {
    const response = await this.client.get<{ data?: Record<string, unknown> }>(
      `/sherlocks/${sherlockId}/play`,
    );
    return response.data ?? {};
  }

  async getSherlockProgress(
    sherlockId: number,
  ): Promise<SherlockProgress> {
    const response = await this.client.get<{ data?: Record<string, unknown> }>(
      `/sherlocks/${sherlockId}/progress`,
    );
    return normalizeSherlockProgress(response.data ?? {});
  }

  async getSherlockTasks(sherlockId: number): Promise<SherlockTask[]> {
    const response = await this.client.get<{ data?: unknown[] }>(
      `/sherlocks/${sherlockId}/tasks`,
    );
    return Array.isArray(response.data)
      ? response.data.filter(isRecord).map(normalizeSherlockTask)
      : [];
  }

  async getSherlock(target: string | number): Promise<SherlockDetails> {
    const resolved = await this.resolveSherlock(target);
    const [info, play, progress] = await Promise.allSettled([
      this.getSherlockInfo(resolved.id),
      this.getSherlockPlay(resolved.id),
      this.getSherlockProgress(resolved.id),
    ]);

    const results = [info, play, progress];
    if (results.every((result) => result.status === "rejected")) {
      throw results[0]?.status === "rejected"
        ? results[0].reason
        : new HtbError({
            code: "API_ERROR",
            message: `Could not load Sherlock "${resolved.name}".`,
          });
    }

    const summary = normalizeSherlockSummary(resolved.raw);
    const infoData = info.status === "fulfilled" ? info.value : {};
    const playData = play.status === "fulfilled" ? play.value : {};
    const progressData =
      progress.status === "fulfilled" ? progress.value : null;

    return {
      ...summary,
      description: stringOrNull(infoData.description),
      scenario: stringOrNull(playData.scenario),
      creators: normalizeCreators(playData.creators),
      fileName: stringOrNull(playData.file_name),
      fileSize: stringOrNull(playData.file_size),
      filePassword: stringOrNull(
        resolved.raw.file_password ?? playData.file_password,
      ),
      academyModules: Array.isArray(infoData.academyModules)
        ? infoData.academyModules.filter(isRecord)
        : [],
      playInfo: normalizePlayInfo(playData.play_info),
      blood: isRecord(playData.blood) ? playData.blood : null,
      userOwnsCount: numberOrNull(infoData.user_owns_count),
      isOwned: progressData?.isOwned ?? summary.owned,
      ownRank: progressData?.ownRank ?? null,
      tasksAnswered: progressData?.tasksAnswered ?? null,
      totalTasks: progressData?.totalTasks ?? null,
    };
  }

  async getSherlockDownloadLink(sherlockId: number): Promise<DownloadLink> {
    const endpoint = `/sherlocks/${sherlockId}/download_link`;
    const response = await this.client.get<unknown>(endpoint);
    return normalizeDownloadLink(response, endpoint);
  }

  async submitSherlockTask(
    sherlockId: number,
    taskId: number,
    flag: string,
  ): Promise<Record<string, unknown>> {
    return this.client.post<Record<string, unknown>>(
      `/sherlocks/${sherlockId}/tasks/${taskId}/flag`,
      { body: { flag } },
    );
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

function normalizeChallengeSummary(raw: Record<string, unknown>): ChallengeSummary {
  return {
    id: numberOrNull(raw.id) ?? 0,
    name: stringOrNull(raw.name) ?? "unknown",
    category: stringOrNull(raw.category_name),
    categoryId: numberOrNull(raw.category_id),
    difficulty: stringOrNull(raw.difficulty),
    points: numberOrNull(raw.points),
    state: stringOrNull(raw.state),
    retired: booleanOrNull(raw.retired),
    solves: numberOrNull(raw.solves),
    rating: numberOrNull(raw.rating ?? raw.stars),
    owned: Boolean(raw.is_owned || raw.authUserSolve),
    todo: Boolean(raw.isTodo ?? raw.todo),
    hasDownload: booleanOrNull(raw.download),
    hasDocker: booleanOrNull(raw.docker),
    releaseDate: stringOrNull(raw.release_date ?? raw.release_at),
    raw,
  };
}

function normalizeChallengeDetails(raw: Record<string, unknown>): ChallengeDetails {
  return {
    ...normalizeChallengeSummary(raw),
    description: stringOrNull(raw.description),
    creator: stringOrNull(raw.creator_name),
    filePassword: stringOrNull(raw.file_password),
    fileName: stringOrNull(raw.file_name),
    fileSize: stringOrNull(raw.file_size),
    sha256: stringOrNull(raw.sha256),
    dockerStatus: stringOrNull(raw.docker_status),
    dockerIp: stringOrNull(raw.docker_ip),
    dockerPorts: numberArray(raw.docker_ports),
    playInfo: normalizePlayInfo(raw.play_info),
  };
}

function normalizeSherlockSummary(raw: Record<string, unknown>): SherlockSummary {
  return {
    id: numberOrNull(raw.id) ?? 0,
    name: stringOrNull(raw.name) ?? "unknown",
    category: stringOrNull(raw.category_name),
    categoryId: numberOrNull(raw.category_id),
    difficulty: stringOrNull(raw.difficulty),
    state: stringOrNull(raw.state),
    solves: numberOrNull(raw.solves),
    rating: numberOrNull(raw.rating),
    owned: Boolean(raw.is_owned),
    progress: numberOrNull(raw.progress),
    releaseDate: stringOrNull(raw.release_date ?? raw.release_at),
    raw,
  };
}

function normalizeSherlockTask(raw: Record<string, unknown>): SherlockTask {
  const taskType = isRecord(raw.task_type ?? raw.type)
    ? (raw.task_type ?? raw.type) as Record<string, unknown>
    : null;
  return {
    id: numberOrNull(raw.id) ?? 0,
    title: stringOrNull(raw.title),
    description: stringOrNull(raw.description),
    hint: stringOrNull(raw.hint),
    completed: Boolean(raw.completed),
    maskedFlag: stringOrNull(raw.masked_flag),
    taskType: stringOrNull(taskType?.text),
    taskTypeId: numberOrNull(taskType?.id),
    options: Array.isArray(raw.options) ? raw.options : [],
    prerequisiteId: numberOrNull(raw.prerequisite_id),
    raw,
  };
}

function normalizeSherlockProgress(raw: Record<string, unknown>): SherlockProgress {
  return {
    isOwned: Boolean(raw.is_owned),
    ownRank: numberOrNull(raw.own_rank),
    progress: numberOrNull(raw.progress),
    tasksAnswered: numberOrNull(raw.tasks_answered),
    totalTasks: numberOrNull(raw.total_tasks),
    raw,
  };
}

function normalizeCategories(value: unknown): ChallengeCategory[] {
  const info =
    isRecord(value) && Array.isArray(value.info)
      ? value.info
      : Array.isArray(value)
        ? value
        : [];
  return info
    .filter(isRecord)
    .map((raw) => ({
      id: numberOrNull(raw.id) ?? 0,
      name: stringOrNull(raw.name) ?? "unknown",
      icon: stringOrNull(raw.icon),
      raw,
    }))
    .filter((category) => category.id > 0);
}

function normalizeDownloadLink(value: unknown, endpoint: string): DownloadLink {
  const record = isRecord(value) ? value : {};
  const data = isRecord(record.data) ? record.data : record;
  const url = stringOrNull(data.url ?? data.download_url);
  if (!url) {
    throw new HtbError({
      code: "INVALID_RESPONSE",
      message: "HTB did not return a download URL.",
      endpoint,
      hint: "The resource may have no downloadable files, or the link endpoint changed.",
    });
  }
  return {
    url,
    expiresIn: numberOrNull(data.expires_in ?? data.expiresIn),
    raw: record,
  };
}

function normalizePlayInfo(value: unknown): PlayInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    status: stringOrNull(value.status),
    ip: stringOrNull(value.ip),
    ports: numberArray(value.ports),
    expiresAt: stringOrNull(value.expires_at),
    raw: value,
  };
}

function normalizeCreators(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((creator) =>
      isRecord(creator)
        ? stringOrNull(creator.name ?? creator.username)
        : stringOrNull(creator),
    )
    .filter((creator): creator is string => creator !== null);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => numberOrNull(item))
    .filter((item): item is number => item !== null);
}

function challengeContainerReady(challenge: ChallengeDetails): boolean {
  const ip = challenge.playInfo?.ip ?? challenge.dockerIp;
  const ports = challenge.playInfo?.ports.length
    ? challenge.playInfo.ports
    : challenge.dockerPorts;
  const status = (
    challenge.playInfo?.status ??
    challenge.dockerStatus ??
    ""
  ).toLowerCase();
  const inactive = /expired|stopped|terminated|failed|error/.test(status);
  return Boolean(ip) && ports.length > 0 && !inactive;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
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
