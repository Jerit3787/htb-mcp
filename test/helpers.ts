import type { AppConfig } from "../src/config.js";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    token: "test-token",
    sessionCookie: undefined,
    labsUrl: "https://labs.hackthebox.com",
    timeoutMs: 5_000,
    maxRetries: 2,
    vpnDir: "/tmp/htb-mcp-test-vpn",
    downloadDir: "/tmp/htb-mcp-test-downloads",
    downloadTimeoutMs: 30_000,
    openvpnBin: "openvpn",
    openvpnUseSudo: false,
    ...overrides,
  };
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function textResponse(
  body: string,
  status = 200,
  contentType = "text/plain",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}
