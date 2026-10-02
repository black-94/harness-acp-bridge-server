#!/usr/bin/env node
/**
 * MCP stdio server: a thin client over the daemon.
 *
 * Every tool is a single IPC call. `send_message` is asynchronous by contract: it returns
 * only `{ message_id }` immediately and the upstream polls `message_result` / `live_output`.
 * Nothing here blocks on a harness turn.
 *
 * Completion notifications: MCP has no reliable server-initiated callback for "this tool's
 * background work finished". Rather than invent one, the bridge only emits the standard
 * `notifications/message` logging notification when the client has negotiated the `logging`
 * capability, and polling always remains the authoritative path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CLIENT_VERSION } from "./acp.js";
import {
  createSessionTimeoutSeconds,
  configArgument,
  harnessInfo,
  loadConfig,
  resolveConfigPath,
  type BridgeConfig,
} from "./config.js";
import { DaemonClient, IpcError } from "./ipc.js";

const SERVER_NAME = "harness-acp-bridge";
const NOTIFICATION_LOGGER = "harness-acp-bridge";
const WATCH_INTERVAL_MS = 500;
const MAX_WATCH_MS = 60 * 60 * 1000;
/**
 * Extra IPC budget on top of the daemon's authentication timeout.
 *
 * Interactive harness authentication can legitimately take minutes. The daemon owns the real
 * limit (`authentication.timeout_seconds`) and returns `authentication_timed_out`; this grace
 * only ensures the caller waits long enough to receive that clean result.
 */
const AUTH_IPC_GRACE_MS = 15_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof IpcError) return error.code;
  if (error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if (error instanceof Error) return error.name;
  return "error";
}

