# htb-mcp

An MCP server for [Hack The Box](https://app.hackthebox.com) that lets an AI
agent inspect machines, spawn and reset targets, resolve/download/connect the
VPN, submit flags, and browse challenges.

> [!IMPORTANT]
> This project is unofficial and is not affiliated with Hack The Box. Use it
> only against machines you are allowed to access. Spawning, resetting, and
> switching VPN servers are real account actions and can terminate a running
> target.

## Features

- Machine discovery and details
- Spawn, stop, reset, and extend machines
- Active-machine status with IP and expiry
- VPN server listing, least-busy selection, server switching, and config download
- VPN hostname resolution and optional OpenVPN connect/disconnect
- Machine and challenge flag submission
- Auth/status diagnostics with retry and rate-limit handling

The server talks to the same API used by `app.hackthebox.com`:
`https://labs.hackthebox.com/api/v4` and `/api/v5`. The old
`app.hackthebox.com/api/v4` path now serves the web app rather than JSON.

## Requirements

- Node.js 22+
- A Hack The Box App Token
- Optional: `openvpn` and passwordless `sudo` if you want the server to establish
  the tunnel for you

## Setup

```bash
git clone https://github.com/Jerit3787/htb-mcp.git
cd htb-mcp
npm ci
npm run build
```

Create a token in HTB under **Settings → App Tokens**, then run:

```bash
HTB_TOKEN="your-token" node dist/src/index.js
```

The process speaks MCP over stdio. Logs go to stderr so they never corrupt the
protocol stream.

## OpenCode

Add this to `opencode.jsonc` (OpenCode V2 uses `mcp.servers`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "htb": {
        "type": "local",
        "command": ["node", "/absolute/path/to/htb-mcp/dist/src/index.js"],
        "environment": {
          "HTB_TOKEN": "{env:HTB_TOKEN}"
        }
      }
    }
  }
}
```

Then export `HTB_TOKEN` in the environment that starts OpenCode.

## Claude Desktop / other clients

```json
{
  "mcpServers": {
    "htb": {
      "command": "node",
      "args": ["/absolute/path/to/htb-mcp/dist/src/index.js"],
      "env": {
        "HTB_TOKEN": "your-token"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `htb_status` | Account, active machine, VPN assignments, and API health |
| `htb_list_machines` | Search/filter the machine catalogue |
| `htb_get_machine` | Machine details by ID or name |
| `htb_launch_machine` | Spawn a machine and wait for its IP |
| `htb_stop_machine` | Terminate the active machine |
| `htb_reset_machine` | Reset the active machine |
| `htb_extend_machine` | Extend the active machine's lifetime |
| `htb_vpn_servers` | List VPN servers and current assignments |
| `htb_vpn_switch` | Switch VPN server (refuses while a machine is active unless forced) |
| `htb_vpn_resolve` | Pick the least-busy server, download config, resolve the endpoint |
| `htb_vpn_download` | Download a UDP/TCP OpenVPN profile |
| `htb_vpn_status` | HTB-side and local OpenVPN status |
| `htb_vpn_connect` | Start OpenVPN with a downloaded profile |
| `htb_vpn_disconnect` | Stop the OpenVPN process started by this server |
| `htb_submit_flag` | Submit a machine or challenge flag |
| `htb_list_challenges` | Search/filter challenges |
| `htb_get_challenge` | Challenge details by ID or slug |

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `HTB_TOKEN` | — | App Token (required unless a session cookie is supplied) |
| `HTB_SESSION_COOKIE` | — | Optional browser cookie for endpoints that reject token auth |
| `HTB_LABS_URL` | `https://labs.hackthebox.com` | API host; useful for mocks/proxies |
| `HTB_TIMEOUT_MS` | `30000` | Per-request timeout |
| `HTB_MAX_RETRIES` | `2` | Retries for GET/429 responses |
| `HTB_VPN_DIR` | `~/.config/htb-mcp/vpn` | Downloaded profiles, PID files, and logs |
| `HTB_OPENVPN_BIN` | `openvpn` | OpenVPN executable |
| `HTB_OPENVPN_USE_SUDO` | `1` | Prefix OpenVPN with `sudo -n` when not root |

Profiles contain private keys and are written with mode `0600`. Do not commit
them.

## VPN notes

- HTB lets one VPN session be assigned per product. Switching servers can
  terminate an active machine; `htb_vpn_switch` blocks this unless `force` is
  true.
- `htb_vpn_resolve` downloads the profile, resolves the `remote` hostname, and
  reports latency. It does not connect unless `connect: true` is passed.
- Auto-connect uses `sudo -n`, so it fails cleanly instead of prompting for a
  password. Configure a narrowly scoped sudoers rule or start OpenVPN yourself.
- Only profiles inside the configured VPN directory can be passed to
  `htb_vpn_connect`.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests use a local mock HTB API and do not touch your account.

## License

MIT
