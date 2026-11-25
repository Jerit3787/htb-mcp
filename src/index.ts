#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HtbApi } from "./api.js";
import { HtbClient } from "./client.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { registerTools } from "./tools.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

loadDotEnv();

const config = loadConfig();
const client = new HtbClient(config);
const api = new HtbApi(client);

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    instructions: [
      "Unofficial Hack The Box MCP server.",
      "Start with htb_status to confirm authentication and see active resources.",
      "Machine spawn/reset/stop, challenge container start/stop, VPN switching, and flag submission change real account state.",
      "Only one challenge container can run at a time; starting another can replace it.",
      "Sherlock tasks are answered individually with htb_submit_sherlock_answer.",
      "Downloads are written under HTB_DOWNLOAD_DIR; never print App Tokens or OpenVPN private keys.",
      "Switching VPN servers can terminate an active machine; ask before forcing it.",
    ].join(" "),
  },
);

registerTools(server, { api, config });

if (!config.token && !config.sessionCookie) {
  console.error(
    `${SERVER_NAME}: HTB_TOKEN is not set. Tools will return an auth error until it is configured.`,
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`${SERVER_NAME} ${SERVER_VERSION} ready (stdio).`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error(`${SERVER_NAME}: received ${signal}, shutting down.`);
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
