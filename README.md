# harness-acp-bridge-server

A session-scoped HTTP server for ACP harnesses. It owns harness processes, serializes
message execution, records original traffic, and drives interactive authentication.

## Run

Requires Node.js >= 20.11 on macOS/Linux and separately installed ACP harnesses.

```sh
npm ci
npm run build
HARNESS_ACP_BRIDGE_CONFIG=./config.example.yaml npm start
```

The daemon entrypoint is `dist/main.js`, installed as the `hacpd` command; configuration is
resolved from `HARNESS_ACP_BRIDGE_CONFIG`, the XDG/default config location, then built-in
defaults. All settings use schema version 2; unknown fields and older schema versions are
rejected. Defaults bind `127.0.0.1:8787`.

For embedding, import `HarnessHttpServer` and `loadConfig` from the package, call
`start()`, and call `stop()` to close the listener and its sessions.

## Commands

Installing the package globally links two commands:

| Command | Entry | Purpose |
| --- | --- | --- |
| `hacpd` | `dist/main.js` | The daemon: reads configuration and serves the HTTP API. |
| `hacpr` | `dist/io/reader.js` | Streams a session's rendered output from its `raw.jsonl` journal. |

```sh
hacpd                                  # start the daemon (identical to npm start)
hacpr                                  # follow the most recent session
hacpr 2026-10-12-ab12cd34ef56          # follow a session by id
hacpr --once -J > events.jsonl         # dump what is on disk now as JSONL
hacpr -m msg_8f3c... -e                # only new events of one message
```

`hacpr` follows the journal until interrupted. `--once` emits what is already on disk and
exits, `-e/--from-end` skips the existing content, `-J/--json` writes one JSON event per line,
and `-m/--message` restricts output to a single `message_id`. In the text view the
`answer`/`reasoning`/`user` increments are written verbatim (safe to splice into a pipeline),
`stderr` goes to stderr, and structured events (`tool_call`, `lifecycle`, …) are prefixed with
`[type]`.

## Layers and layout

`src/` keeps only the exported `index.ts` and the `main.ts` daemon entrypoint (`hacpd`); the
implementation lives in focused directories:

| Directory | Contents |
| --- | --- |
| `transport/` | `stdio.ts` byte transport and `supervisor.ts` process/container supervision |
| `acp/` | `protocol.ts` ACP JSON-RPC correlation and vendor extensions |
| `adapter/` | `adapters.ts` per-harness argv, permission modes, and auth probing |
| `logic/` | `service.ts`/`session.ts` operations and state, plus `config.ts`, `auth.ts`, `create-params.ts`, `errors.ts` |
| `redact/` | `redact.ts`/`redact-core.ts` on-disk masking and `privacy.ts` account whitelist |
| `io/` | `persistence.ts` journal/snapshots, `runtime.ts` launch I/O, `reader.ts` cursor paging + `hacpr`, `entry.ts` entrypoint detection |
| `http/` | `server.ts` routing and JSON envelopes |

```text
Main agent --HTTP POST--> http/server.ts --> logic/service.ts + logic/session.ts
                                              |
                                              v
                                     acp/protocol.ts + adapter/adapters.ts
                                              |
                                              v
                                   transport/stdio.ts --stdio--> harness
                                              |
                                              v
                                          raw.jsonl
```

1. **Transport** manages byte streams, newline framing, and the supervisor. It writes
   original outgoing bytes before sending them, and incoming bytes before delivering
   complete lines to the adapter. It interprets no ACP or vendor methods. Oversized
   lines are journaled in bounded fragments rather than retained in memory.
2. **Adapter** implements ACP JSON-RPC and harness extensions for CodeBuddy, Codex,
   and Agy. It correlates requests/responses, maps session options and reverse questions,
   and reports unsupported requests, responses, and notifications with original content.
   Common ACP operations take priority; missing methods may use a harness extension.
3. **Logic** owns session operation slots, results, authentication coordination, idle
   reaping, and handshake/request/message/cancel/authentication/input deadlines. It
   decides whether to cancel a message or terminate its harness after an error.
4. **HTTP** validates JSON requests, routes the operations, and returns JSON envelopes,
   including client disconnects. There is no SSE stream.
