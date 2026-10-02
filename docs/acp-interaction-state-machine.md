# ACP Interaction State Machine

This document defines the session lifecycle and the single-operation interaction state
machine that governs how `BridgeSession` (src/session.ts) drives the ACP transport
(`AcpClient`, src/acp.ts). It records the invariants behind turn settlement, cancellation,
and the `busy` rules enforced on `send_message` / `set_model`.

## Two independent state axes

The session tracks **two independent axes** that must never be conflated:

1. **Message states** (per message, persisted): `queued` → `running` → `waiting_input` →
   one of the terminal states `completed` | `failed` | `cancelled`. A message reaching a
   terminal state is a *bridge-side bookkeeping* event; it does **not** by itself prove that
   the harness interaction has settled.

2. **The session operation slot** (derived, at most one at a time). The harness speaks one
   turn at a time over one JSON-RPC connection, so the session has a single operation slot
   reported as `operation` in the session status payload (`message_result` without
   `message_id`):

   | operation         | meaning                                                                    |
   | ----------------- | -------------------------------------------------------------------------- |
   | `idle`            | no in-flight work; new messages / model switches may start immediately      |
   | `accepting`       | a message was accepted but the queue pump has not picked it up yet          |
   | `running`         | a message's turn is in flight on the harness                               |
   | `waiting_input`   | the harness asked a reverse question and no answer arrived yet              |
   | `switching_model` | a `set_model` is in flight                                                 |
   | `cancelling`      | every message is terminal already, but the previous ACP `session/prompt`    |
   |                   | has **not settled** yet (a cancel is being confirmed with the harness)      |

   Message terminal states are independent of the operation slot: a message can be
   `cancelled` while the operation is still `cancelling`.

## The settlement invariant

**The only safe boundary between two turns is the JSON-RPC settlement of
`session/prompt`.** A turn is settled when the harness sends the response *or* the error
for the `session/prompt` request — nothing else (not `session/cancel` being sent, not the
message being marked terminal, not a stop notification) proves the harness released the
turn.

Consequences:

- While the previous `session/prompt` is unsettled, the operation slot is **not** `idle`
  (`cancelling` in the post-cancel window) and both `send_message` and `set_model` are
  rejected with the `busy` error. Idempotent replays of an already-accepted
  `idempotency_key` remain allowed during this window (they never touch the harness).
- `waitForTurnEvent` keeps the turn installed until the prompt response wins the race; a
  turn timeout (`output_timeout`) does **not** clear it — the turn stays installed until
  `cancelTurn()` observes settlement or fatally closes the transport (below).

## Cancellation and the cancel-timeout rule

`cancelTurn()` performs, in order:

1. Answer any pending interaction the way a cancellation requires (deny option,
   `cancelled` outcome, or elicitation `cancel`).
2. Send the `session/cancel` notification.
3. **Wait for the `session/prompt` settlement** with a bounded budget
   (`cancelTimeoutMs`, `turn_cancel_timeout_seconds` in the configuration).

Then:

- **Settled in time** → the turn is cleared, the session stays alive and returns to
  `idle`. (A late *duplicate* response for an already-settled request id finds no pending
  entry and is treated as a malformed stream — the transport is fatally closed; see below.)
- **Not settled in time** → the harness ignored `session/cancel` and the stream is out of
  sync: further output can no longer be attributed to any turn. The transport is
  **fatally closed** (`fatal()`): every outstanding request is rejected, the harness
  process group is terminated, and the client is marked broken. `cancelTurn()` does **not**
  clear the turn, and no new turn can ever begin on this client (`beginTurn` refuses
  because the transport is no longer running). The session observes the transport death
  (`exit`/`closed` events), fails the in-flight message, and marks itself `state: failed`
  so every further mutating call fails with `session_failed`.

This is the fix for the historical bug where `cancelTurn()` called
`await waitFor(turn.promise, cancelTimeoutMs)` and ignored the returned boolean: after a
cancel timeout it cleared the turn and accepted new requests while the harness was still
running the old prompt — any late response for the old request id then arrived on a stream
that a *new* turn considered clean, and was either misattributed or killed the new turn.

## Desynchronization paths

Every path that breaks the framing/attribution assumptions closes the transport instead of
resynchronizing:

