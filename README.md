# @black942026/harness-acp-bridge-server

Bridge an ACP harness (CodeBuddy / Codex / any ACP agent) to an MCP client through an
asynchronous, per-session message loop.

Submission and completion are decoupled: `send_message` returns a `message_id`
**immediately**, and the upstream (MCP client or pi-extension) polls `message_result` and
`live_output` for progress. Nothing blocks on a harness turn. A session runs **one message at
a time**: a second submit while one is queued/running/waiting is rejected with `busy`.

## Architecture

```
MCP client ──stdio──▶ cli.js (thin MCP server)
                          │  newline-delimited JSON over a Unix socket
                          ▼
                    daemon (dist/daemon/main.js)
                          │  session registry: one BridgeSession per session
                          ▼
                    ACP JSON-RPC 2.0 over stdio  ──▶  harness process
```

- **`src/acp.ts`** — ACP transport: spawn the session supervisor, newline-framed JSON-RPC,
  bounded oversized-line handling, turn/interaction plumbing, redacted raw recording.
- **`src/supervisor.ts`** — the per-session supervisor process (port of the reference
  `supervisor.py`): prepares the container, owns the harness process group, proxies stdio
  byte-for-byte, and cleans up when the daemon closes the session or dies.
- **`src/session.ts`** — `BridgeSession`: the one-message-at-a-time loop, message states,
  interactions, `live_output` offsets, and lifecycle.
- **`src/persistence.ts`** — session directory, append-only redacted raw stream, rolling
  preview, atomic snapshots.
- **`src/daemon/`** — the Unix-socket daemon, session registry, singleton lock, reaper.
- **`src/cli.ts`** — the MCP stdio server; a thin client over the daemon.

The daemon is auto-started by the MCP client on the first call that needs it (detached,
socket and lock from the configuration). A PID lock file plus the socket bind make it a
singleton; a second daemon on the same lock exits with an error.

## Install

Requires **Node.js >= 20.11** on **macOS or Linux**. Windows is not supported.
Install the ACP harness you plan to use separately and make its command available on `PATH`
(or configure an absolute command path). Docker and SSH are optional, needed only for their
respective launch modes. This package does not bundle harnesses or credentials.

```bash
npm install -g @black942026/harness-acp-bridge-server
harness-acp-bridge --config /abs/path/to/config.yaml
```