5. **Preview** (`io/reader.ts`) is an internal, cursorable reader over `raw.jsonl`; it is not
   exposed over HTTP (the `hacpr` command drives it from a terminal). Callers observe progress
   through `message_status`. It has no preview file and retains no rolling text window.

The supervisor owns the local harness process group and SSH/Docker cleanup. Server
shutdown or loss of its parent/stdio triggers cleanup. One server owns a session directory;
`.server.lock` prevents a second listener from recovering a live server's sessions.

## HTTP API

All endpoints use **POST `/api/<name>`**, with `Content-Type: application/json`.
The body is the parameter object itself, without a JSON-RPC wrapper.

Successful responses have `{ "ok": true, "data": { ... } }`.
Errors have `{ "ok": false, "error": { "code": "...", "message": "...", "detail": ... } }`.
Invalid parameters return 400; missing sessions/messages return 404; busy/closed sessions
return 409; unsupported operations/responses return 501; deadlines return 504.

| Endpoint | Parameters and behavior |
| --- | --- |
| `ping` | `{}`. Server liveness, protocol version, PID, live-session count, config fingerprint. |
| `register_template` | `template` object. Validates and durably registers a launch template; duplicate names return `template_exists` (409). Starts no harness. Templates are **information only** — they are never passed to `create_session`. |
| `delete_template` | `name`. Deletes a registered template; unknown names return `template_not_found` (404). Existing sessions are unaffected. |
| `search_template` | Optional `name` (exact), `query` (case-insensitive substring of name/harness/description), `harness` (exact). Returns `{templates: [...]}` sorted by name; starts no harness. |
| `create_session` | Required `model_id` and `cwd`, plus the launch fields below. A `template`/`name`/`description` key is rejected as `unknown_param`. On success returns the session snapshot, including `session_id`, state, effective options, and launch info — with **no selected-template identity**. If the harness is not logged in, the session is created and kept alive but the call returns `authentication_required` (403) with `detail.next_action` (use that `session_id` with `authenticate`; do not re-create it). |
| `close_session` | `session_id`. Stops the harness and closes the session; repeated close is safe. Allowed even for a session that never authenticated. |
| `authenticate` | `session_id` only. Starts (or reuses, or, after a finished flow, restarts) an interactive login and returns the flow snapshot immediately. It never takes a `method_id`. |
| `auth_status` | `session_id`. While a flow exists, returns that flow's read-only snapshot — including a terminal `cancelled`/`failed` one with `questions: []` (no re-probe, no blocking); once the session is gone it returns `session_closed`. With no flow, probes the harness; an unavailable probe returns `unsupported_response` with original response/details, and an unknown status is never guessed as logged out. |
| `set_session_options` | `session_id` plus one or more of `model_id`, `thinking_level`, `permission_mode`. Applies only session settings, while idle. |
| `send_message` | `session_id`, `text`, optional `idempotency_key`. Returns only `{ "message_id": "..." }` after durable acceptance; execution is asynchronous. |
| `cancel_message` | `session_id`, `message_id`. Requests cancellation and waits for the original prompt to settle. An unconfirmed cancellation closes the session. |
| `message_status` | `session_id`, `message_id`. Returns state, `terminal`, pending `questions`, unsupported events, errors, and — while the message runs — an optional bounded, sanitized `progress` snapshot (`{text, reasoning, tool_calls}`). Terminal messages additionally include `result`. Works after close/restart. |
| `answer_question` | `session_id`, `request_id`, optional `answer` (`accept`, `reject`, `timeout`, `cancel`, default `accept`), `option_id`, `content`, and optional `message_id`. With a `message_id` the answer routes to that message's reverse question; without one it answers the session's authentication flow. Permissions require an offered option; information/form answers require an object validated against the question's schema. |

Authentication here is the child harness's login, not HTTP client authentication.
`create_session` accepts the launch executable itself (`command`/`args`/`env`) and Docker
`login_dirs`; the remaining launch plumbing — the SSH program and its arguments, `docker_command`,
state/session/metadata paths, and buffer bounds — stays server-owned and is rejected as
`launch_internal`. The trust boundary therefore lets a caller choose which executable launches, but
it is not a guarantee that an arbitrary binary is safe: the ACP handshake checks protocol
compatibility and validates the selected harness name when the process supplies `agentInfo`. Template APIs are administrative: this server has no
HTTP authorization layer; keep it on a trusted/loopback interface and do not expose registration to
untrusted callers.

