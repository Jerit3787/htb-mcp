import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { AppConfig } from "./config.js";
import type { HtbApi, VpnConfigResult, VpnServer } from "./api.js";
import { HtbError } from "./errors.js";

export interface VpnRemote {
  host: string;
  port: number;
  protocol: "udp" | "tcp" | null;
}

export interface VpnProfile {
  remotes: VpnRemote[];
  device: string | null;
  proto: "udp" | "tcp" | null;
}

export interface ResolvedVpnEndpoint {
  host: string;
  port: number;
  protocol: "udp" | "tcp" | null;
  addresses: string[];
  dnsMs: number;
  icmpMs: number | null;
}

export interface SavedVpnConfig extends VpnConfigResult {
  path: string;
  profile: VpnProfile;
  resolved: ResolvedVpnEndpoint[];
}

export interface ResolveVpnOptions {
  serverId: number | undefined;
  product: string;
  protocol: "udp" | "tcp";
  force: boolean;
  probe: boolean;
  selectBest: boolean;
}

export interface LocalVpnProcess {
  pid: number;
  configPath: string;
  pidFile: string;
  running: boolean;
}

export async function resolveAndSaveVpnConfig(
  api: HtbApi,
  config: AppConfig,
  options: ResolveVpnOptions,
): Promise<SavedVpnConfig> {
  const { servers, assigned } = await api.getVpnServers(options.product);
  const selected =
    (options.serverId === undefined
      ? undefined
      : servers.find((server) => server.id === options.serverId)) ??
    (options.serverId === undefined && options.selectBest
      ? chooseBestVpnServer(servers, assigned)
      : undefined);

  if (options.serverId !== undefined && !selected) {
    throw new HtbError({
      code: "NOT_FOUND",
      message: `VPN server ${options.serverId} is not available for product "${options.product}".`,
      hint: "Call htb_vpn_servers to see valid server IDs.",
    });
  }

  const target = selected ?? assigned;
  if (!target) {
    throw new HtbError({
      code: "VPN_ERROR",
      message: `No VPN server is assigned for product "${options.product}".`,
      hint: "Open HTB Connection Settings and assign a VPN server, or call htb_vpn_servers to pick one.",
    });
  }

  const desiredId = options.serverId ?? target.id;
  const assignedId = assigned?.id;
  if (assignedId !== desiredId) {
    const activeMachine = await api.getActiveMachine();
    if (activeMachine && !options.force) {
      throw new HtbError({
        code: "CONFLICT",
        message: `Machine "${activeMachine.name}" is active. Switching VPN servers can terminate it.`,
        hint: "Stop the machine first, or pass force: true if you accept that the machine may be terminated.",
      });
    }
    await api.switchVpnServer(desiredId);
  }

  const result = await api.getVpnConfig(desiredId, options.product, options.protocol);
  const profile = parseVpnProfile(result.content);
  if (profile.remotes.length === 0) {
    throw new HtbError({
      code: "VPN_ERROR",
      message: "The downloaded OpenVPN profile has no remote endpoint.",
    });
  }

  await mkdir(config.vpnDir, { recursive: true, mode: 0o700 });
  const safeProduct = options.product.replace(/[^a-z0-9_-]+/gi, "-");
  const path = resolve(
    config.vpnDir,
    `htb-${safeProduct}-${desiredId}-${options.protocol}.ovpn`,
  );
  await writeFile(path, result.content, { mode: 0o600 });
  await chmod(path, 0o600);

  const resolved = options.probe
    ? await Promise.all(profile.remotes.map((remote) => resolveVpnRemote(remote)))
    : [];

  return {
    ...result,
    path,
    profile,
    resolved,
  };
}

export function chooseBestVpnServer(
  servers: VpnServer[],
  assigned: VpnServer | null,
): VpnServer | null {
  const candidates = servers.filter((server) => !server.full && server.id > 0);
  if (candidates.length === 0) {
    return assigned;
  }

  const tier = assigned?.tier;
  const sameTier = tier
    ? candidates.filter((server) => server.tier === tier)
    : [];
  const pool = sameTier.length > 0 ? sameTier : candidates;

  return [...pool].sort((a, b) => {
    const clientsA = a.currentClients ?? Number.MAX_SAFE_INTEGER;
    const clientsB = b.currentClients ?? Number.MAX_SAFE_INTEGER;
    if (clientsA !== clientsB) {
      return clientsA - clientsB;
    }
    return a.id - b.id;
  })[0] ?? assigned;
}