The package includes prebuilt JavaScript and `config.example.yaml`; no TypeScript build is
needed after installing from npm. Copy the example config from the installed package
(`$(npm root -g)/@black942026/harness-acp-bridge-server/config.example.yaml`) and adjust it for
your harnesses and models. `--config` is optional (see [Configuration](#configuration)).

## Development / build

```bash
npm ci
npm run check      # clean build + typecheck + unit/mock-CLI/MCP stdio e2e tests
```

This is a CLI/MCP server package, not a supported JavaScript library API.

The e2e suite runs a real daemon and a real MCP stdio client against a fake ACP harness, and
drives **mock `docker` and `ssh` CLIs** (`test/fixtures/mock-docker.mjs`,
`test/fixtures/mock-ssh.mjs`) so the generated container/remote command lines, cleanup
policy, and pid-file handling are exercised without touching a real engine or host.

## Running the MCP server (stdio)

The CLI is a standard **stdio** MCP server: it speaks newline-delimited JSON-RPC on
stdin/stdout. Run it without a global installation using an explicit package and binary
(the package provides two binaries, so do not rely on npx's binary inference):

```jsonc
{
  "mcpServers": {
    "harness-acp-bridge": {
      "command": "npx",
      "args": ["--yes", "--package=@black942026/harness-acp-bridge-server", "harness-acp-bridge", "--config", "/abs/path/to/config.yaml"]
    }
  }
}
```

For reproducible deployments, pin the package spec to a published version, for example
`--package=@black942026/harness-acp-bridge-server@0.1.0`. With a global installation, use
`"command": "harness-acp-bridge"` and `"args": ["--config", "/abs/path/to/config.yaml"]`.

For a source checkout, point an MCP client at the built Node entrypoint directly:

```jsonc
{
  "mcpServers": {
    "harness-acp-bridge": {
      "command": "node",
      "args": ["/abs/path/to/harness-acp-bridge-server/dist/cli.js", "--config", "/abs/path/to/config.yaml"]
    }
  }
}
```

Or run it by hand against a config (the installed bin name is `harness-acp-bridge`):

```bash
node dist/cli.js --config ./config.example.yaml
```

`--config` is optional (see [Configuration](#configuration) for the fallback order).

### Example: create → send_message → poll

`send_message` returns immediately with only the message id; poll `message_result` (with the
`message_id`) until `terminal` is true, then read the result from the same call. A second
`send_message` while the first is still non-terminal fails with `busy` (see
[`send_message`](#send_message-one-message-at-a-time)):

```jsonc
// 1. create a session
create_session { "harness": "codebuddy", "cwd": "/work/repo", "model_id": "claude-sonnet-4" }
//    -> { "session_id": "2026-01-01-ab12cd34", "state": "ready", "launch_info": { ... } }

// 2. submit a prompt; this returns immediately with only the id
send_message { "session_id": "2026-01-01-ab12cd34", "text": "explain this repo" }
//    -> { "message_id": "msg_0192..." }

// 3. poll the result until `terminal` is true (no text/tool_calls before then)
message_result { "session_id": "2026-01-01-ab12cd34", "message_id": "msg_0192..." }
//    -> { "state": "running", "terminal": false, ... }   (repeat)

// 4. when terminal, the same call carries the result
message_result { "session_id": "2026-01-01-ab12cd34", "message_id": "msg_0192..." }
//    -> { "state": "completed", "terminal": true, "text": "...", "tool_calls": [ ... ] }
```

`live_output` streams the rolling preview by byte offset while the turn runs (and `wait_ms`
turns it into a long-poll). See [Polling](#polling) and
[`live_output` semantics](#live_output-semantics).

## Configuration

`config.example.yaml` is the full schema. The MCP client and the daemon read the same file,
resolved in this order:

1. `--config <path>` argument,
2. `HARNESS_ACP_BRIDGE_CONFIG`,
3. `$XDG_CONFIG_HOME/harness-acp-bridge/config.yaml` (or `~/.config/...`),
4. built-in defaults.

Key settings:

| Key | Meaning |
| --- | --- |
| `paths.state_dir` | Base for session directories. Default `~/.harness-acp-bridge`. |
| `paths.session_dir` | Where sessions are created. Defaults to `state_dir`, so a session lands in `~/.harness-acp-bridge/<date>-<random>/`. |
| `server.socket_path` / `server.lock_path` | Runtime socket and lock. Default `$XDG_RUNTIME_DIR/harness-acp-bridge/` (or `/tmp/harness-acp-bridge-<uid>/`), kept apart from session data. |
| `sessions.max_concurrency` | Maximum live sessions the daemon will hold. |
| `sessions.idle_timeout_seconds` | Idle sessions (no running/queued message, no pending answer) are closed after this. `0` disables reaping. |
| `transport.*` | Startup / turn / cancel / terminate timeouts, the docker+ssh cleanup timeout, and the stderr tail length. |
| `buffers.max_read_bytes` | A single ACP stdout line above this **fails the current message** (`line_too_large`) and closes the transport; nothing is silently skipped. |
| `buffers.max_output_bytes` | Turn-output spool threshold from the reference. This port keeps a turn's text in memory, so the value is accepted and echoed but not enforced (no output is truncated or failed because of it). |
| `buffers.preview_bytes` | Cap for both the in-memory rolling preview and `preview.txt`. |
| `launch.ssh_command` / `launch.docker_command` | Programs used to reach a harness. Never caller-supplied. |
| `launch.<harness>_command` | Default command per built-in harness (overridable per harness entry). |
| `launch.agy_<mode>_mode_id` | Agy ACP mode ids; read/edit require explicit ids, yolo defaults to `yolo`, auto can use the harness default. |
| `authentication.timeout_seconds` | How long an `authenticate` round trip (credentials + session open) may take; on timeout the session is closed and cleaned up. |
| `authentication.max_concurrent_targets` | How many distinct harness+target authentications may run at once. Same-target calls are always serialized. |
| `authentication.ledger_path` | Private attempt ledger. Default `<state_dir>/auth-rate.json`. Stores only SHA-256 target hashes and timestamps. |
| `authentication.rate_limit.enabled` | `false` disables the ledger entirely: nothing is read or written and every attempt is allowed. |
| `authentication.rate_limit.min_interval_seconds` | Minimum spacing between two attempts on the same harness+target. |
| `authentication.rate_limit.max_attempts` / `window_seconds` | Attempt budget per harness+target inside the window. |
| `harnesses.<name>.models` | The configured **model list** (see `harness_info`). Each model is `id`, `name`, and an optional `thinking_levels` list. Omitting `thinking_levels` leaves the model's levels **unknown** (`null`); `[]` declares it supports none. |
| `harnesses.<name>.description` | Optional human-readable note echoed by `harness_info`. |

Harness names must be one of the built-in adapters (`codebuddy`, `codex`, `agy`); the adapter
owns argument construction and permission-mode routing.

## MCP tools

| Tool | Notes |
| --- | --- |
| `ping` | Daemon liveness, pid, config fingerprint. |
| `harness_info` | **Config file only.** For one harness (`harness`) or every configured harness: its `permission_modes` (what the adapter can actually route with the current config) and its configured models with `thinking_levels` (`null` = not declared/unknown). Never starts a harness or a daemon. |
| `create_session` | Local **or remote (SSH)**, **direct or Docker**. Args: `cwd`, `model_id`, `thinking_level?`, `harness?`, `permission_mode?`, `target?`, `remote_host?`, `runtime?`, `docker_id?`, `docker_image?`, `container_policy?`, `mounts?`, `ports?`, `host_network?`, `resume_session_id?`, `authenticate?`, `session_id?`. |
| `authenticate` | Completes a session that reported `authentication_required`. |
| `auth_info` | Login boolean, auth method ids, model. Account fields are whitelisted; **never credentials**. |
| `set_model` | Switch model between turns. Rejected with `busy` while a message is non-terminal (including while waiting for an answer). Optional `thinking_level` applies a level to the **new** model after it is selected; omit it to change only the model. |
| `send_message` | **Asynchronous.** Returns only `{ "message_id": "..." }`. Rejected with `busy` while any message is non-terminal. Optional `idempotency_key` for replay-safe retries. |
| `message_result` | Status **and** result: with `message_id`, the full status (`state`, `terminal`, pending `interaction`, `queue_position`, `error`) plus `text`/`tool_calls`/`harness_session_id` **only once terminal**; without `message_id`, whole-session status. Readable after close and restart. |
| `answer_question` | Answer a pending **interaction** request with `answer: "accept" | "reject" | "timeout" | "cancel"` (default `accept`). Validates `request_id`; for `accept`, permission interactions require a valid `option_id` and information interactions require the answer object. |
| `cancel_message` | Cancel a running message (or one waiting for an answer). |
| `live_output` | Read the rolling preview by byte offset (see below). |
| `close_session` | Cancel the running message, stop the harness, flush persistence. |

### `harness_info` (configuration declaration)

`harness_info` answers **purely from the configuration file** (it starts no daemon and no
harness) and is the place to discover what a harness entry can actually do:

- `permission_modes` — the modes the built-in adapter routes with the **current** config.
  CodeBuddy and Codex route all of `read`/`edit`/`auto`/`yolo`; Agy always routes `auto`
  (harness default) and `yolo` (defaults to `yolo`), and adds `read`/`edit` only when their
  `launch.agy_<mode>_mode_id` is configured. A configured entry without a built-in adapter
  reports none, rather than assuming any.
- `models[].thinking_levels` — the declared levels for that model, or `null` when the config
  does not declare them. The bridge never guesses a level: `null` means unknown, and
  validation falls back to the harness's live ACP config options. An empty list means the model
  was declared to support none.

`create_session` and `set_model` enforce the same declaration, so `harness_info` is an exact
preview of what those calls will accept (see [Launching a session](#launching-a-session)).

### `send_message` one message at a time

A session runs **at most one non-terminal message** (`queued`, `running`, or
`waiting_input`). While one is in flight, any `send_message` that would create a new message is
rejected with `busy` — it performs **no** steering, queueing, cancellation, or persistence, so
a running turn is never disturbed and no half-record is written. Once the message reaches a
terminal state (`completed`, `failed`, `cancelled`) the next submission is accepted.

`mode` (`"steering"` default, `"queue"`, or the alias `"steer"`) no longer changes scheduling;
it is recorded on the message and folded into the idempotency fingerprint, so it is preserved
for identity and comparison but does not trade one message for another.

`cancel_message` cancels the in-flight message (running or waiting for an answer). `set_model`
is likewise rejected with `busy` while a message is non-terminal; it never queues a switch.

### `send_message` idempotency

`idempotency_key` (optional, opaque) makes submission replay-safe within a single session. The
key is resolved **before** the busy guard:

- the **same key with the same normalized text/mode** returns the original `message_id` — even
  while that message is still non-terminal — so a client that retries after a timeout cannot
  submit a duplicate;
- the **same key with different text or mode** fails with `idempotency_conflict` (the error
  names the original `message_id`), so a key can never silently alias two different prompts;
- a **new key** (or **no key**) while the session is busy fails with `busy`, and **omitting
  the key** on an idle session behaves as before (a resend is a new message).

`mode` is normalized before comparison, so `"steer"` and `"steering"` are the same request.
The index is scoped to one session and committed **inside `queue.json`**, in the same atomic
snapshot as the message it names (one temp-file + rename), so a message and its key mapping
can never disagree after a crash. A retried key resolves to its original message even after
`close_session` or a daemon restart, while the same key in a different session is
independent. Only keys that are actually used are stored, hashed (SHA-256), so the snapshot
holds no prompt text or raw key. The index is staged and the whole submission (message +
mapping) is committed *before* any harness side effect: if that write fails the submission is
rolled back and the error propagates, so the caller never sees a success that was not
persisted.

### Launching a session

Optional `thinking_level` sets the selected model's reasoning intensity. `create_session`
applies it during creation **after** model selection; `set_model` applies it to the **new**
model after switching (omit it on `set_model` to change only the model). The bridge maps it to
the harness ACP config option: `thought_level` (codebuddy), `reasoning_effort` (codex), or
`thinking_level` (agy). Two checks apply, and the bridge never silently ignores a requested
level:

1. **Config declaration.** If the target model lists `thinking_levels`, only those levels are
   accepted (`harness_info` reports them). A model that omits the key is *unknown*: no level is
   assumed, and only check 2 applies. An empty list accepts no level.
2. **Live ACP options.** When the harness advertises model-specific config options, an
   unsupported level is rejected; otherwise the harness validates the request. Because
   `session/set_model` drops the previous model's options, `set_model` always checks the level
   against the **new** model's advertised options.

On `set_model` the declared-level check runs **before** switching, so an undeclared level
leaves the model unchanged; a level rejected only by the new model's live options surfaces as
an error after the switch. Agy's Gemini 2.x models cannot apply this setting and reject it
explicitly. Omitting `thinking_level` behaves differently per tool: on `create_session` it
keeps the harness default; on `set_model` it changes only the model and leaves the reasoning
level untouched (it is **not** re-applied to the new model).

`permission_mode` accepts `read`, `edit`, `auto`, or `yolo` (default: `auto`). Routing is per
adapter: CodeBuddy maps the mode to `--permission-mode` on argv (it also receives `--model`
on argv, so the model is not re-set over ACP); Codex sends `session/set_config_option` with
`configId: "mode"`; Agy sends `session/set_mode` with the configured
`launch.agy_<mode>_mode_id` (`yolo` defaults to `yolo`; `auto` is skipped when unset).

`yolo` disables normal approval prompts where supported and maps to a harness-native mode:

| Harness | Native YOLO permission/mode |
| --- | --- |
| CodeBuddy | `bypassPermissions` |
| Codex ACP | `agent-full-access` |
| Antigravity ACP | `yolo` |

Agy's `launch.agy_yolo_mode_id` overrides its default mode id if needed. The former
`permission_mode: "bypass"` and `launch.agy_bypass_mode_id` are no longer accepted; rename
them to `yolo` and `agy_yolo_mode_id` respectively. YOLO grants broad tool execution
permissions: use it only in a trusted, isolated environment. Sources:
[CodeBuddy permissions](https://www.codebuddy.ai/docs/cli/permissions),
[Codex ACP modes](https://github.com/agentclientprotocol/codex-acp),
[Antigravity ACP mode mapping](https://github.com/tiezbro/paseo-agy-acp).

`create_session` covers the reference daemon's launch matrix:

| | `runtime: "direct"` | `runtime: "docker"` |
| --- | --- | --- |
| `target: "local"` | harness argv spawned locally | `docker run --detach --init --name …` then `docker exec -i --workdir <cwd> <name> <harness argv>` |
| `target: "remote"` | `ssh -- <host> '<wrapper running the harness>'` | the same, with the `docker exec` line inside the remote wrapper |

- **Docker options**: `docker_image` (new container), `docker_id` (full 64-hex id of an
  existing container to reuse), `container_policy` (`remove`/`keep`), `mounts`
  (`source`/`target`/`read_only`, bind-only), `ports` (`host_port`/`container_port`/
  `protocol`/`host_ip`), and `host_network`. `cwd` is a **container** path for docker and
  must be absolute; it is never bind-mounted. The container working directory is created with
  `docker exec … mkdir -p` (best effort) so `--workdir` can succeed.
- **Reused containers**: `docker start` is used instead of `docker run`, the container's real
  image, mounts, ports, and network are read back with a projected `docker inspect` (not
  guessed), and the default policy becomes `keep`. Supplying new-container options together
  with `docker_id` is rejected instead of silently ignored.
- **Kept container id**: with `container_policy: "keep"`, `create_session` adds a top-level
  `docker_id` — the container's real full 64-hex id, read from the supervisor's metadata —
  so the caller can persist it and `reuse` the container in a later session. A `keep`
  container is only **stopped** on close, never removed, so the id stays valid. A `remove`
  container reports no top-level `docker_id`, and a kept container whose id cannot be
  determined fails the create explicitly instead of returning a bogus reuse handle.
- **Remote**: the generated wrapper runs the harness in the background (`set -m`), records
  `pid`/`pgid` in a remote pid file, and on exit kills the whole remote process group and
  removes the pid file; the bridge also runs an explicit remote cleanup with the same
  timeout.
- **Cleanup policy**: the per-session supervisor owns cleanup. A session that prepared its
  container applies `container_policy` (`stop -t 0` for `keep`, `rm -f` for `remove`); a
  container whose preparation never completed is force-removed only when this session was
  creating it, and left untouched when it was reused — so a failed or killed launch can never
  delete the caller's reused container. Cleanup runs **exactly once** per session (the
  supervisor's idempotent `cleanup`), reaps an in-flight `docker run`/`start` first, terminates
  the harness process group, then releases the container/remote resources.
- **Process groups**: the supervisor spawns the harness (local, `docker exec`, or the `ssh`
  wrapper) as its own session leader, so terminating a session kills the harness's entire
  process group — and because the supervisor is a separate process in its own session, a
  SIGKILLed daemon cannot orphan it.
- `launch_info` in the create result echoes `target`, `runtime`, `permission_mode`, `cwd`,
  `remote_host`, `supervisor_pid`, `transport_pid`/`transport_pgid`, `remote_pid_file`, and
  for docker the container name, image, mounts, ports, and `host_network`.

**Authentication probing**: after `initialize`, a harness that advertises auth methods is
probed — the base adapters call `authentication/status`, CodeBuddy calls
`_codebuddy.ai/getUserInfo` — and a session that is not logged in is returned as
`authentication_required`, with `authenticate` completing the login. Account objects are
rebuilt from a display whitelist, so a harness token can never reach a result. A probe with
no reliable indicator is treated as "not authenticated" rather than guessed. `auth_info`
re-probes and returns the **latest** whitelisted account; a probe can only confirm a login,
never revoke an already-ready session.

**Authentication limits** are enforced by one coordinator for every path, including the
`create_session` `authenticate` convenience parameter (which therefore cannot bypass them):

- a persistent **per-target attempt ledger** (`min_interval_seconds`, `max_attempts`,
  `window_seconds`) keyed by an opaque SHA-256 hash of `harness + launch mode + ssh host`,
  so a limit survives a daemon restart; the JSON file is written atomically with mode 0600
  and holds only hashes and timestamps. Disabling `rate_limit` skips the file entirely;
- **same-target serialization**: a second session on a busy target gets
  `authentication_in_progress` (`poll_after_seconds`), and repeated `authenticate` calls on
  one session coalesce into a single credential write;
- **`max_concurrent_targets`** bounds how many distinct targets authenticate at once;
- on **`authentication.timeout_seconds`** the session is closed and its container/remote
  resources released per policy, returning `authentication_timed_out`.

### Polling

`send_message` returns only the id, and a session has at most one message in flight. Poll with:

```
message_result { session_id, message_id? }   -> status; text/tool_calls only once terminal
live_output    { session_id, message_id?, offset?, max_bytes?, stop? }
```

With `message_id` you get the full status (`state`, `terminal`, pending `interaction`,
`queue_position`, `error`); `text`, `tool_calls`, and `harness_session_id` appear **only once
the message is terminal**, so a non-terminal poll can never be mistaken for a final answer
(use `live_output` for the partial preview). Without `message_id` you get whole-session status.

Terminal states are `completed`, `failed`, and `cancelled`, and `message_result` carries an
explicit `terminal` boolean. `waiting_input` means an **interaction** request is pending and
must be answered with `answer_question`. A harness permission and information request are
unified into the same interaction object; only `interaction.permission` tells them apart, and
it is `true` for a permission request and `false` for an information request.

`answer_question` takes `answer: "accept" | "reject" | "timeout" | "cancel"` (default
`"accept"`). `accept` carries the concrete `response` (`{ option_id }` for permission, the
answer object for information). The non-accept answers carry no payload; they differ in
intent and are routed to the ACP outcome that matches the interaction type:

| `answer` | permission interaction | information interaction |
| --- | --- | --- |
| `accept` | `{ outcome: { outcome: "selected", optionId } }` (validated) | `{ content }` (or `{ action: "accept", content }` for elicitation) |
| `reject` | offered reject/deny option when present, else `{ outcome: { outcome: "cancelled" } }` | no protocol decline exists → the turn is cancelled (`cancel_reason: "rejected"`) |
| `timeout` | `{ outcome: { outcome: "cancelled" } }` | elicitation → `{ action: "cancel" }`; plain information → the turn is cancelled (`cancel_reason: "interaction_timeout"`) |
| `cancel` | `{ outcome: { outcome: "cancelled" } }` (never a deny option) | elicitation → `{ action: "cancel" }`; plain information → the turn is cancelled (`cancel_reason: "user_cancel"`) |

`reject` is a "soft no": for a permission it selects an offered deny option when one exists,
leaving the harness free to continue. `timeout` is an implicit non-answer (no decision was
made in time), and `cancel` is an explicit caller withdrawal — it never picks a deny option
and, for an elicitation, tells the harness the whole request was withdrawn. A
`reject`/`timeout`/`cancel` that the harness still accepts leaves the message running; when
the harness reports a cancellation the message becomes `cancelled`. Answers from a closed or
restarted session carry additional flags (`persisted`, `orphaned`);
see [Reading a closed or restarted session](#reading-a-closed-or-restarted-session).

### Failure classification

A message never "partially succeeds": a protocol or limit failure **fails** the message,
discards its final `text`/`tool_calls`, and reports status plus a machine-readable
`error.code` and a redacted `error.message`. The raw harness stream is never returned; any
already-streamed output remains available as a diagnostic preview through `live_output`.

| `error.code` | Meaning |
| --- | --- |
| `invalid_json` | A stdout line was not valid JSON. |
| `malformed_message` | Valid JSON, but not a recognized JSON-RPC response/request/`session/update`, a non-object frame, or a response to an id the bridge never sent. |
| `line_too_large` | A single stdout line exceeded `buffers.max_read_bytes`. |
| `output_limit` | The stream exceeded the bounded discard budget (one line far over the limit, or a flood of oversized lines). |
| `output_timeout` | No harness response arrived within `transport.turn_timeout_seconds` (or the startup handshake within `startup_timeout_seconds`). |
| `transport` | The harness process/stdin failed, the transport closed mid-turn, or the connection was unavailable. |
| `acp_rpc_error` | The harness returned a JSON-RPC error for a request. |
| `interrupted` | A daemon restart orphaned the message (see below). |

`invalid_json`, `malformed_message`, `line_too_large`, `output_limit`, and `output_timeout`
close the transport, so a follow-up submission on the same session fails fast with `transport`
rather than dangling; close the session and create a new one.

### `live_output` semantics

- `offset` is an **absolute byte offset** into the session preview stream. Omit it to start
  at the message's own output window.
- Re-pass `next_offset` on the next call to continue where you stopped.
- `truncated: true` means the requested offset fell behind the retained rolling window;
  the read is clamped forward and `dropped_bytes` reports the gap, so a poller can
  resynchronize instead of silently losing data.
- `stopped: true` means no further output can arrive (the message is terminal and all of
  its output was delivered, or the session is closed). `stop: true` stops immediately.
- `wait_ms` (max 30000) turns the call into a **long-poll**: it listens on the preview file
  via `fs.watch` (with a short interval fallback) and returns as soon as new output arrives
  or the message settles, so a client does not have to busy-poll. `waited_ms` reports how
  long it waited. The in-place truncation the rolling window performs is handled, watchers
  are always cleaned up, and a client disconnect aborts the wait.
- Offsets are byte-based, so a chunk boundary may split a multi-byte UTF-8 character.

### Completion notifications

MCP has no reliable server-initiated callback for "this background turn finished". The
bridge does **not** invent one. It advertises the standard `logging` server capability
during initialize and then emits a best-effort `notifications/message` logging notification
(`data.event: "message_complete"`) when a submitted message reaches a terminal state.
Clients may ignore or throttle notifications, so **polling is always the authoritative
path** and is never disabled.

## Persistence layout

```
~/.harness-acp-bridge/<YYYY-MM-DD>-<random>/
  raw.jsonl     append-only, redacted raw ACP traffic (client requests + stdout + stderr)
  log.txt       append-only human-readable lifecycle log
  preview.txt   size-capped rolling preview, appended incrementally (tail-able)
  state.json    atomic session-state snapshot
  queue.json    atomic queue / per-message state snapshot, including the hashed
                send_message idempotency index (committed with the message)
  results/      atomic per-message result snapshots (<message_id>.json)
  meta.json     atomic session metadata: creation params + effective echo, redacted
```

Snapshots are written with a temp file + `rename`, so a reader (or a restarted process)
never sees a half-written file. `state.json`, `queue.json`, and `results/*.json` are
sufficient to read a closed session's status and results after a restart, and `queue.json`
alone carries the idempotency index. (An earlier layout's standalone `idempotency.json` is
still read as a fallback but is no longer written.)

### Reading a closed or restarted session

`message_result` and `live_output` keep working for a session that is no longer live:

- **After `close_session`** the session leaves the live registry, and both calls are served
  read-only from the session directory (`state.json` + `queue.json` + `results/`). The answers
  carry `persisted: true`.
- **After a daemon restart** the in-flight message that the previous run left behind is
  reconciled exactly once into the terminal state `failed` with `error.code:
  "interrupted"`, `orphaned: true`, and the session state becomes `interrupted`. This is
  written back to disk, so a message can never stay non-terminal forever and the answer is
  stable on every later read. The partial output the turn had produced is still readable
  through `live_output`.

The recovery path is deliberately narrow: the session id must be a single path segment, the
directory must resolve under the configured `paths.session_dir`, and it must be a real
directory (not a symlink) whose realpath is exactly `<session_root>/<session_id>`. Snapshot
and preview files are only read when they are regular, non-symlinked files. Session ids are
never trusted as paths.

`send_message` to a non-live session is rejected with `unknown_session`, **except** when an
`idempotency_key` is supplied that was already used in that session: the response is then the
original `message_id` (a safe retry), and a mismatched text/mode is `idempotency_conflict`.
This is what makes a retried submit safe across `close_session` and a daemon restart.

`create_session` never writes into or through an existing path: an explicit `session_id`
that already exists is rejected with `session_exists`, and a failed creation removes only
the directory that call created.

## Security

- The daemon listens on a **Unix socket only** (no TCP), created with mode `0600` inside a
  `0700` directory, so only the owning user can reach it.
- A PID lock file (`0600`) with stale-lock takeover plus the socket bind enforce a single
  daemon per socket.
- Callers choose *where* and *how* a harness runs, but only through a validated allow-list.
  Rejected outright (`launch_internal`): `command`, `args`, `env`, `ssh_command`, `ssh_args`,
  `ssh_host`, `launch_mode`, `docker_command`, `entrypoint`, `base_dir`, `session_dir`,
  `state_dir`, `max_read_bytes`, `max_output_bytes`, and the other launch internals — those
  come from the configuration file only. Accepted and strictly validated: `target`,
  `remote_host`, `runtime`, `docker_id` (full 64-hex), `docker_image`, `container_policy`,
  `mounts`, `ports`, and `host_network`; a reused `docker_id` rejects new-container options
  instead of silently ignoring them, and `cwd` is never bind-mounted.
- Each session is run by its own **supervisor process**, spawned in a separate session. The
  daemon never spawns the harness directly, so a SIGKILLed or crashed daemon cannot orphan the
  harness: the supervisor detects the loss (its pipe reaches EOF, its parent changes, or the
  daemon pid is gone), terminates the harness process group (`SIGTERM` → grace → `SIGKILL`),
  and releases the container/remote per policy — force-removing a container it may have
  half-created and leaving a caller-owned reused container untouched.
- Session directories are claimed with an exclusive atomic `mkdir` (no check-then-create
  race), so two concurrent `create_session` calls with the same `session_id` cannot share a
  directory, and a failed create only removes the directory it claimed.
- Every persisted record, the raw stream, the stderr tail, and the session metadata pass
  through key-based and text-based credential redaction. Account objects are rebuilt from a
  display whitelist, so harness tokens never reach a result or the disk.
- Session directories are `0700`, files `0600`.
- Bounds: IPC request/response lines (16 MiB), a single prompt (1 MiB), a single ACP line
  (`buffers.max_read_bytes`), and `live_output` chunks (default 64 KiB, max 1 MiB). A violation
  of the ACP output bounds **fails the message** (`line_too_large`/`output_limit`) instead of
  being skipped, and the raw stream is never returned to a caller.
- Credentials are never accepted over IPC; authentication is delegated to the harness
  through ACP `authenticate`.
- The authentication attempt ledger holds only SHA-256 target hashes and timestamps, is
  written atomically (temp file + `rename`) with mode `0600`, and is serialized within the
  single writer daemon.

## Publishing (maintainers)

```bash
npm ci
npm run check
npm pack --dry-run              # review the file list; prepack rebuilds dist/
npm audit --omit=dev
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/   # account must own the @black942026 scope
npm publish --access public     # prepublishOnly runs check; prepack rebuilds dist/
```

Review the tarball before publishing: it should contain only `dist/`, `package.json`,
`config.example.yaml`, `README.md`, and `LICENSE`. Never include local configs, credentials,
session state, or `node_modules/`. Publishing requires the scope's permissions and npm's
current authentication/2FA requirements. The default version is `0.1.0`, a non-prerelease
version; choose `1.0.0` only when you intend to commit to a stable compatibility contract.
For later releases, use `npm version patch|minor|major` from a clean working tree to update
both manifests; MCP/ACP handshake versions follow `package.json` automatically. Run the
checks again for the new version, push the commit/tag, then publish. Never reuse a published
version. GitHub Actions CI on Linux/macOS and a real harness smoke test are recommended
before the first release (the e2e suite below uses mocks).

## Not implemented (honest limitations)

- **Cross-process ledger coordination** — the reference used SQLite so several processes
  could share one ledger atomically. This port uses a JSON file guarded by an in-process
  mutex, which is correct for the single-writer daemon (the socket+lock guarantee one daemon
  per config), but two daemons pointed at the same `ledger_path` could race. Use distinct
  `ledger_path` values if you intentionally run parallel daemons.
- **Escaped processes** — the supervisor reaps the harness process group it created, which
  covers a harness and its children for local, `docker exec`, and `ssh` launches. It cannot
  account for a process the harness deliberately detaches into a new session/process group
  (`setsid`, daemonizing, `--bg`), for work already handed to a real remote host or container
  that ignores the kill, or for the case where the supervisor itself is SIGKILLed before its
  cleanup runs (the daemon's close path closes stdin first and only escalates to `SIGKILL`
  after the grace budget, so the normal and daemon-crash paths both clean up).
- **No real remote / Docker / account testing** — the end-to-end suite drives mock `docker`
  and `ssh` CLIs plus a fake ACP harness, so the constructed argv, lifecycle, cleanup,
  mode routing, and auth probing are verified, but no real container, SSH host, or vendor
  account was exercised. Docker-specific behaviours that only a real engine exhibits (image
  pulls, port conflicts, `--init` semantics, inspect field differences) are therefore
  unverified.
- **Container reuse discovery** — the bridge does not list or discover containers, and it
  does not remember them between runs. A `keep` container does hand its id back at the
  `create_session` top level (see [Launching a session](#launching-a-session)) so a caller can
  persist and reuse it, but that id is the caller's to keep; `launch_info` for a reused
  container reflects only the projected inspect fields (image, bind mounts, ports, network
  mode).
- **`resume_session_id`** is passed through as `session/load`; whether a harness can actually
  resume is harness-specific and not validated.
- **MCP resource/prompt surfaces** and harness `fs`/`terminal` ACP client capabilities are not
  implemented (the transport advertises them as unsupported).
- **ACP elicitation** is supported in **form mode only**, declared as
  `clientCapabilities.elicitation = { form: {} }` during `initialize` and relayed through the
  `answer_question` interaction (`accept` with content, or `decline`/`cancel`). A form is the
  in-connection structured form the bridge can safely relay; **URL mode is not supported and is
  deliberately never advertised**, because a URL elicitation is an out-of-band browser
  authorization whose credentials must not pass through ACP or the bridge. A harness that
  requests `mode: "url"` gets JSON-RPC `-32602` rather than a false acceptance, and a mode-less
  request is treated as the MCP-style form default for compatibility. The bridge does **not**
  expose MCP's own elicitation capability to its MCP client; it relays ACP elicitation through
  `answer_question` instead. Any other unrecognized JSON-RPC notification (for example
  `elicitation/complete`, which only URL mode would need) fails the message as
  `malformed_message`.
- **Live turn resumption after a daemon restart** — a restarted daemon (or a closed
  session) can *read* the previous run's state, results, and preview, and reconciles
  in-flight messages to a terminal `failed` / `orphaned` state, but it cannot resume the
  turn: the harness process is gone and no new turn is started for it.
- **Platform** — modes/kill semantics assume POSIX (`0600` sockets, `killpg`, the remote
  wrapper's `ps -o pgid=`). macOS and Linux are the supported platforms; Windows is not
  supported.