`create_session` parameters:

- `model_id`, `cwd`: **required**.
- `harness`: `codebuddy`/`codex`/`agy` (otherwise the configured default harness).
- `command`: an absolute executable path or a single executable name; empty/omitted uses the
  harness's built-in command (`codebuddy`/`codex-acp`/`agy_acp_server`). A shell command string, an
  option-leading token, a relative path, or a NUL-bearing string is rejected.
- `args`: a list of argv strings (no NUL). Managed adapter flags (`--acp`, `--model`, …) and
  detaching arguments (`--bg`, `--tmux`, `--serve`, `setsid`, …) are rejected.
- `env`: a map of valid environment-variable names to strings (no NUL).
- `thinking_level`, `permission_mode` (`read`/`edit`/`auto`/`yolo`), `resume_session_id`,
  `session_id`.
- `target`: `local` (default) or `remote`; remote requires `remote_host` and local must omit it.
- `runtime`: `direct` (default) or `docker`.
- Docker: `docker_image` for a new container, or a full 64-character `docker_id` to reuse one;
  `container_policy` (`remove`/`keep`), `login_dirs` + `mounts`, `ports`, and `host_network`.
  Published ports cannot be combined with host networking. A reused container already fixes its
  image, mounts, ports, and network, so supplying them is rejected rather than silently ignored.

Permission modes are `read`, `edit`, `auto`, `yolo`. Adapters determine whether a particular
harness supports changing a mode live. In `yolo` mode, the server also intercepts reverse
`session/request_permission` requests (including during authentication) and automatically selects
the first offered option, in harness order, without exposing a pending client question. Empty
options or a first option without a valid `optionId` fall back to the normal question flow.
Information and elicitation requests remain interactive. Model IDs and thinking levels are supplied explicitly
(or mapped from template defaults) and validated against live ACP options when advertised,
otherwise by the harness request itself; no YAML candidate lists constrain them.

## Launch templates and command validation

Launch templates are **information only**. They live in a durable registry so a caller (commonly an
LLM) can read a known-good recipe, but `create_session` never references one: there is no `template`
parameter, no default merge, and no template identity in the snapshot. The intended flow is:

1. `search_template` (exact `name`, or `query`/`harness`) and read the full returned object.
2. Map non-null `model` → `model_id` and `thinking` → `thinking_level`, with user overrides taking
   priority. Ask only for a missing model or `cwd`. Follow `special_instructions` throughout.
3. The calling LLM executes `before_start` actions before startup, subject to user approval and
   safety rules. These are natural-language prompts, not bridge-executed shell/argv hooks.
4. Map Docker `network_mode` to session `host_network` (`host` → true; `none`/`proxy` → false)
   and pass the returned `env`. Drop `name`/`description`/`model`/`thinking`/`network_mode`/`proxy_port`/
   `before_start`/`after_start`/`special_instructions`
   and inapplicable fields; `create_session` accepts none of these template-only fields. Pass only
   allowed explicit parameters. Re-check combinations after overriding `runtime`/`target`.
5. Complete any required authentication, then the calling LLM executes `after_start` after
   successful startup before sending normal work. Stop and report failed actions or unavailable
   tools rather than claiming success. Registration/search never executes these prompts.

See [`templates/local.json`](templates/local.json) for a local/direct example and
[`templates/docker.json`](templates/docker.json) for a Docker example. The local example uses PATH
and the harness's existing local login. Replace the Docker example's image and host paths before
registering it, then expand it explicitly:

```sh
jq '{template: .}' templates/docker.json | curl -sS http://127.0.0.1:8787/api/register_template \
  -H 'Content-Type: application/json' --data-binary @-
# A session is a direct call: pass the expanded fields, never the template name.
curl -sS http://127.0.0.1:8787/api/create_session -H 'Content-Type: application/json' \
  -d '{"model_id":"claude-sonnet-4","cwd":"/workspace","harness":"codebuddy","runtime":"docker",
       "docker_image":"your-codebuddy-image:latest"}'
```

