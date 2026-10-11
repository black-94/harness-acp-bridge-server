# harness-acp-bridge-server

A session-scoped HTTP server for ACP harnesses. It owns harness processes, serializes
message execution, records original traffic, and renders human-readable live output.

## Run

Requires Node.js >= 20.11 on macOS/Linux and separately installed ACP harnesses.

```sh
npm ci
npm run build
HARNESS_ACP_BRIDGE_CONFIG=./config.example.yaml npm start
```

The service entrypoint is `dist/main.js`; the package has no CLI executables or MCP
server. Configuration is resolved from `HARNESS_ACP_BRIDGE_CONFIG`, the XDG/default
config location, then built-in defaults. All settings use schema version 2; unknown
fields and older schema versions are rejected. Defaults bind `127.0.0.1:8787`.

For embedding, import `HarnessHttpServer` and `loadConfig` from the package, call
`start()`, and call `stop()` to close the listener and its sessions.

## Five layers

```text
Main agent --HTTP POST--> http/server.ts --> logic/service.ts + logic/session.ts
                                              |
                                              v
                                  adapter/protocol.ts + adapters.ts
                                              |
                                              v
                                   transport/stdio.ts --stdio--> harness
                                              |
                                              v
                                          raw.jsonl
                                              |
                                              v
                                      preview/reader.ts --> live_output
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
4. **HTTP** validates JSON requests, routes the twelve operations, returns JSON
   envelopes, and handles client disconnects and SSE framing.
5. **Preview** reads `raw.jsonl` directly and renders actual harness reasoning, answers,
   tool calls, tool outputs, questions, and lifecycle events. It has no preview file and
   retains no rolling text window.

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
| `search_harness` | `harness?`. Lists configured harnesses, models, declared thinking levels, and permission modes. Starts no harness and performs no discovery probes. |
| `create_session` | Required `cwd`, `model_id`; optional `harness`, `thinking_level`, `permission_mode`, and launch fields below. Returns the session snapshot, including `session_id`, state, effective options, and launch info. |
| `close_session` | `session_id`. Stops the harness and closes the session; repeated close is safe. |
| `authenticate` | `session_id`, `method_id`. Authenticates the child harness and opens its session. Credential writes on the same target are serialized and optionally rate limited. |
| `auth_status` | `session_id`. Probes harness authentication. An unavailable probe returns an `unsupported_response` error with original response/details; unknown authentication is not guessed as logged out. |
| `set_session_options` | `session_id` plus one or more of `model_id`, `thinking_level`, `permission_mode`. Applies only session settings, while idle. |
| `send_message` | `session_id`, `text`, optional `idempotency_key`. Returns only `{ "message_id": "..." }` after durable acceptance; execution is asynchronous. |
| `cancel_message` | `session_id`, `message_id`. Requests cancellation and waits for the original prompt to settle. An unconfirmed cancellation closes the session. |
| `message_status` | `session_id`, `message_id`. Returns state, `terminal`, pending `questions`, unsupported events, and errors. Terminal messages additionally include `result`. Works after close/restart. |
| `live_output` | `session_id`, optional `message_id`, `cursor`, `limit`, `wait_ms`. Returns paged journal-derived human-readable events; optionally SSE. |
| `answer_question` | `session_id`, `message_id`, `request_id`, optional `answer` (`accept`, `reject`, `timeout`, `cancel`, default `accept`), `option_id`, `content`. Uses the child harness's original RPC ID. Permissions require an offered option; information/form answers require an object. |

Authentication here is the child harness's login, not HTTP client authentication.
Commands, argv, environment, SSH/Docker programs, state paths, and buffer settings are
administrator-owned configuration, not request parameters.

`create_session` launch fields:

- `target`: `local` (default) or `remote`; remote requires `remote_host`.
- `runtime`: `direct` (default) or `docker`.
- Docker: `docker_image` for a new container, or full 64-character `docker_id` for reuse;
  `container_policy` (`remove`/`keep`), `mounts`, `ports`, and `host_network`.
- `resume_session_id`: ask the harness to load its own existing session history.
- `session_id`: optionally choose a new bridge session ID; existing directories are never overwritten.
- `authenticate`: optional method ID, routed through the same authentication coordinator.

Permission modes are `read`, `edit`, `auto`, `yolo`. Adapters determine whether a particular
harness supports changing a mode live. Declared `thinking_levels: []` means none;
omission means unknown, checked against live ACP options when available.

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
inheriting the previous message's. Polling `message_status`, `ping`, or `live_output`, and
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

## Live output, cursors, and SSE

```json
{ "session_id": "<session>", "message_id": "<message>", "limit": 100, "wait_ms": 15000 }
```

The response data contains `events`, `next_cursor`, `has_more`, `session_closed`, and `terminal`.
Pass `next_cursor` unchanged as the next request's `cursor`. Cursors bind to the session and
optional message filter; changing either invalidates the cursor. They contain the raw-file
byte position and position within a rendered event, and survive process restarts.

`limit` counts returned event fragments, from 1 to `buffers.preview_page_events`.
Large text is split at UTF-8 boundaries according to `buffers.preview_text_bytes`;
`complete: false` means the same event continues on the next fragment. Join matching
`seq`/`type` text fragments in order. The cursor also handles multiple rendered events
from a single tool record. Polling never loses older output to preview-window eviction.

`wait_ms` ranges from 0 to 60000. At EOF a live session can wait for an append, disconnect,
or deadline. Always drain `has_more`, even when `terminal` is true. Without `message_id`,
`terminal` means session closure; with it, it means message completion.

To stream, POST the same JSON with **`Accept: text/event-stream`**. Each `event: output`
contains a JSON `{ "ok": true, "data": <page> }` envelope and its next cursor as the SSE
`id`. Reconnect by POSTing that cursor in the body. Use a POST-capable streaming client
such as fetch; browser `EventSource` only supports GET. The stream ends after terminal
output is drained, or on disconnect. Errors after stream headers use `event: error` with
a JSON error envelope; earlier errors remain ordinary JSON HTTP responses.

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
UTF-8 cursor pagination, and SSE. Docker/SSH launch tests use local shims, not a real host,
container engine, or paid model. The server's old Unix-socket clients in sibling projects
require a separate HTTP migration.
