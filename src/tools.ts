import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  ActiveMachine,
  HtbApi,
  MachineSummary,
  VpnConnection,
  VpnServer,
} from "./api.js";
import type { AppConfig } from "./config.js";
import { HtbError, toHtbError } from "./errors.js";
import {
  connectOpenVpn,
  disconnectOpenVpn,
  getLocalVpnProcesses,
  resolveAndSaveVpnConfig,
  type LocalVpnProcess,
} from "./vpn.js";

interface ToolContext {
  api: HtbApi;
  config: AppConfig;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const targetSchema = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe("Machine or challenge name/slug, or numeric ID.");

const productSchema = z
  .enum(["labs", "starting_point", "competitive", "fortresses", "prolab"])
  .default("labs")
  .describe("HTB VPN product. Lab machines use 'labs'.");

const protocolSchema = z
  .enum(["udp", "tcp"])
  .default("udp")
  .describe("OpenVPN transport protocol.");

const difficultySchema = z
  .enum(["easy", "medium", "hard", "insane"])
  .optional()
  .describe("Machine difficulty filter.");

const osSchema = z
  .enum(["linux", "windows", "freebsd", "openbsd", "other"])
  .optional()
  .describe("Operating system filter.");

export function registerTools(server: McpServer, context: ToolContext): void {
  const { api, config } = context;

  server.registerTool(
    "htb_status",
    {
      title: "HTB account and lab status",
      description:
        "Check authentication, account summary, active machine (IP/expiry), and current VPN assignments. Start here when something fails.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(async () => {
      const status = await api.getStatus();
      return {
        api: config.labsUrl,
        user: status.user,
        activeMachine: status.activeMachine
          ? activeMachineView(status.activeMachine)
          : null,
        vpnAssignments: status.connections.map(connectionView),
        errors: status.errors,
      };
    }),
  );