Template fields: `name` (unique identifier), `harness` (`codebuddy`/`codex`/`agy`), optional
`description`, `model`, `thinking`, `before_start`, `after_start`, `special_instructions`,
`target` (`local` by default), `remote_host`, `runtime` (`direct` by default),
`command`, `args`, `env`, `permission_mode` (`auto` by default), `cwd` (absolute path), and Docker
`docker_image`, `container_policy` (`remove`/`keep`), `login_dirs`, `mounts`, `ports`,
`network_mode` (`none`/`host`/`proxy`) and `proxy_port`. Both `login_dirs` and `mounts` are bind-mount lists with `{source, target,
read_only?}`; login mounts persist the harness's own credentials, not bridge credentials.
Source/target paths must be absolute, targets cannot repeat, and host networking cannot coexist
with published ports. Unknown fields, malformed data, Docker fields on a direct template, managed
adapter flags and detaching arguments are rejected as `invalid_template` (400). Registration
validates structure and argv without starting Docker or executing commands. `target: remote`
requires a nonempty `remote_host` (SSH hostname/alias, optionally `user@host`); a local template
must omit it or use null. Target and runtime are independent, allowing local/direct, remote/direct,
local/Docker and remote/Docker recipes.

`model` and `thinking` are optional nonblank, NUL-free strings (default null); they provide defaults,
not candidate lists. The three instruction fields are optional NUL-free natural-language strings
(default null, empty text is allowed) for the **calling LLM**. They are stored and returned verbatim,
never executed by the server, and never forwarded as session parameters. Legacy templates without
these fields still load with null defaults.

### Docker network modes

Choose exactly one template `network_mode`:

| Mode | Meaning | Session expansion |
| --- | --- | --- |
| `none` (default) | Ordinary Docker bridge network, no active proxy values | `host_network: false` |
| `host` | Host network, no active proxy values or published ports | `host_network: true` |
| `proxy` | Ordinary bridge network with a generic HTTP proxy, not tied to Xray | `host_network: false` and the generated `env` |

For `proxy`, specify only `proxy_port` (integer 1–65535). Registration generates both lowercase
`http_proxy` and `https_proxy` as `http://host.docker.internal:PORT` and `no_proxy` as
`localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local,.internal`.
Stale lowercase/uppercase proxy aliases (including ALL_PROXY) are replaced; unrelated env values
are preserved. `proxy_port` is required for `proxy` and must be omitted/null otherwise. `host`/`proxy`
require Docker; direct templates accept only the neutral `none` default.

See [`templates/docker-host.json`](templates/docker-host.json) and
[`templates/docker-proxy.json`](templates/docker-proxy.json). Their images/paths and the example
proxy port must be confirmed and replaced before registration. The fixed host address must be
reachable from the execution host's container network (the remote machine for SSH/Docker).
Container localhost is not the host. For a **new bridge container** whose proxy URL uses
`host.docker.internal`, the server adds `--add-host host.docker.internal:host-gateway` (Docker Engine
20.10+), on the actual execution host, including SSH targets. It does not modify proxy listeners,
host DNS, routing or firewalls. Reused containers are not rewritten: their existing network must
already resolve and reach the proxy; recreate an older Linux container with the host-gateway mapping
if needed.

Before starting a Docker harness with explicit active HTTP/HTTPS/ALL_PROXY env values, the server
runs a credential-free DNS/TCP check **inside the container**, bounded by the startup timeout and
at most five seconds. The image must provide `node` or `python3`. An invalid proxy URL returns
`invalid_proxy_configuration`; an unresolvable/unreachable proxy (or a missing probe runtime) returns
`proxy_unreachable`, before authentication begins. No proxy credentials or external login requests
are sent by this check. The normal container cleanup policy still applies on failure.

This check only proves access to the proxy listener, not proxy authentication, CONNECT/TLS to a
remote site, or successful login. The HTTP client must support the generated proxy settings/CIDR
bypasses. For example, a proxy's upstream DNS may fail even while the listener is reachable, and
host-only transparent proxy routing may not cover Docker bridge traffic. This config is not for
Docker daemon/image pulls or the Pi/MCP bridge client.