export function parseVpnProfile(content: string): VpnProfile {
  const remotes: VpnRemote[] = [];
  let device: string | null = null;
  let proto: "udp" | "tcp" | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const [directive, ...parts] = line.split(/\s+/);
    if (!directive) {
      continue;
    }

    if (directive === "remote" && parts[0]) {
      const port = parts[1] ? Number.parseInt(parts[1], 10) : 1194;
      const remoteProtocol = parts[2] === "tcp" || parts[2] === "udp" ? parts[2] : null;
      remotes.push({
        host: parts[0],
        port: Number.isFinite(port) ? port : 1194,
        protocol: remoteProtocol,
      });
    } else if (directive === "dev" && parts[0]) {
      device = parts[0];
    } else if (directive === "proto" && (parts[0] === "udp" || parts[0] === "tcp")) {
      proto = parts[0];
    }
  }

  return { remotes, device, proto };
}

export async function resolveVpnRemote(
  remote: VpnRemote,
): Promise<ResolvedVpnEndpoint> {
  const dnsStarted = Date.now();
  let addresses: string[] = [];
  try {
    const records = await lookup(remote.host, { all: true, verbatim: true });
    addresses = [...new Set(records.map((record) => record.address))];
  } catch (error) {
    throw new HtbError({
      code: "VPN_ERROR",
      message: `Could not resolve VPN host "${remote.host}": ${errorText(error)}`,
    });
  }
  const dnsMs = Date.now() - dnsStarted;
  const icmpMs = await pingHost(remote.host);

  return {
    host: remote.host,
    port: remote.port,
    protocol: remote.protocol,
    addresses,
    dnsMs,
    icmpMs,
  };
}

export async function connectOpenVpn(
  config: AppConfig,
  configPath: string,
): Promise<LocalVpnProcess> {
  const safePath = ensureInsideVpnDir(config, configPath);
  await access(safePath, fsConstants.R_OK);
  const [realDir, realPath] = await Promise.all([
    realpath(config.vpnDir),
    realpath(safePath),
  ]);
  if (realPath !== realDir && !realPath.startsWith(`${realDir}${sep}`)) {
    throw new HtbError({
      code: "VPN_ERROR",
      message: "The OpenVPN profile resolves outside the configured VPN directory.",
    });
  }

  const existing = await getLocalVpnProcesses(config);
  const alreadyRunning = existing.find(
    (process) => process.configPath === safePath && process.running,
  );
  if (alreadyRunning) {
    return alreadyRunning;
  }

  const otherTunnel = existing.find(
    (process) => process.running && process.configPath !== safePath,
  );
  if (otherTunnel) {
    throw new HtbError({
      code: "OPENVPN_ERROR",
      message: `Another HTB OpenVPN tunnel is already running (PID ${otherTunnel.pid}).`,
      hint: "Call htb_vpn_disconnect first, then retry.",
    });
  }

  await mkdir(config.vpnDir, { recursive: true, mode: 0o700 });
  const stem = basename(safePath).replace(/\.ovpn$/i, "");
  const pidFile = resolve(config.vpnDir, `${stem}.pid`);
  const logFile = resolve(config.vpnDir, `${stem}.log`);
  await rm(pidFile, { force: true });

  const useSudo = config.openvpnUseSudo && typeof process.getuid === "function" && process.getuid() !== 0;
  const command = useSudo ? "sudo" : config.openvpnBin;
  const args = [
    ...(useSudo ? ["-n", config.openvpnBin] : []),
    "--config",
    safePath,
    "--daemon",
    "htb-mcp",
    "--writepid",
    pidFile,
    "--log",
    logFile,
    "--auth-nocache",
    "--script-security",
    "1",
  ];

  try {
    await runCommand(command, args, 15_000);
  } catch (error) {
    throw new HtbError({
      code: "OPENVPN_ERROR",
      message: `Could not start OpenVPN: ${errorText(error)}`,
      hint: useSudo
        ? "Passwordless sudo is required. Configure a scoped sudoers rule or run OpenVPN manually."
        : "Check that openvpn is installed and that the profile is valid.",
    });
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const pid = await readPid(pidFile);
    if (pid && isProcessAlive(pid)) {
      return { pid, configPath: safePath, pidFile, running: true };
    }
    await sleep(250);
  }

  const logTail = await tail(logFile);
  throw new HtbError({
    code: "OPENVPN_ERROR",
    message: "OpenVPN did not start successfully.",
    hint: logTail
      ? `Last log line: ${logTail}`
      : "Check the OpenVPN log in the configured VPN directory.",
  });
}