  server.registerTool(
    "htb_list_machines",
    {
      title: "List Hack The Box machines",
      description:
        "Search and filter machines by state, difficulty, OS, name, free/VIP, and completion. Returns compact machine summaries with pagination metadata.",
      inputSchema: {
        state: z
          .enum(["active", "retired", "unreleased", "all"])
          .default("active")
          .describe("Catalogue state. Use 'all' to search active and retired machines."),
        difficulty: difficultySchema,
        os: osSchema,
        keyword: z.string().min(1).optional().describe("Name search string."),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(5).max(100).default(25),
        free: z.boolean().optional().describe("Filter to free (true) or paid (false) machines."),
        todo: z.boolean().default(false).describe("Only machines marked as todo."),
        completed: z.enum(["complete", "incomplete"]).optional(),
        sort_by: z
          .enum(["release_date", "name", "user_owns", "system_owns", "rating", "user_difficulty"])
          .optional(),
        sort_type: z.enum(["asc", "desc"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const result = await api.listMachines({
        state: args.state,
        difficulty: args.difficulty,
        os: args.os,
        keyword: args.keyword,
        page: args.page,
        perPage: args.per_page,
        free: args.free,
        todo: args.todo,
        completed: args.completed,
        sortBy: args.sort_by,
        sortType: args.sort_type,
      });
      return {
        machines: result.machines.map(machineView),
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "htb_get_machine",
    {
      title: "Get machine details",
      description:
        "Get a machine's profile by name or ID, including OS, difficulty, points, ownership, maker, and active play info.",
      inputSchema: {
        target: targetSchema,
        include_raw: z.boolean().default(false).describe("Include the raw HTB profile payload."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const machine = await api.resolveMachine(args.target);
      const details = await api.getMachineProfile(String(machine.id));
      return {
        ...machineView(details),
        description: details.description,
        maker: details.maker,
        userOwns: details.userOwns,
        rootOwns: details.rootOwns,
        playInfo: details.playInfo,
        ...(args.include_raw ? { raw: details.raw } : {}),
      };
    }),
  );

  server.registerTool(
    "htb_launch_machine",
    {
      title: "Spawn a machine",
      description:
        "Spawn an active or retired machine and wait for its IP. If another machine is active, set replace=true to terminate it first. HTB limits machine actions to roughly one per minute.",
      inputSchema: {
        target: targetSchema,
        wait_seconds: z
          .number()
          .int()
          .min(5)
          .max(300)
          .default(90)
          .describe("How long to wait for an IP before returning a spawning status."),
        replace: z
          .boolean()
          .default(false)
          .describe("Terminate a different active machine before spawning."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const machine = await api.resolveMachine(args.target);
      const active = await api.getActiveMachine();

      if (active && active.id === machine.id) {
        if (active.ip && !active.isSpawning) {
          return {
            action: "already_active",
            machine: activeMachineView(active),
            message: `Machine "${active.name}" is already running at ${active.ip}.`,
          };
        }
        const ready = await api.waitForActiveMachine(machine.id, args.wait_seconds * 1000);
        const current = ready ?? active;
        return {
          action: ready?.ip ? "already_active" : "spawning",
          machine: activeMachineView(current),
          message: ready?.ip
            ? `Machine "${ready.name}" is ready at ${ready.ip}.`
            : "Machine is still spawning. Call htb_status for an update.",
        };
      }

      if (active && active.id !== machine.id) {
        if (!args.replace) {
          throw new HtbError({
            code: "CONFLICT",
            message: `Machine "${active.name}" is already active.`,
            hint: "Stop it first with htb_stop_machine, or pass replace: true to terminate it automatically.",
          });
        }
        await api.terminateMachine(active.id);
        const cleared = await api.waitForNoActiveMachine(30_000);
        if (!cleared) {
          throw new HtbError({
            code: "CONFLICT",
            message: `Could not terminate "${active.name}" before spawning.`,
            hint: "Check htb_status, then retry.",
          });
        }
      }

      const spawnResponse = await api.spawnMachine(machine.id);
      assertActionSucceeded(spawnResponse, "spawn the machine");
      const ready = await api.waitForActiveMachine(machine.id, args.wait_seconds * 1000);

      if (ready?.ip && !ready.isSpawning) {
        return {
          action: "spawned",
          machine: activeMachineView(ready),
          spawnResponse,
        };
      }

      return {
        action: "spawning",
        machine: ready ? activeMachineView(ready) : null,
        spawnResponse,
        message:
          "HTB accepted the spawn, but no IP was available before the timeout. Call htb_status in a few seconds.",
      };
    }),
  );

  server.registerTool(
    "htb_stop_machine",
    {
      title: "Terminate the active machine",
      description:
        "Terminate the currently active machine. Optionally verify a target first. This ends the machine session immediately.",
      inputSchema: {
        target: targetSchema.optional().describe("Optional machine to check before terminating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const active = await api.getActiveMachine();
      if (!active) {
        return { action: "no_active_machine", message: "No machine is currently active." };
      }

      if (args.target !== undefined) {
        const target = await api.resolveMachine(args.target);
        if (target.id !== active.id) {
          throw new HtbError({
            code: "CONFLICT",
            message: `The active machine is "${active.name}", not "${target.name}".`,
            hint: "Omit target to stop whatever is active.",
          });
        }
      }

      const response = await api.terminateMachine(active.id);
      assertActionSucceeded(response, "terminate the machine");
      return {
        action: "terminated",
        machine: activeMachineView(active),
        response,
      };
    }),
  );

  server.registerTool(
    "htb_reset_machine",
    {
      title: "Reset the active machine",
      description:
        "Request a reset of the active machine. HTB applies a cooldown between machine actions; the reset can take a minute.",
      inputSchema: {
        target: targetSchema.optional().describe("Optional machine to check before resetting."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const active = await api.getActiveMachine();
      if (!active) {
        throw new HtbError({
          code: "CONFLICT",
          message: "No machine is active, so there is nothing to reset.",
          hint: "Spawn a machine with htb_launch_machine first.",
        });
      }

      if (args.target !== undefined) {
        const target = await api.resolveMachine(args.target);
        if (target.id !== active.id) {
          throw new HtbError({
            code: "CONFLICT",
            message: `The active machine is "${active.name}", not "${target.name}".`,
          });
        }
      }

      const response = await api.resetMachine(active.id);
      assertActionSucceeded(response, "reset the machine");
      return {
        action: "reset_requested",
        machine: activeMachineView(active),
        response,
      };
    }),
  );

  server.registerTool(
    "htb_extend_machine",
    {
      title: "Extend the active machine",
      description:
        "Extend the active machine's lifetime by 24 hours. Returns HTB's new expiration date.",
      inputSchema: {
        target: targetSchema.optional().describe("Optional machine to check before extending."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => run(async () => {
      const active = await api.getActiveMachine();
      if (!active) {
        throw new HtbError({
          code: "CONFLICT",
          message: "No machine is active, so there is nothing to extend.",
        });
      }

      if (args.target !== undefined) {
        const target = await api.resolveMachine(args.target);
        if (target.id !== active.id) {
          throw new HtbError({
            code: "CONFLICT",
            message: `The active machine is "${active.name}", not "${target.name}".`,
          });
        }
      }

      const response = await api.extendMachine(active.id);
      assertActionSucceeded(response, "extend the machine");
      return {
        action: "extended",
        machine: activeMachineView(active),
        response,
      };
    }),
  );

  server.registerTool(
    "htb_vpn_servers",
    {
      title: "List VPN servers",
      description:
        "List available VPN servers, client counts, full status, and the server currently assigned to each HTB product.",
      inputSchema: { product: productSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const result = await api.getVpnServers(args.product);
      return {
        product: args.product,
        assigned: result.assigned ? vpnServerView(result.assigned) : null,
        servers: [...result.servers]
          .sort(
            (a, b) =>
              (a.currentClients ?? Number.MAX_SAFE_INTEGER) -
              (b.currentClients ?? Number.MAX_SAFE_INTEGER),
          )
          .map(vpnServerView),
        assignments: result.connections.map((connection) => ({
          type: connection.type,
          location: connection.locationTypeFriendly,
          server: connection.assignedServer
            ? vpnServerView(connection.assignedServer)
            : null,
          machine: connection.machine,
          proLab: connection.proLab,
          available: connection.available,
        })),
        warnings: result.warnings,
      };
    }),
  );

  server.registerTool(
    "htb_vpn_switch",
    {
      title: "Switch VPN server",
      description:
        "Assign your account to another VPN server. HTB may terminate an active machine when the server changes, so this tool refuses unless force=true. Prefer htb_vpn_resolve for automatic least-busy selection.",
      inputSchema: {
        server_id: z.number().int().positive().describe("VPN server ID from htb_vpn_servers."),
        product: productSchema,
        force: z
          .boolean()
          .default(false)
          .describe("Allow switching while a machine is active."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const active = await api.getActiveMachine();
      if (active && !args.force) {
        throw new HtbError({
          code: "CONFLICT",
          message: `Machine "${active.name}" is active. Switching VPN servers can terminate it.`,
          hint: "Stop the machine first, or pass force: true.",
        });
      }

      const before = await api.getConnections();
      const current = before.find(
        (connection) => connection.type === args.product,
      )?.assignedServer;
      if (current?.id === args.server_id) {
        return {
          action: "unchanged",
          server: vpnServerView(current),
          message: "This server is already assigned.",
        };
      }

      const response = await api.switchVpnServer(args.server_id);
      assertActionSucceeded(response, "switch the VPN server");
      return {
        action: "switched",
        terminatedMachine: Boolean(active),
        previousServerId: current?.id ?? null,
        serverId: args.server_id,
        response,
      };
    }),
  );

  server.registerTool(
    "htb_vpn_resolve",
    {
      title: "Resolve and download the VPN",
      description:
        "Pick the least-busy server (or use server_id), switch if needed, download the OpenVPN profile, resolve its remote hostname, and optionally connect. Blocks switching while a machine is active unless force=true. Does not connect unless connect=true.",
      inputSchema: {
        server_id: z.number().int().positive().optional(),
        product: productSchema,
        protocol: protocolSchema,
        select_best: z
          .boolean()
          .default(true)
          .describe("Automatically choose the least-busy server in the current tier."),
        force: z
          .boolean()
          .default(false)
          .describe("Allow a server switch while a machine is active."),
        probe: z.boolean().default(true).describe("Resolve DNS and try ICMP latency."),
        connect: z
          .boolean()
          .default(false)
          .describe("Start OpenVPN after downloading the profile."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const saved = await resolveAndSaveVpnConfig(api, config, {
        serverId: args.server_id,
        product: args.product,
        protocol: args.protocol,
        selectBest: args.select_best,
        force: args.force,
        probe: args.probe,
      });

      let localProcess: LocalVpnProcess | null = null;
      if (args.connect) {
        localProcess = await connectOpenVpn(config, saved.path);
      }

      return {
        serverId: saved.serverId,
        product: saved.product,
        protocol: saved.protocol,
        path: saved.path,
        endpoint: saved.endpoint,
        remotes: saved.profile.remotes,
        resolved: saved.resolved,
        localProcess,
        connected: localProcess !== null,
      };
    }),
  );

  server.registerTool(
    "htb_vpn_download",
    {
      title: "Download a VPN profile",
      description:
        "Download the OpenVPN profile for the assigned server (or server_id) without auto-selecting a new server. Returns only the local path and endpoint metadata, never the private key.",
      inputSchema: {
        server_id: z.number().int().positive().optional(),
        product: productSchema,
        protocol: protocolSchema,
        force: z
          .boolean()
          .default(false)
          .describe("Allow switching to server_id while a machine is active."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => run(async () => {
      const saved = await resolveAndSaveVpnConfig(api, config, {
        serverId: args.server_id,
        product: args.product,
        protocol: args.protocol,
        selectBest: false,
        force: args.force,
        probe: false,
      });
      return {
        serverId: saved.serverId,
        product: saved.product,
        protocol: saved.protocol,
        path: saved.path,
        endpoint: saved.endpoint,
        remotes: saved.profile.remotes,
      };
    }),
  );

  server.registerTool(
    "htb_vpn_connect",
    {
      title: "Connect OpenVPN",
      description:
        "Start OpenVPN using a profile in the configured VPN directory. If config_path is omitted, the assigned profile is downloaded first. Uses sudo -n when not root; it never prompts for a password.",
      inputSchema: {
        config_path: z
          .string()
          .min(1)
          .optional()
          .describe("Profile inside the configured HTB VPN directory."),
        server_id: z.number().int().positive().optional(),
        product: productSchema,
        protocol: protocolSchema,
        force: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => run(async () => {
      let path = args.config_path;
      if (!path) {
        const saved = await resolveAndSaveVpnConfig(api, config, {
          serverId: args.server_id,
          product: args.product,
          protocol: args.protocol,
          selectBest: false,
          force: args.force,
          probe: false,
        });
        path = saved.path;
      }

      const localProcess = await connectOpenVpn(config, path);
      return { action: "connected", localProcess, configPath: path };
    }),
  );

  server.registerTool(
    "htb_vpn_disconnect",
    {
      title: "Disconnect OpenVPN",
      description:
        "Stop the OpenVPN process started by this server. With no PID file, stops all HTB OpenVPN processes managed by this server.",
      inputSchema: {
        pid_file: z.string().min(1).optional().describe("Specific PID file to stop."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => run(async () => {
      const stopped = await disconnectOpenVpn(config, args.pid_file);
      return {
        action: stopped.length > 0 ? "disconnected" : "not_running",
        stopped,
        message:
          stopped.length > 0
            ? `Stopped ${stopped.length} OpenVPN process(es).`
            : "No managed OpenVPN process was running.",
      };
    }),
  );

  server.registerTool(
    "htb_vpn_status",
    {
      title: "VPN status",
      description:
        "Show HTB-side VPN connections plus local OpenVPN processes, profiles, and PID state.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(async () => {
      const [htb, local] = await Promise.all([
        api.getConnectionStatus().catch((error: unknown) => ({
          error: errorText(error),
        })),
        getLocalVpnProcesses(config),
      ]);
      return { htb, local, vpnDir: config.vpnDir };
    }),
  );

  server.registerTool(
    "htb_submit_flag",
    {
      title: "Submit a flag",
      description:
        "Submit a machine or challenge flag. For machines, target defaults to the active machine. Returns HTB's acceptance message, points, and ownership state.",
      inputSchema: {
        kind: z.enum(["machine", "challenge"]).describe("Which flag type to submit."),
        flag: z.string().min(1).describe("The flag value."),
        target: targetSchema.optional().describe(
          "Machine name/ID or challenge name/ID. Required for challenges; defaults to the active machine.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => run(async () => {
      if (args.kind === "machine") {
        const machine =
          args.target === undefined
            ? await api.getActiveMachine()
            : await api.resolveMachine(args.target);
        if (!machine) {
          throw new HtbError({
            code: "NOT_FOUND",
            message: "No active machine and no target supplied.",
          });
        }
        const response = await api.submitMachineFlag(machine.id, args.flag);
        return {
          kind: "machine",
          target: { id: machine.id, name: machine.name },
          result: response,
        };
      }

      if (args.target === undefined) {
        throw new HtbError({
          code: "API_ERROR",
          message: "A challenge target is required.",
        });
      }

      const challenge =
        typeof args.target === "number"
          ? await api.getChallenge(String(args.target))
          : await api.getChallenge(args.target);
      const id = Number(challenge.id);
      if (!Number.isFinite(id)) {
        throw new HtbError({
          code: "NOT_FOUND",
          message: "Could not determine the challenge ID.",
        });
      }
      const response = await api.submitChallengeFlag(id, args.flag);
      return {
        kind: "challenge",
        target: { id, name: challenge.name ?? args.target },
        result: response,
      };
    }),
  );

  server.registerTool(
    "htb_list_challenges",
    {
      title: "List challenges",
      description:
        "Search and filter HTB challenges by state, difficulty, category, name, and completion.",
      inputSchema: {
        state: z.enum(["active", "retired", "unreleased", "all"]).default("active"),
        difficulty: z
          .enum(["very-easy", "easy", "medium", "hard", "insane"])
          .optional(),
        category: z.number().int().positive().optional().describe("Numeric category ID."),
        keyword: z.string().min(1).optional(),
        completed: z.enum(["complete", "incompleted"]).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(5).max(100).default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const result = await api.listChallenges({
        state: args.state,
        difficulty: args.difficulty,
        category: args.category,
        keyword: args.keyword,
        completed: args.completed,
        page: args.page,
        perPage: args.per_page,
      });
      return {
        challenges: result.challenges.map(({ raw: _raw, ...challenge }) => challenge),
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "htb_get_challenge",
    {
      title: "Get challenge details",
      description:
        "Get challenge details by ID or slug, including category, difficulty, description, docker status, and solve state.",
      inputSchema: { target: targetSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => {
      const challenge = await api.getChallenge(String(args.target));
      return {
        id: challenge.id ?? null,
        name: challenge.name ?? null,
        category: challenge.category_name ?? null,
        difficulty: challenge.difficulty ?? null,
        state: challenge.state ?? null,
        description: challenge.description ?? null,
        docker: challenge.docker ?? null,
        docker_ip: challenge.docker_ip ?? null,
        docker_ports: challenge.docker_ports ?? null,
        download: challenge.download ?? null,
        file_name: challenge.file_name ?? null,
        solved: challenge.authUserSolve ?? null,
        solves: challenge.solves ?? null,
        rating: challenge.rating ?? null,
        creator: challenge.creator_name ?? null,
      };
    }),
  );
}

function assertActionSucceeded(
  response: Record<string, unknown>,
  action: string,
): void {
  if (response.success !== false) {
    return;
  }

  const message =
    typeof response.message === "string" ? response.message : `HTB rejected ${action}.`;
  const rateLimited = /wait .*minute|too many requests|rate limit/i.test(message);
  throw new HtbError({
    code: rateLimited ? "RATE_LIMITED" : "API_ERROR",
    message: `HTB rejected ${action}: ${message}`,
    ...(rateLimited
      ? { hint: "Wait for the advertised cooldown before retrying." }
      : {}),
  });
}

function activeMachineView(machine: ActiveMachine): Record<string, unknown> {
  return {
    id: machine.id,
    name: machine.name,
    ip: machine.ip,
    isSpawning: machine.isSpawning,
    expiresAt: machine.expiresAt,
    type: machine.type,
    labServer: machine.labServer,
    vpnServerId: machine.vpnServerId,
    vpnServerType: machine.vpnServerType,
  };
}

function connectionView(connection: VpnConnection): Record<string, unknown> {
  return {
    type: connection.type,
    location: connection.locationTypeFriendly,
    server: connection.assignedServer
      ? vpnServerView(connection.assignedServer)
      : null,
    machine: connection.machine,
    proLab: connection.proLab,
    available: connection.available,
  };
}

function machineView(machine: MachineSummary): Record<string, unknown> {
  return {
    id: machine.id,
    name: machine.name,
    os: machine.os,
    difficulty: machine.difficulty,
    points: machine.points,
    state: machine.state,
    ip: machine.ip,
    free: machine.free,
    active: machine.active,
    retired: machine.retired,
    userOwned: machine.userOwned,
    rootOwned: machine.rootOwned,
    todo: machine.todo,
    rating: machine.rating,
    releaseDate: machine.releaseDate,
  };
}

function vpnServerView(server: VpnServer): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    location: server.location,
    tier: server.tier,
    currentClients: server.currentClients,
    full: server.full,
    product: server.product,
    assigned: server.assigned,
  };
}

async function run(handler: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await handler();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (error) {
    const htbError = toHtbError(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(htbError.toJSON(), null, 2),
        },
      ],
      isError: true,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