**No legacy template compatibility:** template `host_network` is rejected. Re-register old templates
using `network_mode`/`proxy_port`; an old on-disk registry containing removed fields must be replaced
before starting the server. `create_session` still uses explicit `host_network`/`env`, and rejects
`network_mode`/`proxy_port` as template-only fields. Registration/search never opens a connection.

Templates persist atomically in `<state_dir>/templates.json` (0600), survive server restarts, and
are returned by search in full. Non-proxy environment values are stored unchanged in this private registry;
do not put secrets in templates unless necessary. To change a template, delete then register it
again.

`create_session` reuses the same pure rule for a `command`/`args`/`env` that registration uses, so a
value accepted at registration is accepted at launch and vice versa. An *effective* Docker option (a
non-empty `login_dirs`/`mounts`/`ports`, a present `docker_image`/`docker_id`/`container_policy`, or
`host_network: true`) requires `runtime: docker`; neutral defaults (`[]`/`null`/`false`) are accepted
on a direct runtime so an expanded template can be passed verbatim, but their **types** are still
validated rather than silently ignored. For a new Docker container, `login_dirs` and `mounts` are
merged; after the merge the mount targets must be unique and the total is capped at 64. For
`runtime: docker`, `cwd` is the absolute path *inside the container*. All built-in adapters
(`codebuddy`, `codex`, `agy`) are always available without YAML declarations. Explicit session
`harness` wins; otherwise `default_harness` is used (omitted/null defaults to `codex`). A
`default_harness` override must name a built-in adapter. A YAML file is optional when all service
settings use defaults; explicit missing config paths remain errors rather than being ignored.

**Migration:** `search_harness` is removed (HTTP 404); use launch templates instead. Remove the
entire obsolete YAML `harnesses` section, including descriptions, model/thinking candidate lists,
and command/args/env declarations. Move desired launch/model/thinking defaults to templates or
explicit session fields. YAML containing `harnesses` or
`launch.codebuddy_command/codex_command/agy_command` is rejected.

A nonempty `command` takes priority (absolute path or executable name). Empty/null uses
`codebuddy`, `codex-acp`, or `agy_acp_server` on PATH. Local/direct checks the server's PATH;
SSH/direct checks the remote PATH; Docker checks PATH **inside the container** on its target.
Missing/non-executable commands return `command_not_found` (404); an invalid explicit command
never falls back to another executable. Container preparation is needed before its check.

Before opening an ACP session or probing authentication, `create_session` performs ACP
`initialize` with ACP v1. Its optional `agentInfo` may be omitted or `null` for any harness;
this means the identity is unknown and does not block session creation or authentication.
When `agentInfo` is supplied, `agentInfo.name` must match the selected harness (case-insensitive
exact known names: CodeBuddy `codebuddy`/`codebuddy-code`, Codex `codex`/`codex-acp`, Agy
`agy`/`agy-acp-server`/`agy_acp_server`/`antigravity`). A malformed or mismatched supplied identity
returns `invalid_harness_command` (400), never sends `session/new`/`session/load`, and closes the
process and cleans up resources according to container policy. Failed creation may retain a bridge
failure journal, but no usable ACP session. A non-ACP program or a hung handshake is rejected by
the normal protocol/startup validation and deadline. Identity is protocol compatibility validation,
not a cryptographic guarantee against a malicious command spoofing its own name.

## Authentication flow

`authenticate` takes only `{session_id}` and returns a flow snapshot immediately; it never
blocks on the login and never accepts a caller-chosen method. The snapshot is:

```json
{ "session_id": "…", "state": "waiting_input", "terminal": false,
  "questions": [ … ], "candidates": [ … ], "authenticated": true, "error": { … } }
```

- `state` is `waiting_input`, `authenticating`, `ready`, `failed`, or `cancelled`; a rate-limited
  attempt is `authentication_rate_limited` with `terminal: true`. An already logged-in session
  returns `ready` with `terminal: true`.
- `candidates` lists **every** advertised method as `{id, name, description?, type, supported}`.
  `type` defaults to `agent`; any other type is unsupported (its `description` carries exactly
  `Not supported in harness_acp_bridge`) and is never executed.