export async function disconnectOpenVpn(
  config: AppConfig,
  pidFile?: string,
): Promise<LocalVpnProcess[]> {
  const processes = await getLocalVpnProcesses(config);
  const targets = pidFile
    ? processes.filter((process) => resolve(process.pidFile) === resolve(pidFile))
    : processes.filter((process) => process.running);

  if (pidFile && targets.length === 0) {
    throw new HtbError({
      code: "NOT_FOUND",
      message: `No OpenVPN process found for ${pidFile}.`,
    });
  }

  const stopped: LocalVpnProcess[] = [];
  const useSudo = config.openvpnUseSudo && typeof process.getuid === "function" && process.getuid() !== 0;

  for (const processInfo of targets) {
    if (!processInfo.running) {
      await rm(processInfo.pidFile, { force: true });
      continue;
    }

    const command = useSudo ? "sudo" : "kill";
    const args = useSudo
      ? ["-n", "kill", String(processInfo.pid)]
      : [String(processInfo.pid)];
    await runCommand(command, args, 5_000);
    await rm(processInfo.pidFile, { force: true });
    stopped.push({ ...processInfo, running: false });
  }

  return stopped;
}

export async function getLocalVpnProcesses(
  config: AppConfig,
): Promise<LocalVpnProcess[]> {
  let files: string[];
  try {
    files = await readdir(config.vpnDir);
  } catch {
    return [];
  }

  const processes: LocalVpnProcess[] = [];
  for (const file of files.filter((name) => name.endsWith(".pid"))) {
    const pidFile = resolve(config.vpnDir, file);
    const pid = await readPid(pidFile);
    if (!pid) {
      continue;
    }
    const configPath = await findOpenVpnConfigPath(pid);
    processes.push({
      pid,
      configPath: configPath ?? "",
      pidFile,
      running: isProcessAlive(pid) && configPath !== null,
    });
  }

  return processes;
}

export function ensureInsideVpnDir(config: AppConfig, candidate: string): string {
  const dir = resolve(config.vpnDir);
  const path = resolve(candidate);
  if (path !== dir && !path.startsWith(`${dir}${sep}`)) {
    throw new HtbError({
      code: "VPN_ERROR",
      message: "OpenVPN profiles must be inside the configured HTB VPN directory.",
      hint: `Move the profile to ${config.vpnDir}.`,
    });
  }
  return path;
}

async function findOpenVpnConfigPath(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const args = raw.split("\0").filter(Boolean);
    const executable = args[0]?.split("/").at(-1) ?? "";
    if (!executable.startsWith("openvpn")) {
      return null;
    }
    const index = args.indexOf("--config");
    return index >= 0 ? args[index + 1] ?? null : null;
  } catch {
    return null;
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!/^\d+$/.test(value)) {
      return null;
    }
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

async function pingHost(host: string): Promise<number | null> {
  try {
    const { stdout } = await runCommand("ping", ["-c", "1", "-W", "2", host], 4_000);
    const match = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
    return match?.[1] ? Number.parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const suffix = stderr.trim() || stdout.trim();
          reject(new Error(suffix || error.message));
          return;
        }
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function tail(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim().split(/\r?\n/).at(-1) ?? null;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
