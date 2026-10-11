# Session operation state machine

The logic layer owns one operation slot per session. Starting, authentication, option
changes, a running message, pending input, and cancellation occupy that slot. A new
message or option change is accepted only while idle and ready.

```mermaid
stateDiagram-v2
    [*] --> starting
    starting --> idle: handshake and session open
    starting --> authentication_required: login needed
    authentication_required --> authenticating: authenticate
    authenticating --> idle: session ready
    idle --> setting_options: set_session_options
    setting_options --> idle: acknowledged / supported failure
    idle --> running: send_message
    running --> waiting_input: reverse question
    waiting_input --> running: answer_question
    running --> cancelling: cancel / timeout / JSONL error
    waiting_input --> cancelling: cancel / input timeout
    cancelling --> idle: original prompt settles
    cancelling --> closed: cancellation timeout
    running --> idle: prompt completes
    idle --> closed: close / idle timeout
    closed --> [*]
```

A cancelled message becomes terminal only after the ACP prompt has settled or the transport
has closed. The slot stays occupied during cancellation, so a late completion cannot overlap
with a new prompt. `cancel_message` waits for this boundary; callers can then send their
replacement message. A cancellation timeout closes the session instead of allowing reuse.

`message_status` always addresses a message ID. Pending questions include original request
IDs and offered permission options; `answer_question` validates the pending question and
routes the selected answer using the original RPC ID. Completed/failed/cancelled messages
include a result. `live_output` derives preview pages from `raw.jsonl` throughout the lifecycle.

Unexpected or unsupported notifications are recorded without releasing or failing the message
slot. Invalid JSONL and oversized lines request cancellation before session termination.
Generic request, handshake, and authentication timeouts close the session to prevent late
state changes. Restart marks live sessions interrupted and preserves completed results.