- The flow always begins with an **information** question whose schema requires
  `method_id: string` (an enum of the supported IDs); the message lists the candidates. A method
  is never auto-selected, not even with a single candidate.
- Further `questions` are ordinary reverse questions (`kind` `information`/`permission`/
  `elicitation`) with `{request_id, kind, title, message, options, schema, raw?}`. Answer them
  with `answer_question` and **no** `message_id`.
- A browser step (CodeBuddy's `_codebuddy.ai/authUrl`, an Agy stderr login URL, a Codex
  device-code URL elicitation) is a question whose message carries the full usable URL (and any
  machine code) and whose schema asks for `opened: true`. **Confirming is only an
  acknowledgement**: the session is `ready` only after the real harness `authenticate` call and
  the session open both succeed. Confirming and re-answering never revives a closed session.
- A `token`/`secret` step is an ordinary required-`string` schema answered as normal, and
  multi-round flows are supported.

Cancelling a started login abandons the in-flight request and takes the half-authenticated
session down (no `session/cancel` with a null id). Cancelling at method selection ends only the
flow. Answers are validated against the question schema; unknown or stale `request_id`s are
rejected, and a harness `elicitation/complete` withdraws any still-pending question.

If a harness is already logged in (for example a login completed outside the bridge),
`authenticate` does not re-prompt for a method or write credentials: it opens the existing
initialized session and reports `ready` only once that session is actually open. A genuine
auth-required during session setup keeps the initialized harness alive so `authenticate` can
finish it; an unrecoverable handshake failure closes it.

**Recovery after `create_session`.** An unauthenticated `create_session` returns
`authentication_required` with `detail.next_action = {method: "authenticate", params: {session_id}}`.
The session is already created and initialized: call `authenticate` with that `session_id` to
finish the login. Do **not** call `create_session` again with the same id — that is a
`session_exists` error, not the post-login step.

**After a flow ends.** `auth_status` returns the flow's terminal snapshot (`cancelled`/`failed`,
`questions: []`) while it is still available, or a clear `session_closed` once the session is
gone; it never re-prompts stale choices or keeps an input loop alive.

## Message execution and errors

A session has at most one nonterminal message. Another send or option change returns `busy`;
there is no server-side message backlog or implicit steering. The caller implements steering
by awaiting `cancel_message`, then issuing `send_message`.

Message states are `running`, `waiting_input`, `cancelling`, `completed`, `failed`, `cancelled`.
A terminal result contains `text`, `reasoning`, `tool_calls`, `stop_reason`, and `raw_result`.
Reasoning is limited to what the harness actually emits.

An optional idempotency key replays the original message ID for the same text within a live
session, and rejects reuse with different text. Its hash and identity are persisted in
`queue.json`; it never creates a second message while the original is running.

An oversized stdout line or unrepairable JSONL fails the active message and first sends
`session/cancel`. The slot stays occupied until the original prompt settles. If cancellation
times out, the session closes. Later correctly framed lines remain readable. Unknown
notifications are recorded and reported as unsupported while subsequent events continue.
Unsupported correlated responses fail the corresponding request and include original bytes.

Deterministic format repairs remove a leading UTF-8 BOM or ANSI escape envelope only in the
adapter's parsing copy. A complete final JSON object without a newline is also accepted.
The journal keeps the original bytes unchanged, including malformed text and vendor events.

Option changes occur in model/thinking/permission order. A later failure does not roll back an
already acknowledged earlier option; the session snapshot records confirmed effective values.
A request timeout closes the session to prevent a late reply from silently changing an idle
session. All deadlines are under `timeouts`; successful file writes allow forwarding without
per-event `fsync`.

## Waiting, activity, and channel EOF

A `running` state means the bridge is still waiting for the ACP `session/prompt` result; it does
**not** guarantee the model is still making progress. An idle-but-alive harness (CPU 0, no new
frames) and a stalled one are indistinguishable from state alone, so the server never fabricates a
terminal state for silence.

Each `message_status` (and the session snapshot) reports an `activity` object:

