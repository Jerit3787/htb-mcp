# Tool reference

All tools return JSON text. Errors set MCP `isError` and include a stable
`error` code plus a `hint` where recovery is possible.

## Account

### `htb_status`

No input. Returns the account summary, active machine, VPN assignments, and any
partial API errors. This is the best first call after configuring a token.

## Machines

### `htb_list_machines`

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `state` | `active`, `retired`, `unreleased`, `all` | `active` | `all` means active + retired |
| `difficulty` | `easy`, `medium`, `hard`, `insane` | — | |
| `os` | `linux`, `windows`, `freebsd`, `openbsd`, `other` | — | |
| `keyword` | string | — | Name search |
| `page` | integer | `1` | |
| `per_page` | 5–100 | `25` | |
| `free` | boolean | — | |
| `todo` | boolean | `false` | |
| `completed` | `complete`, `incomplete` | — | |
| `sort_by` | see schema | — | |
| `sort_type` | `asc`, `desc` | — | |

### `htb_get_machine`

`target` accepts a name or numeric ID. `include_raw` adds the full HTB profile.

### `htb_launch_machine`

`target` accepts a name or numeric ID. The tool waits up to `wait_seconds`
(default 90) for an IP. If another machine is active, the call fails unless
`replace: true`; replacing terminates the active machine first. HTB's machine
action cooldown is roughly one minute.

### `htb_stop_machine`, `htb_reset_machine`, `htb_extend_machine`

These act on the active machine. An optional `target` is only a safety check: if
it does not match the active machine, the call fails.

## VPN

### `htb_vpn_servers`

`product` defaults to `labs`. Returns server IDs, client counts, full status,
current product assignments, and warnings. Server options come from the v4
connections endpoint; assignments come from v5.

### `htb_vpn_switch`

`server_id` plus optional `product`. Refuses while a machine is active unless
`force: true`. The tool does not terminate the machine itself.

### `htb_vpn_resolve`

The main "make my VPN work" tool:

1. Loads server options and the assigned server.
2. With `select_best: true` (default), picks the least-busy non-full server in
   the same tier.
3. Switches if needed. This is blocked while a machine is active unless
   `force: true`.
4. Downloads the UDP (default) or TCP profile.
5. Resolves each `remote` hostname and optionally measures ICMP latency.
6. Starts OpenVPN only when `connect: true`.

Returns the profile path, endpoint metadata, DNS addresses, and latency. It
never returns the profile contents.

### `htb_vpn_download`

Same download and write behavior, but does not auto-select a different server
and does not probe DNS. Use this when you only need the `.ovpn` file.

### `htb_vpn_status`

Combines HTB's `/connection/status` with local PID/config information.

### `htb_vpn_connect`

Accepts a `config_path` inside `HTB_VPN_DIR`, or downloads the assigned profile
when omitted. It starts:

```text
openvpn --config <profile> --daemon htb-mcp --writepid <pid> --log <log>
```

When not root and `HTB_OPENVPN_USE_SUDO=1`, it prefixes `sudo -n`. It fails
instead of prompting for a password. Only one managed tunnel can run at once.
Profiles are restricted to the managed directory, symlinks are checked, and
`--script-security 1` is passed to OpenVPN.

### `htb_vpn_disconnect`

Stops one PID file or every managed tunnel. Only processes whose command line is
OpenVPN and whose `--config` path is managed by this server are touched.

## Flags and challenges

### `htb_submit_flag`

`kind` is `machine` or `challenge`; `flag` is required. Machine targets default
to the active machine. Challenge targets can be an ID or slug.

### `htb_list_challenges`

Filters by state, difficulty, numeric category ID, keyword, and completion.

### `htb_get_challenge`

Returns a compact challenge profile by ID or slug.

## Error codes

| Code | Meaning |
| --- | --- |
| `AUTH_MISSING` | No `HTB_TOKEN` or `HTB_SESSION_COOKIE` |
| `AUTH_FAILED` | HTB rejected the credentials |
| `RATE_LIMITED` | HTB cool-down; the message includes timing |
| `CONFLICT` | Active machine/server conflict |
| `NOT_FOUND` | Unknown machine, challenge, or server |
| `INVALID_RESPONSE` | HTML or malformed payload; usually wrong base URL |
| `API_ERROR` | Other HTB 4xx/5xx response |
| `NETWORK_ERROR` | Timeout or connection failure |
| `VPN_ERROR` | Profile or DNS issue |
| `OPENVPN_ERROR` | Local OpenVPN could not start or stop |