async function guard(operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return textResult(await operation());
  } catch (error) {
    return textResult(
      {
        status: "error",
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Send a best-effort completion notification.
 *
 * The bridge advertises the `logging` server capability during initialize, so emitting
 * `notifications/message` is negotiated rather than invented. MCP has no reliable
 * server-initiated callback for a finished background turn, and clients may ignore or
 * throttle notifications, so polling remains the authoritative path and callers must
 * always poll `message_result`.
 */
async function notifyCompletion(
  server: McpServer,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await server.sendLoggingMessage({
      level: "info",
      logger: NOTIFICATION_LOGGER,
      data: { event: "message_complete", ...payload },
    });
  } catch {
    // Notifications are advisory; polling is authoritative.
  }
}

export function createBridgeServer(
  daemon: DaemonClient,
  config: BridgeConfig,
  configPath: string | null,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: CLIENT_VERSION },
    // Advertise the logging capability during initialize so completion notifications are
    // negotiated. The tools capability is merged in when tools are registered.
    { capabilities: { logging: {} } },
  );
  const activeWatches = new Set<string>();

  const watchUntilTerminal = (sessionId: string, messageId: string): void => {
    const key = `${sessionId}:${messageId}`;
    if (activeWatches.has(key)) return;
    activeWatches.add(key);
    void (async () => {
      const deadline = Date.now() + MAX_WATCH_MS;
      try {
        while (Date.now() < deadline) {
          await sleep(WATCH_INTERVAL_MS);
          const status = await daemon.call("message_result", {
            session_id: sessionId,
            message_id: messageId,
          });
          if (status.terminal === true) {
            await notifyCompletion(server, {
              session_id: sessionId,
              message_id: messageId,
              state: status.state,
            });
            return;
          }
        }
      } catch {
        // The watcher must never surface an error; the caller polls.
      } finally {
        activeWatches.delete(key);
      }
    })();
  };

  const sessionId = z.string().min(1).describe("Bridge session id returned by create_session");

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check whether the bridge daemon is running; returns its pid and config fingerprint.",
      inputSchema: {},
    },
    async () => guard(() => daemon.call("ping")),
  );

  server.registerTool(
    "create_session",
    {
      title: "Create session",
      description:
        "Start a harness ACP session. Supports local and remote (SSH) targets and direct or " +
        "Docker runtimes, including creating or reusing a container with explicit mounts, " +
        "ports, and host networking. Errors carry a code such as session_exists, invalid_param, " +
        "or launch_internal.",
      inputSchema: {
        cwd: z.string().min(1).describe("Harness working directory (absolute container path for docker)"),
        model_id: z.string().min(1).describe("Model id to select"),
        thinking_level: z.string().min(1).optional().describe("Reasoning level for the selected harness and model; must match its supported ACP option"),
        harness: z.string().optional().describe("codebuddy | codex | agy; defaults to default_harness"),
        permission_mode: z
          .enum(["read", "edit", "auto", "yolo"])
          .optional()
          .describe("yolo maps to bypassPermissions (codebuddy), agent-full-access (codex), or yolo (agy); routed via argv or ACP"),
        target: z.enum(["local", "remote"]).optional().describe("local (default) or remote over SSH"),
        remote_host: z.string().optional().describe("SSH host; requires target=remote"),
        runtime: z.enum(["direct", "docker"]).optional().describe("direct (default) or docker"),
        docker_id: z
          .string()
          .optional()
          .describe("Full 64-hex id of an existing container to reuse; cannot be combined with new-container options"),
        docker_image: z.string().optional().describe("Image for a new container (required with runtime=docker)"),
        container_policy: z.enum(["remove", "keep"]).optional().describe("Cleanup policy (default keep for reuse)"),
        mounts: z
          .array(
            z.object({
              source: z.string().describe("Absolute host path"),
              target: z.string().describe("Absolute container path"),
              read_only: z.boolean().optional(),
            }),
          )
          .optional(),
        ports: z
          .array(
            z.object({
              host_port: z.number().int(),
              container_port: z.number().int(),
              protocol: z.enum(["tcp", "udp"]).optional(),
              host_ip: z.string().optional(),
            }),
          )
          .optional(),
        host_network: z.boolean().optional().describe("Cannot be combined with published ports"),
        resume_session_id: z.string().optional().describe("Existing harness session id to load"),
        authenticate: z
          .string()
          .optional()
          .describe(
            "Auth method id to apply during creation; obeys the same rate limit, same-target serialization, and timeout as `authenticate`",
          ),
        session_id: z.string().optional().describe("Explicit bridge session id (advanced)"),
      },
    },
    async (args) => {
      // A create that also authenticates waits for the daemon's authentication timeout, so
      // the caller's IPC budget must cover it (the daemon still enforces the real limit).
      const budgetSeconds =
        createSessionTimeoutSeconds(config.transport.startupTimeoutSeconds) +
        30 +
        (args.authenticate ? config.authentication.timeoutSeconds : 0);
      return guard(() =>
        daemon.call("create_session", { ...args }, { timeoutMs: budgetSeconds * 1000 }),
      );
    },
  );

  server.registerTool(
    "authenticate",
    {
      title: "Authenticate",
      description: "Complete authentication for a session that reported authentication_required.",
      inputSchema: {
        session_id: sessionId,
        method_id: z.string().min(1).describe("One of the harness auth method ids"),
      },
    },
    async (args) =>
      guard(() =>
        daemon.call("authenticate", { ...args }, {
          timeoutMs: config.authentication.timeoutSeconds * 1000 + AUTH_IPC_GRACE_MS,
        }),
      ),
  );

  server.registerTool(
    "auth_info",
    {
      title: "Auth info",
      description: "Report login state and available auth methods. Account details are whitelisted; never credentials.",
      inputSchema: { session_id: sessionId },
    },
    async (args) => guard(() => daemon.call("auth_info", { session_id: args.session_id })),
  );

  server.registerTool(
    "set_model",
    {
      title: "Set model",
      description:
        "Change the model for a ready session between turns, optionally applying a thinking " +
        "level to the new model. Omit thinking_level to change only the model. A level the " +
        "configured model does not declare (or the new model's ACP options do not advertise) " +
        "is rejected. Rejected with `busy` while a message is non-terminal (including while " +
        "waiting for an answer).",
      inputSchema: {
        session_id: sessionId,
        model_id: z.string().min(1),
        thinking_level: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Reasoning level for the new model; routed through the adapter after the switch. Omit to change only the model and leave the reasoning level untouched (it is not re-applied to the new model)",
          ),
      },
    },
    async (args) => guard(() => daemon.call("set_model", { ...args })),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Submit a prompt and return ONLY its message_id, immediately. A session runs one " +
        "message at a time: while a message is queued/running/waiting_input the call fails " +
        "with `busy` (nothing is queued or interrupted). `mode` (\"steering\" default or " +
        '"queue"; "steer" is an alias for "steering") is recorded on the message and used for ' +
        "the idempotency fingerprint. Pass idempotency_key to make retries safe: within one " +
        "session the same key with the same text/mode returns the original message_id even " +
        "while it is still running; the same key with different text/mode fails with " +
        "idempotency_conflict. Poll message_result / live_output for progress and output.",
      inputSchema: {
        session_id: sessionId,
        text: z.string().min(1).describe("Prompt text"),
        mode: z
          .string()
          .optional()
          .describe('"steering" (default) or "queue"; "steer" is an alias for "steering"'),
        idempotency_key: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional dedupe key: a repeat with the same text/mode returns the original message_id; a different text/mode is a conflict",
          ),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await daemon.call("send_message", { ...args });
        const messageId = typeof result.message_id === "string" ? result.message_id : "";
        if (messageId) watchUntilTerminal(args.session_id, messageId);
        return result;
      }),
  );

  server.registerTool(
    "message_result",
    {
      title: "Message result",
      description:
        "Message status and result in one call. With message_id: the full status (state, " +
        "terminal, pending interaction, queue position, error); text/tool_calls/" +
        "harness_session_id are included only once the message is terminal, so a non-terminal " +
        "poll is never mistakable for a final answer (use live_output for the partial preview). " +
        "Without message_id: whole-session status. Readable after close and restart.",
      inputSchema: { session_id: sessionId, message_id: z.string().min(1).optional() },
    },
    async (args) =>
      guard(() =>
        daemon.call("message_result", {
          session_id: args.session_id,
          ...(args.message_id ? { message_id: args.message_id } : {}),
        }),
      ),
  );

  server.registerTool(
    "answer_question",
    {
      title: "Answer question",
      description:
        "Answer a pending interaction request (permission or information). The request_id must " +
        "match the pending request. answer=accept (default) sends response: for permission " +
        "interactions (interaction.permission is true) option_id must be one of the offered " +
        "options; for information interactions response is the answer object. The non-accept " +
        "answers are routed to the harness per the interaction type: reject declines the " +
        "request (a permission selects an offered deny option when present), timeout reports " +
        "that no decision was made, and cancel withdraws it outright (a permission is sent the " +
        "cancelled outcome, never a deny option). A plain information request has no protocol " +
        "decline/cancel, so reject/timeout/cancel cancels the turn.",
      inputSchema: {
        session_id: sessionId,
        message_id: z.string().min(1),
        request_id: z.string().min(1),
        answer: z
          .enum(["accept", "reject", "timeout", "cancel"])
          .optional()
          .describe(
            "accept (default, requires response) | reject (decline) | timeout (no decision) | cancel (withdraw)",
          ),
        response: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Required for answer=accept: permissions take {option_id}; else the information object. Unused for reject/timeout/cancel",
          ),
      },
    },
    async (args) => guard(() => daemon.call("answer_question", { ...args })),
  );

  server.registerTool(
    "cancel_message",
    {
      title: "Cancel message",
      description: "Cancel a queued or running message. Terminal messages are returned unchanged.",
      inputSchema: { session_id: sessionId, message_id: z.string().min(1) },
    },
    async (args) => guard(() => daemon.call("cancel_message", { ...args })),
  );

  server.registerTool(
    "live_output",
    {
      title: "Live output",
      description:
        "Read the rolling preview by absolute byte offset. Re-pass next_offset to continue. " +
        "`truncated` means the requested offset fell behind the retained window (see dropped_bytes). " +
        "`stopped` means no further output can arrive; send stop:true to stop explicitly. " +
        "Set wait_ms (max 30000) to long-poll: the call returns as soon as output arrives or the " +
        "message settles, instead of busy-polling.",
      inputSchema: {
        session_id: sessionId,
        message_id: z.string().optional().describe("Restrict to one message's output window"),
        offset: z.number().int().nonnegative().optional().describe("Absolute preview byte offset"),
        max_bytes: z.number().int().positive().optional().describe("Chunk size cap (default 64KiB, max 1MiB)"),
        stop: z.boolean().optional().describe("Explicitly stop listening"),
        wait_ms: z
          .number()
          .int()
          .nonnegative()
          .max(30000)
          .optional()
          .describe("Long-poll up to this many ms for new output or termination (default 0)"),
      },
    },
    async (args) => guard(() => daemon.call("live_output", { ...args })),
  );

  server.registerTool(
    "close_session",
    {
      title: "Close session",
      description: "Close a session: cancel running/queued messages, stop the harness, and flush persistence.",
      inputSchema: { session_id: sessionId },
    },
    async (args) => guard(() => daemon.call("close_session", { ...args })),
  );

  server.registerTool(
    "harness_info",
    {
      title: "Harness info",
      description:
        "Describe the configured harnesses (or one named harness) from the configuration file " +
        "only: the permission modes each harness can actually route with the current config, and " +
        "each configured model's id, name, and declared thinking_levels. It never starts a " +
        "harness or a daemon. A model's thinking_levels is null when the configuration does not " +
        "declare them (unknown, never assumed supported).",
      inputSchema: {
        harness: z
          .string()
          .optional()
          .describe("Limit to one configured harness (codebuddy | codex | agy); omit to list all"),
      },
    },
    async (args) =>
      guard(async () => {
        const harness = args.harness ?? null;
        return {
          status: "ok",
          source: "config_file",
          config_path: configPath,
          harnesses: harnessInfo(config, harness),
        };
      }),
  );

  return server;
}

async function main(): Promise<void> {
  const explicit = configArgument(process.argv.slice(2));
  const config = loadConfig(explicit);
  const configPath = resolveConfigPath(explicit);
  const daemon = new DaemonClient({
    socketPath: config.server.socketPath,
    lockPath: config.server.lockPath,
    configPath,
    startTimeoutMs: config.server.startTimeoutSeconds * 1000,
  });
  const server = createBridgeServer(daemon, config, configPath);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`harness-acp-bridge failed to start: ${message}\n`);
  process.exit(1);
});