| Field | Meaning |
|---|---|
| `last_transport_event_at` | When the last complete stdout frame arrived (any frame, including RPC responses). `null` before any. |
| `last_progress_at` | When the harness last produced real output (answer/reasoning/tool frames) or asked a question. `null` if it never has. |
| `observed_phase` | Last observed phase: `thinking`, `responding`, `tool_use`, `usage`, `session_update`, or `waiting_input`. An observed `usage`/idle update is never treated as the prompt's final result. |
| `seconds_since_progress` | Seconds since `last_progress_at`, or since submission when the harness has produced nothing yet. |
| `seconds_since_transport_event` | Seconds since `last_transport_event_at`. |
| `stall_hint_seconds` | Configured `sessions.stall_hint_seconds` (default 120; `0` disables). |
| `stalled` | `true` when `running`, `stall_hint_seconds > 0`, and `seconds_since_progress` has reached it. Always `false` for a terminal message or while `waiting_input`. Advisory only. |

Only real model output — `reasoning`, `answer`, and `tool_call`/`tool_output` frames, plus an actual
reverse question — advances `last_progress_at`. Metadata frames (`usage_update`, config/session-info
updates, `checkpoint`/`command`) may update `observed_phase` and `last_transport_event_at` as
evidence, but a periodic usage/idle heartbeat **never** counts as progress and can never clear a
stall. Values are per message: a new message resets `last_progress_at`/`observed_phase` rather than
inheriting the previous message's. Polling `message_status` or `ping`, and
lifecycle/persistence work, **never** refresh these. A hint is only a hint: the server does not
auto-cancel a silent message, and the absolute `timeouts.turn_timeout_seconds` still governs the
hard deadline.

Channel EOF is terminal: if the ACP stdout channel closes — including a harness or supervisor that
closes stdout while its process stays alive — the running message converges to `failed` with
`transport_closed` and a `finished_at`; on-disk `queue.json`/`results/`/`session.json` agree with
`message_status`, and the busy slot is released (the session then rejects further sends as
`session_closed`). A message that already reached a terminal result is never overwritten by a later
EOF. `close_session`, `session_shutdown`, a supervisor/harness exit, and a server restart converge
the same way (`session_interrupted` across a restart).

## Progress snapshots

There is no public live-output endpoint and no SSE stream. A running message's `message_status`
carries an optional `progress` object — `{text, reasoning, tool_calls}` — that is bounded by
`buffers.preview_text_bytes` and sanitized through the same redactor as the persisted journal.
It is a snapshot (replace, not append) intended only for a UI preview; terminal messages drop it
and expose the complete `result` instead. The journal (`raw.jsonl`) remains the authoritative,
lossless record.

## Session files

```text
<session_dir>/<session_id>/
  raw.jsonl
  session.json
  queue.json
  results/<message_id>.json
```

`raw.jsonl` is append-only and combines lifecycle events and all original stdin/stdout/stderr
traffic. Each record has `version`, `seq`, `timestamp`, `session_id`, and `message_id`.
Transport records also have `stream`, `encoding: "base64"`, and `raw`; base64 preserves
exact bytes, whitespace, CRLF, invalid JSON, and non-UTF-8 protocol output. Oversized
stdout is split into records with `fragment: true`, preserving received bytes in order.
Lifecycle records have `event` and `data`. Raw records are not redacted or reserialized.

`session.json` combines metadata, state, and effective options. `queue.json` stores the
single active message, compact message states, and idempotency mappings. Results are
stored separately. Snapshots use atomic temporary-file/rename writes. Session directories
use mode 0700 and files 0600. The optional server-wide auth ledger and process lock live
outside individual session directories; supervisor metadata is temporary and removed on close.

After a restart, old session history remains readable and live sessions become `interrupted`.
An in-flight message becomes failed with `session_interrupted`; already committed terminal
results survive a stale queue snapshot. Recovery drops a crash's incomplete journal tail
before appending the recovery event. There is no automatic process reattachment.

## Validation

```sh
npm run check
```

Tests exercise built HTTP endpoints, real supervisor/child processes with a fake ACP harness,
wire preservation, session state transitions, reverse questions, deadlines, journal recovery,
interactive authentication flows, and UTF-8-safe persisted results. Docker/SSH launch tests use
local shims, not a real host, container engine, or paid model. The server's old Unix-socket
clients in sibling projects require a separate HTTP migration.
