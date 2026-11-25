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

## Challenges

### `htb_list_challenges`

Filters by state, difficulty, numeric category ID, keyword, completion, and
todo status. Supports HTB sort fields (`release-date`, `name`, `rating`, and
others) and pagination.

### `htb_list_challenge_categories`

Lists challenge categories with the numeric IDs accepted by
`htb_list_challenges.category`.

### `htb_get_challenge`

Accepts an ID, slug, or name. Returns category, difficulty, description,
download metadata, Docker status, play info, and solve state.

### `htb_start_challenge`

`target` accepts an ID, slug, or name. Starts the challenge's Docker instance
using `POST /container/start` with `{"containerable_id": <id>}`, then polls the
challenge profile for up to `wait_seconds` (default 60).

Returns `action: "started"` with `container.ip`, `container.ports`,
`container.expiresAt`, or `action: "starting"` when HTB has not exposed the IP
yet. If a container is already running, it returns `action: "already_running"`.
Challenges without a Docker instance fail with `CONFLICT`.

HTB allows one challenge container at a time. Starting another challenge can
replace the current container.

### `htb_stop_challenge`

Stops the challenge's Docker instance using `POST /container/stop`. This ends
the remote service immediately.

### `htb_challenge_status`

Read-only check for a challenge container, returning `running`, `container`,
`dockerStatus`, and whether the challenge has downloadable files.

### `htb_download_challenge`

Downloads the challenge attachment archive into
`HTB_DOWNLOAD_DIR/challenges/<id>/`. The tool requests a fresh signed URL,
fetches it without the App Token, and writes the file with mode `0600`.

Returns `path`, `fileName`, `bytes`, `sha256`, `filePassword` when HTB provides
one, and `expectedSha256` when the challenge profile includes a checksum.
Archives are not extracted.

## Sherlocks

### `htb_list_sherlocks`

Filters by state, difficulty, numeric category ID, keyword, and completion.
Supports `solves`, `category`, `rating`, and `name` sorting.

### `htb_list_sherlock_categories`

Lists Sherlock categories with the numeric IDs accepted by
`htb_list_sherlocks.category`.

### `htb_get_sherlock`

Accepts an ID, slug, or name. Combines the Sherlock profile, scenario,
creators, evidence metadata, play info, academy modules, and progress.

### `htb_sherlock_tasks`

Lists task IDs, titles, descriptions, hints, masked answers, completion state,
and prerequisite task IDs. Hints and masked answers are returned as HTB sends
them.

### `htb_sherlock_progress`

Returns `isOwned`, `ownRank`, `progress`, `tasksAnswered`, and `totalTasks`.

### `htb_download_sherlock`

Downloads the evidence archive into
`HTB_DOWNLOAD_DIR/sherlocks/<id>/` using the same signed-link and path-safety
rules as challenge downloads. Returns `path`, `fileName`, `bytes`, `sha256`,
and `filePassword` when available.

### `htb_submit_sherlock_answer`

Requires `target`, `task_id` (from `htb_sherlock_tasks`), and `flag`. HTB
returns a success message for a correct answer; an incorrect answer, locked
prerequisite, or unknown task becomes an `API_ERROR` containing HTB's message.

## Flags

### `htb_submit_flag`

`kind` is `machine` or `challenge`; `flag` is required. Machine targets default
to the active machine. Challenge targets can be an ID, slug, or name. Use
`htb_submit_sherlock_answer` for Sherlock tasks.

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
