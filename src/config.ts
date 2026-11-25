import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AppConfig {
  token: string | undefined;
  sessionCookie: string | undefined;
  labsUrl: string;
  timeoutMs: number;
  maxRetries: number;
  vpnDir: string;
  downloadDir: string;
  downloadTimeoutMs: number;
  openvpnBin: string;
  openvpnUseSudo: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const labsUrl = normalizeUrl(env.HTB_LABS_URL ?? "https://labs.hackthebox.com");
  const timeoutMs = parseInteger(env.HTB_TIMEOUT_MS, 30_000, 1_000, 300_000);
  const maxRetries = parseInteger(env.HTB_MAX_RETRIES, 2, 0, 10);
  const vpnDir = resolve(
    expandHome(env.HTB_VPN_DIR ?? `${homedir()}/.config/htb-mcp/vpn`),
  );
  const downloadDir = resolve(
    expandHome(env.HTB_DOWNLOAD_DIR ?? `${homedir()}/.config/htb-mcp/downloads`),
  );
  const downloadTimeoutMs = parseInteger(
    env.HTB_DOWNLOAD_TIMEOUT_MS,
    300_000,
    10_000,
    3_600_000,
  );

  return {
    token: nonEmpty(env.HTB_TOKEN ?? env.HTB_APP_TOKEN),
    sessionCookie: nonEmpty(env.HTB_SESSION_COOKIE),
    labsUrl,
    timeoutMs,
    maxRetries,
    vpnDir,
    downloadDir,
    downloadTimeoutMs,
    openvpnBin: nonEmpty(env.HTB_OPENVPN_BIN) ?? "openvpn",
    openvpnUseSudo: !["0", "false", "no"].includes(
      (env.HTB_OPENVPN_USE_SUDO ?? "1").toLowerCase(),
    ),
  };
}

/** Load `.env` if present without making it a hard dependency. */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // A missing or unreadable .env is fine; real environment variables win.
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("HTB_LABS_URL must use http or https");
  }
  return url.toString().replace(/\/+$/, "");
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return `${homedir()}/${value.slice(2)}`;
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