| path                                 | handling                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| invalid JSON line                     | `fatal`, message `failed` (`invalid_json`)                             |
| oversized line / discard budget       | `fatal`, message `failed` (`line_too_large` / `output_limit`)          |
| unrecognized JSON-RPC frame (incl. a response for an unknown request id, e.g. a late duplicate) | `fatal`, message `failed` (`malformed_message`) |
| unsupported elicitation mode          | answered `-32602`; the stream stays in sync                            |
| `waitForTurnEvent` timeout            | turn stays installed; caller must `cancelTurn()`                       |
| `cancelTurn` settlement timeout       | `fatal`; session becomes unusable (`state: failed`)                    |
| harness process exit / transport close| in-flight message `failed` (`transport`); session `state: failed`       |
| `waiting_input` + transport gone      | waiter is woken by the transport events; message `failed`              |

Rationale: once a stream is out of sync there is no protocol-level way to resynchronize a
newline-delimited JSON-RPC connection — any "skip and continue" risks attributing an old
frame to a new turn, so the bridge always fails closed.

## Interaction (waiting_input) sub-state

While `running`, the harness may issue a reverse request (`session/request_permission`,
`session/request_input`/`..._information`/`..._user_input`, `elicitation/create`). The
operation moves to `waiting_input`; the message state mirrors it. An answer
(`answer_question`) resumes `running`; `reject`/`timeout`/`cancel` either route a protocol
decline or (for plain information requests, which have none) end the turn via
`cancelTurn()` with the message cancelled (`rejected` / `interaction_timeout` /
`user_cancel`). A `waiting_input` turn is still one unsettled `session/prompt`: the same
settlement invariant applies.

## Operation transitions (summary)

```mermaid
stateDiagram-v2
    idle --> accepting: send_message (accepted, pump pending)
    accepting --> running: pump picks up the message
    running --> idle: session/prompt settled (response or error)
    running --> waiting_input: harness reverse request
    waiting_input --> running: answer_question (turn resumes)
    running --> cancelling: turn cancelled (cancel_message / close / routed answer)
    waiting_input --> cancelling: turn cancelled (see note below)
    cancelling --> idle: prompt settled in time
    cancelling --> failed: cancel timeout / desync (transport fatal)
    idle --> switching_model: set_model
    switching_model --> idle: switch done
    failed --> [*]: transport gone; only read-only calls remain
```

The `failed` marker is the session **state** (`state: failed`); all other nodes are
operation-slot states. `send_message` / `set_model` are rejected with `busy` from every
operation state except `idle`.

### answer_question: non-accept answers per protocol path

An `answer_question` call only moves `waiting_input → running` when the answer was routed
to the harness as a protocol response. What `reject`/`timeout`/`cancel` do depends on the
request kind:

| request kind          | reject                              | timeout / cancel                     |
| --------------------- | ----------------------------------- | ------------------------------------ |
| permission            | offered deny option if one exists, else `cancelled` outcome | `cancelled` outcome (never a deny option) |
| elicitation           | `{action: "decline"}`               | `{action: "cancel"}`                 |
| plain information     | no protocol decline → cancels the turn | no protocol cancel → cancels the turn |

For permission and elicitation requests the harness receives a protocol answer and **may
continue running the turn** (`waiting_input → running`); whether the turn then completes,
ends `cancelled`, or asks again is the harness's decision. Only the plain-information
paths (and an explicit `cancel_message` / session close) end the turn bridge-side and move
the operation to `cancelling`; in every case the message is terminal before the slot
shows `cancelling`.

`cancelling` resolves either way: the `session/prompt` response (or error) arriving within
the cancel timeout returns the slot to `idle`; a harness that never settles it desyncs the
stream, the transport is fatally closed, and the session state becomes `failed`.

## Public contract additions (additive)

- The session status payload (returned by `message_result` **without** `message_id`)
  gained `operation` (`SessionOperation`), also persisted in the session state snapshot
  for diagnostics.
- New `SessionError` code `session_failed` — raised by mutating calls on a session whose
  transport died outside a normal close. Read-only calls (`message_result`,
  `live_output`) keep working on such a session so results remain readable.
- `send_message` / `set_model` may now answer `busy` in the `cancelling` /
  `switching_model` settlement windows even though every message is already terminal.
