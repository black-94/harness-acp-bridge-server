/**
 * Per-session asynchronous message queue and lifecycle.
 *
 * A `BridgeSession` owns one harness ACP transport plus one persistence directory. At most
 * **one message may be non-terminal** (`queued`/`running`/`waiting_input`) at a time:
 *
 *   sendMessage(text, {idempotencyKey}) -> when the session is idle, create the message and
 *                                         return only { message_id }; when any message is
 *                                         still non-terminal, throw `busy` (no steering, no
 *                                         queueing, no cancellation, and no persisted record)
 *   answerQuestion(msg, req, resp, {answer}) -> validate the pending request and route the
 *                                         answer (accept/reject/timeout/cancel) to the
 *                                         harness, cancelling the turn when the protocol has
 *                                         no decline/cancel
 *   cancelMessage(msg)                 -> cancel a running or waiting message
 *   messageResult(msg)                 -> full status; result fields only once terminal
 *   readOutput() / listenOutput()      -> rolling preview reads by byte offset, optionally
 *                                         long-polling until output arrives
 *
 * The queue never blocks the caller: `sendMessage` returns immediately and the upstream polls
 * `message_result` / `live_output`.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  AcpRpcError,
  acpErrorCode,
  type AcpInteraction,
  type AcpLogger,
  type AcpModel,
  type AcpTurnEvent,
  type AcpTurnResult,
  type InteractionAnswer,
} from "./acp.js";
import {
  AuthStatusUnsupported,
  getAdapter,
  type AdapterClient,
  type AdapterConfig,
  type AuthInfo as AdapterAuthInfo,
  type ContainerPolicy,
  type HarnessAdapter,
  type PermissionMode,
  type Runtime,
} from "./adapters.js";
import { authTargetKey } from "./auth.js";
import {
  type BridgeConfig,
  type HarnessConfig,
  resolveHarness,
} from "./config.js";
import {
  MAX_PREVIEW_WAIT_MS,
  RESULTS_DIR,
  SessionRecorder,
  awaitPreviewActivity,
  idempotencyKeyHash,
  idempotencyRequestHash,
  redactSensitive,
  newSessionId,
  type IdempotencyRecord,
} from "./persistence.js";
import {
  SUPERVISOR_SPEC_ENV,
  inspectContainer,
  isDockerId,
  newRemotePidFile,
  type ContainerInspection,
  type DockerMountSpec,
  type DockerPortSpec,
  type LaunchSpec,
  type SupervisorSpec,
} from "./runtime.js";

export type { ContainerPolicy, PermissionMode, Runtime, InteractionAnswer };

export type MessageMode = "steering" | "queue";
export type MessageState = "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";
/**
 * Session lifecycle state. `interrupted` is only produced by the read-only recovery path
 * when a daemon restart finds messages that were in flight (see `recovery.ts`).
 */
export type SessionState =
  | "starting"
  | "authentication_required"
  | "ready"
  | "closed"
  | "failed"
  | "interrupted";

/**
 * Derived interaction state of the session's single operation slot (what the bridge is doing
 * with the harness), independent of the individual message terminal states:
 *
 * - `idle` — no in-flight work; a new message or model switch may start immediately.
 * - `accepting` — a message was accepted but the queue pump has not picked it up yet.
 * - `running` — a message's turn is in flight on the harness.
 * - `waiting_input` — the harness asked a reverse question and no answer has arrived.
 * - `switching_model` — a `set_model` is in flight.
 * - `cancelling` — every message is already terminal but the previous ACP `session/prompt`
 *   has not settled yet (a cancel is being confirmed with the harness). New
 *   `send_message`/`set_model` calls are still rejected with `busy` in this window.
 */
export type SessionOperation =
  | "idle"
  | "accepting"
  | "running"
  | "waiting_input"
  | "switching_model"
  | "cancelling";

export const TERMINAL_MESSAGE_STATES: ReadonlySet<MessageState> = new Set<MessageState>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalMessageState(state: MessageState): boolean {
  return TERMINAL_MESSAGE_STATES.has(state);
}

/**
 * Normalize the public `mode` argument.
 *
 * The public interface accepts exactly `"steering"` and `"queue"`; `"steer"` is accepted only
 * as a compatibility alias for `"steering"`. A session runs one message at a time, so `mode`
 * no longer changes scheduling — a submission that would create a second message is rejected
 * with `busy` regardless of `mode`. It is kept as part of the message identity (reported by
 * `message_result` and folded into the idempotency-request fingerprint).
 */
export function normalizeMessageMode(value: unknown): MessageMode {
  if (value === undefined || value === null) return "steering";
  if (value === "steering" || value === "steer") return "steering";
  if (value === "queue") return "queue";
  throw new SessionError(
    "invalid_mode",
    `mode must be "steering" or "queue" (received ${JSON.stringify(value)})`,
  );
}

/**
 * Validate the optional caller-supplied idempotency key.
 *
 * `undefined`/`null` means no key and keeps the original behaviour. A present key must be a
 * non-empty, bounded string; it is trimmed so trivial surrounding whitespace does not create
 * a second identity. The key is otherwise opaque.
 */
export function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new SessionError("invalid_idempotency_key", "idempotency_key must be a string");
  }
  const key = value.trim();
  if (!key) {
    throw new SessionError("invalid_idempotency_key", "idempotency_key must not be empty");
  }
  if (Buffer.byteLength(key, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new SessionError(
      "invalid_idempotency_key",
      `idempotency_key exceeds ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`,
    );
  }
  return key;
}

/**
 * Resolve a repeated idempotency key against the request it was first used with.
 *
 * Returns the original `{ message_id }` for an identical request, `null` when the key is
 * unknown, and throws `idempotency_conflict` when the key was already used with different
 * text or mode — so one key can never silently alias two different prompts.
 */
export function resolveIdempotentReplay(
  existing: IdempotencyRecord | null | undefined,
  requestHash: string,
): { message_id: string } | null {
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    throw new SessionError(
      "idempotency_conflict",
      "idempotency_key was already used in this session with different text or mode " +
        `(message ${existing.message_id})`,
    );
  }
  return { message_id: existing.message_id };
}

export class SessionError extends Error {
  override name = "SessionError";
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export interface AcpInteractionDict {
  request_id: string;
  permission: boolean;
  title: string;
  message: string;
  options: Array<Record<string, unknown>>;
  schema: Record<string, unknown> | null;
  defaults: Record<string, unknown> | null;
  raw_input: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface MessageErrorInfo {
  code: string;
  message: string;
  detail?: unknown;
}

export interface MessageStatus {
  message_id: string;
  state: MessageState;
  terminal: boolean;
  mode: MessageMode;
  seq: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_position: number | null;
  cancellable: boolean;
  interaction: AcpInteractionDict | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  stop_reason: string | null;
  error: MessageErrorInfo | null;
  preview_bytes: number;
  /** Absolute preview offset where this message's output begins (null until it runs). */
  output_start_offset: number | null;
  /** Absolute preview offset where this message's output ends (null until terminal). */
  output_end_offset: number | null;
  result_available: boolean;
  /** Set by the recovery path when a daemon restart orphaned this message. */
  orphaned?: boolean;
  persisted?: boolean;
}

/**
 * `message_result` for one message.
 *
 * Always carries the full `MessageStatus` fields. The result fields (`text`, `tool_calls`,
 * `harness_session_id`) are present **only once the message is terminal**; a non-terminal
 * message reports status alone, so a caller can never mistake a partial in-flight preview for
 * a final result.
 */
export interface MessageResult extends MessageStatus {
  text?: string | null;
  tool_calls?: Array<Record<string, unknown>>;
  harness_session_id?: string | null;
}

export interface LiveOutputOptions {
  messageId?: string | null;
  /** Absolute preview byte offset to read from; defaults to the message's start. */
  offset?: number | null;
  maxBytes?: number;
  /** Explicitly stop listening; returns no chunk and `stopped: true`. */
  stop?: boolean;
  /** Long-poll: wait up to this many ms for output/termination before returning. */
  waitMs?: number;
  /** Aborts a long-poll when the caller disconnects. */
  signal?: AbortSignal;
}

export interface LiveOutput {
  session_id: string;
  message_id: string | null;
  chunk: string;
  offset: number;
  next_offset: number;
  max_bytes: number;
  /** True when the requested offset fell behind the rolling window. */
  truncated: boolean;
  dropped_bytes: number;
  /** True once no further output can arrive for this stream/message. */
  stopped: boolean;
  state: MessageState | SessionState;
  terminal: boolean;
  window_start: number;
  window_end: number;
  message_end_offset: number | null;
  /** Milliseconds spent long-polling (0 for an immediate read). */
  waited_ms: number;
}

export interface AuthInfo {
  authenticated: boolean;
  auth_methods: Array<Record<string, unknown>>;
  state: SessionState;
  model_id: string;
  model_name: string | null;
  harness_session_id: string | null;
  user: Record<string, unknown> | null;
}

export interface SessionStatus {
  session_id: string;
  directory: string;
  harness: string;
  state: SessionState;
  /** Derived operation-slot state (see `SessionOperation`); messages keep their own states. */
  operation: SessionOperation;
  authenticated: boolean;
  model_id: string;
  model_name: string | null;
  harness_session_id: string | null;
  cwd: string;
  permission_mode: PermissionMode;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  running_message_id: string | null;
  queued_message_ids: string[];
  messages_total: number;
  preview_bytes: number;
  harness_models: AcpModel[];
}

/**
 * The subset of `AcpClient` the session depends on. Declared separately so tests can
 * inject a mock ACP transport without spawning a real harness.
 */
export interface AcpTransport {
  readonly running: boolean;
  readonly sessionId: string | null;
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly turnActive: boolean;
  readonly previewText: string;
  start(): Promise<unknown>;
  authenticate(methodId: string): Promise<unknown>;
  authMethods(): Array<Record<string, unknown>>;
  openSession(resumeSessionId?: string | null): Promise<string>;
  setModel(modelId: string): Promise<void>;
  beginTurn(prompt: string): Promise<void>;
  waitForTurnEvent(timeoutMs: number): Promise<AcpTurnEvent>;
  respondInteraction(requestId: string, response: unknown, answer?: InteractionAnswer): Promise<boolean>;
  cancelTurn(): Promise<void>;
  close(): Promise<void>;
  listModels(): AcpModel[];
  toolCallSummaries?(): Array<Record<string, unknown>>;
  on?(event: "sessionUpdate" | "stderr" | "exit" | "closed", listener: (...args: any[]) => void): unknown;
  /** Raw initialize response; used by adapters that probe authentication. */
  initializeResponseMessage?(): Record<string, unknown>;
  /** Raw JSON-RPC request; used by adapters for session options. */
  request?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Model-specific ACP options advertised by the harness; null when not advertised. */
  configOptions?(): Array<Record<string, unknown>> | null;
  readonly processId?: number | null;
  readonly processGroupId?: number | null;
  /** Per-session supervisor metadata (pids, container id); absent for injected transports. */
  supervisorInfo?(): Record<string, unknown>;
}

export interface BridgeSessionOptions {
  config: BridgeConfig;
  /** Harness name or resolved harness entry. Defaults to `config.defaultHarness`. */
  harness?: string | HarnessConfig;
  cwd: string;
  modelId: string;
  thinkingLevel?: string | null;
  permissionMode?: PermissionMode;
  /** `local` (default) or `remote` (SSH). */
  target?: "local" | "remote";
  remoteHost?: string | null;
  /** `direct` (default) or `docker`. */
  runtime?: "direct" | "docker";
  /** Full 64-hex id of an existing container to reuse (skips creation). */
  dockerId?: string | null;
  dockerImage?: string | null;
  dockerMounts?: DockerMountSpec[];
  dockerPorts?: DockerPortSpec[];
  dockerHostNetwork?: boolean;
  containerPolicy?: "remove" | "keep";
  /** Real configuration of a reused container, read back for `launch_info`. */
  containerInspection?: ContainerInspection | null;
  resumeSessionId?: string | null;
  /** Explicit session id; defaults to `<date>-<random>`. */
  sessionId?: string;
  /** Session root override (tests); defaults to `config.paths.sessionDir`. */
  baseDir?: string;
  /**
   * Auth method id requested at creation.
   *
   * Recorded in metadata only; the daemon applies it through its `AuthCoordinator` (same
   * ledger, serialization, concurrency bound, and timeout as the `authenticate` tool).
   */
  authenticate?: string;
  /** Injectable transport (tests). */
  transport?: AcpTransport;
  logger?: AcpLogger;
  /** Clock injection for deterministic snapshots. */
  now?: () => Date;
}

interface SessionMessageRecord {
  message_id: string;
  text: string;
  mode: MessageMode;
  state: MessageState;
  seq: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  stop_reason: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  error: MessageErrorInfo | null;
  interaction: AcpInteractionDict | null;
  preview_start: number | null;
  preview_end: number | null;
  text_result: string | null;
  tool_calls: Array<Record<string, unknown>>;
  harness_session_id: string | null;
}

type InteractionOutcome = "answered" | "cancelled" | "timeout";

/** Validate an interaction answer kind; `undefined` defaults to `"accept"`. */
function normalizeInteractionAnswer(value: unknown): InteractionAnswer {
  if (value === undefined || value === null) return "accept";
  if (value === "accept" || value === "reject" || value === "timeout" || value === "cancel") return value;
  throw new SessionError("invalid_answer", "answer must be one of accept, reject, timeout, cancel");
}

/**
 * `cancel_reason` recorded when an interaction answer ends the turn because the protocol has
 * no decline/cancel response (a plain information request). Kept in sync with `cancelMessage`.
 */
function interactionCancelReason(answer: InteractionAnswer): string {
  if (answer === "cancel") return "user_cancel";
  if (answer === "timeout") return "interaction_timeout";
  return "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `record[key]` when it is a string, else `fallback`. */
function strField(record: Record<string, unknown>, key: string, fallback: string | null = null): string | null {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

/** `record[key]` when it is a number, else null. */
function numField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

const CLOSE_PUMP_GRACE_MS = 2000;
/** How long to wait for a supervisor's metadata file after the ACP handshake. */
const SUPERVISOR_METADATA_WAIT_MS = 2000;
/** Hard bound on a single prompt, so one IPC call cannot exhaust memory. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Hard bound on a caller-supplied idempotency key. */
const MAX_IDEMPOTENCY_KEY_BYTES = 512;
const DEFAULT_LIVE_OUTPUT_BYTES = 64 * 1024;
const MAX_LIVE_OUTPUT_BYTES = 1024 * 1024;

/** Resolve after `promise` settles or the timeout elapses, whichever comes first. */
function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(finish, finish);
  });
}

function newMessageId(): string {
  return `msg-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** A harness may signal "login required" through the RPC error of session creation. */
function isAuthRpcError(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) return false;
  if (error.code === -32000 || error.code === -32001) return true;
  return error.message.toLowerCase().includes("auth");
}

function interactionDict(interaction: AcpInteraction): AcpInteractionDict {
  return {
    request_id: interaction.requestId,
    permission: interaction.permission,
    title: interaction.title,
    message: interaction.message,
    options: interaction.options,
    schema: interaction.schema,
    defaults: interaction.defaults,
    raw_input: interaction.rawInput,
    meta: interaction.meta,
  };
}

/**
 * Build a harness argv through its adapter.
 *
 * CodeBuddy takes managed ACP flags on the command line; Codex/Agy are driven purely over
 * ACP (mode via their ACP methods, model via `session/set_model`). Retained as a thin
 * helper so callers do not need to know about adapters.
 */
export function buildHarnessArgv(
  harness: HarnessConfig,
  options: {
    modelId: string;
    permissionMode: PermissionMode;
    cwd?: string;
    launchMode?: "local" | "ssh";
    runtime?: Runtime;
    sshHost?: string | null;
    dockerImage?: string | null;
    reuseContainer?: boolean;
    acpModeId?: string | null;
  },
): { command: string; args: string[] } {
  const adapter = getAdapter(harness.name);
  const config = adapterConfigFor(harness, {
    cwd: options.cwd ?? ".",
    modelId: options.modelId,
    permissionMode: options.permissionMode,
    launchMode: options.launchMode ?? "local",
    runtime: options.runtime ?? "direct",
    sshHost: options.sshHost ?? null,
    dockerImage: options.dockerImage ?? null,
    reuseContainer: options.reuseContainer ?? false,
    acpModeId: options.acpModeId ?? null,
  });
  const argv = adapter.buildArgv(config);
  return { command: argv[0] as string, args: argv.slice(1) };
}

/** Build the adapter-facing config from a harness entry and launch options. */
function adapterConfigFor(
  harness: HarnessConfig,
  options: {
    cwd: string;
    modelId: string;
    permissionMode: PermissionMode;
    launchMode: "local" | "ssh";
    runtime: Runtime;
    sshHost: string | null;
    dockerImage: string | null;
    reuseContainer: boolean;
    acpModeId: string | null;
  },
): AdapterConfig {
  return {
    harness: harness.name,
    cwd: options.cwd,
    modelId: options.modelId,
    command: harness.command,
    args: harness.args,
    env: harness.env,
    launchMode: options.launchMode,
    runtime: options.runtime,
    permissionMode: options.permissionMode,
    acpModeId: options.acpModeId,
    sshHost: options.sshHost,
    dockerImage: options.dockerImage,
    reuseContainer: options.reuseContainer,
  };
}

function harnessOf(config: BridgeConfig, harness: string | HarnessConfig | undefined): HarnessConfig {
  if (harness === undefined) return resolveHarness(config);
  return typeof harness === "string" ? resolveHarness(config, harness) : harness;
}

export class BridgeSession {
  readonly sessionId: string;
  readonly directory: string;
  readonly config: BridgeConfig;
  readonly harness: HarnessConfig;
  readonly cwd: string;
  readonly createdAt: string;

  state: SessionState = "starting";
  authenticated = false;
  modelId: string;
  modelName: string | null = null;
  harnessSessionId: string | null = null;
  closedAt: string | null = null;

  private readonly recorder: SessionRecorder;
  private readonly transport: AcpTransport;
  private readonly adapter: HarnessAdapter;
  private readonly adapterConfig: AdapterConfig;
  private readonly spec: LaunchSpec;
  private readonly target: "local" | "remote";
  private readonly runtime: Runtime;
  private readonly containerPolicy: ContainerPolicy;
  private readonly permissionMode: PermissionMode;
  private readonly thinkingLevel: string | null;
  private readonly resumeSessionId: string | null;
  private readonly authenticateMethod: string | null;
  private readonly clock: () => Date;
  private startedAt: string | null = null;
  /** Private file the per-session supervisor writes its pids/container id to. */
  private readonly metadataPath: string | null;
  private containerInspection: ContainerInspection | null = null;
  private authUser: Record<string, unknown> | null = null;

  private readonly messages = new Map<string, SessionMessageRecord>();
  /**
   * Idempotency index: opaque key token -> the message the key was first used with.
   *
   * Loaded from the session directory so it is consistent with what is on disk, and kept in
   * memory for the synchronous replay check. It is per-session, so the same key in another
   * session can never collide.
   */
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly queue: string[] = [];
  private current: string | null = null;
  private seq = 0;
  private pumpPromise: Promise<void> | null = null;
  private closed = false;
  private recorderClosed = false;
  private switchingModel = false;
  private interactionResolve: ((outcome: InteractionOutcome) => void) | null = null;

  private constructor(
    options: BridgeSessionOptions,
    harness: HarnessConfig,
    recorder: SessionRecorder,
    transport: AcpTransport,
    spec: LaunchSpec,
    adapter: HarnessAdapter,
    adapterConfig: AdapterConfig,
    metadataPath: string | null,
  ) {
    this.config = options.config;
    this.harness = harness;
    this.cwd = options.cwd;
    this.modelId = options.modelId;
    this.permissionMode = options.permissionMode ?? "auto";
    this.thinkingLevel = options.thinkingLevel ?? null;
    this.resumeSessionId = options.resumeSessionId ?? null;
    this.authenticateMethod = options.authenticate ?? null;
    this.clock = options.now ?? (() => new Date());
    this.recorder = recorder;
    this.transport = transport;
    this.spec = spec;
    this.adapter = adapter;
    this.adapterConfig = adapterConfig;
    this.metadataPath = metadataPath;
    this.target = spec.launchMode === "ssh" ? "remote" : "local";
    this.runtime = options.runtime ?? "direct";
    this.containerPolicy = options.containerPolicy ?? (options.dockerId ? "keep" : "remove");
    this.sessionId = recorder.sessionId;
    this.directory = recorder.directory;
    this.createdAt = recorder.createdAt;
    // A fresh session directory has no index; loading is defensive so the in-memory view can
    // never disagree with an index already on disk (e.g. a recovered directory).
    for (const [token, record] of Object.entries(recorder.readIdempotency())) {
      this.idempotency.set(token, record);
    }
  }

  /**
   * Create a session directory, start the per-session supervisor, and open an ACP session.
   *
   * Container preparation and cleanup belong to the supervisor process, so a daemon crash
   * cannot orphan the harness or its container/remote resources.
   */
  static async create(options: BridgeSessionOptions): Promise<BridgeSession> {
    if (!options.cwd || !options.cwd.trim()) throw new SessionError("invalid_cwd", "cwd must not be empty");
    if (!options.modelId || !options.modelId.trim()) {
      throw new SessionError("invalid_model", "model_id must not be empty");
    }
    const harness = harnessOf(options.config, options.harness);
    const permissionMode = options.permissionMode ?? "auto";
    const target = options.target ?? "local";
    const runtime = options.runtime ?? "direct";
    const dockerId = options.dockerId ?? null;
    const dockerImage = dockerId ? null : (options.dockerImage ?? null);
    const reuseContainer = Boolean(dockerId);
    const adapterConfig = adapterConfigFor(harness, {
      cwd: options.cwd,
      modelId: options.modelId.trim(),
      permissionMode,
      launchMode: target === "remote" ? "ssh" : "local",
      runtime,
      sshHost: target === "remote" ? (options.remoteHost ?? null) : null,
      dockerImage,
      reuseContainer,
      acpModeId: options.config.launch.agyModeIds[permissionMode] ?? null,
    });
    const adapter = getAdapter(harness.name);
    // The adapter owns argv construction and all launch-argument validation.
    adapter.validate(adapterConfig);

    const spec: LaunchSpec = {
      launchMode: target === "remote" ? "ssh" : "local",
      sshHost: adapterConfig.sshHost,
      sshCommand: options.config.launch.sshCommand,
      dockerCommand: options.config.launch.dockerCommand,
      cwd: options.cwd,
      argv: adapter.buildArgv(adapterConfig),
      harnessEnv: harness.env,
      dockerImage,
      dockerContainerName:
        runtime === "docker" ? (dockerId ?? `harness-acp-${randomUUID().replace(/-/g, "")}`) : null,
      dockerId,
      dockerMounts: options.dockerMounts ?? [],
      dockerPorts: options.dockerPorts ?? [],
      dockerHostNetwork: options.dockerHostNetwork ?? false,
      containerPolicy: options.containerPolicy ?? (dockerId ? "keep" : "remove"),
      reuseContainer,
      remotePidFile: target === "remote" ? newRemotePidFile() : null,
      startupTimeoutSeconds: options.config.transport.startupTimeoutSeconds,
      terminateGraceSeconds: options.config.transport.terminateGraceSeconds,
      remoteCleanupTimeoutSeconds: options.config.transport.remoteCleanupTimeoutSeconds,
    };

    const sessionId = options.sessionId ?? newSessionId();
    const baseDir = options.baseDir ?? options.config.paths.sessionDir;
    const recorder = new SessionRecorder({
      rootDir: baseDir,
      sessionId,
      previewBytes: options.config.buffers.previewBytes,
    });
    // Each real session gets a private metadata file (mode 0600) that its supervisor writes
    // pids/container id into. An injected test transport has no supervisor.
    const metadataPath =
      options.transport === undefined
        ? join(tmpdir(), `harness-acp-meta-${randomUUID().replace(/-/g, "")}.json`)
        : null;
    const transport =
      options.transport ??
      createAcpClient(spec, options.config, recorder, options.logger, metadataPath as string);
    const session = new BridgeSession(
      options,
      harness,
      recorder,
      transport,
      spec,
      adapter,
      adapterConfig,
      metadataPath,
    );
    await session.initialize();
    return session;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async initialize(): Promise<void> {
    this.recorder.writeMeta(this.buildMeta());
    this.log(
      `session created harness=${this.harness.name} target=${this.target} runtime=${this.runtime} ` +
        `model=${this.modelId} cwd=${this.cwd}`,
    );
    this.persistAll();
    this.transport.on?.("sessionUpdate", (update: unknown) => this.onSessionUpdate(update));
    // A transport that dies mid-turn (a fatal output error terminates it) must fail the
    // in-flight message promptly instead of leaving its turn dangling until the turn timeout.
    this.transport.on?.("exit", () => this.onTransportGone());
    this.transport.on?.("closed", () => this.onTransportGone());

    try {
      if (this.spec.dockerContainerName && this.spec.reuseContainer) {
        // Read the retained container's real configuration before trusting request defaults.
        // This is a read-only control command, so it does not need the supervisor.
        this.containerInspection = await inspectContainer(
          this.spec,
          this.config.transport.startupTimeoutSeconds * 1000,
        );
      }
      this.startedAt = this.nowIso();
      // The supervisor prepares the container and owns the harness process group; a daemon
      // crash cannot orphan either.
      await this.transport.start();
      await this.awaitSupervisorMetadata();
      await this.probeAuthentication();
      if (this.authenticated) {
        try {
          await this.openHarnessSession();
        } catch (error) {
          // A harness may only reveal that login is required when the session is opened.
          if (!isAuthRpcError(error)) throw error;
          this.authenticated = false;
          this.state = "authentication_required";
          this.log("authentication required (harness rejected session creation)");
        }
      } else {
        this.state = "authentication_required";
        this.log(`authentication required (methods=${this.transport.authMethods().length})`);
      }
    } catch (error) {
      // Closing the transport terminates the supervisor, which terminates the harness process
      // group and releases the container/remote per policy — including a half-created
      // container, which is force-removed, and a reused container, which is left untouched.
      await this.transport.close().catch(() => undefined);
      this.removeSupervisorMetadata();
      throw error;
    }
    this.persistAll();
    this.recorder.writeMeta(this.buildMeta());
  }

  /**
   * Wait briefly for the supervisor's metadata file.
   *
   * The supervisor writes it right after spawning the harness, so it normally exists by the
   * time `initialize` answers; this only guards a slow start and a transport without one.
   */
  private async awaitSupervisorMetadata(): Promise<void> {
    if (!this.transport.supervisorInfo) return;
    const deadline = Date.now() + SUPERVISOR_METADATA_WAIT_MS;
    while (Date.now() < deadline) {
      const info = this.transport.supervisorInfo();
      if (typeof info.transport_pid === "number" || typeof info.supervisor_pid === "number") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Probe login state; fall back to `authentication_required` when the harness is silent.
   *
   * The `create_session` `authenticate` parameter is deliberately **not** applied here: it
   * is routed through the daemon's `AuthCoordinator` after creation so it obeys the same
   * ledger, same-target serialization, concurrency bound, and timeout as `authenticate`.
   */
  private async probeAuthentication(): Promise<void> {
    const methods = this.transport.authMethods();
    if (methods.length === 0) {
      this.authenticated = true;
      return;
    }
    try {
      const info: AdapterAuthInfo = await this.adapter.getAuthInfo(
        this.adapterClient(),
        this.transport.initializeResponseMessage?.() ?? {},
      );
      this.authUser = info.user;
      this.authenticated = info.authenticated;
    } catch (error) {
      if (!(error instanceof AuthStatusUnsupported)) throw error;
      // No reliable status endpoint and no session yet: ask the caller to authenticate.
      this.authenticated = false;
    }
  }

  /**
   * Re-probe login state and remember the latest whitelisted account.
   *
   * Mirrors the reference `AcpClient.get_auth_info`: a harness that advertises no auth
   * methods is considered logged in, a status endpoint that reports a `user` refreshes the
   * displayed account, and a harness without a status endpoint returns `null`. A probe can
   * only ever confirm a login — it never revokes an already-ready session, so a transient
   * status hiccup cannot invalidate a working session.
   */
  async refreshAuthInfo(): Promise<AdapterAuthInfo | null> {
    const methods = this.transport.authMethods();
    if (methods.length === 0) {
      this.authenticated = true;
      return { authenticated: true, methods, user: this.authUser, raw: {} };
    }
    try {
      const info = await this.adapter.getAuthInfo(
        this.adapterClient(),
        this.transport.initializeResponseMessage?.() ?? {},
      );
      if (info.user) this.authUser = info.user;
      if (info.authenticated) this.authenticated = true;
      return info;
    } catch (error) {
      if (!(error instanceof AuthStatusUnsupported)) throw error;
      if (this.harnessSessionId) {
        this.authenticated = true;
        return { authenticated: true, methods, user: this.authUser, raw: {} };
      }
      return null;
    }
  }

  /** True when the session is logged in. */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Opaque ledger key for this session's harness+target (`harness`, launch mode, ssh host).
   *
   * Hashed rather than stored raw so the persistent auth ledger never names a host.
   */
  authTargetKey(): string {
    return authTargetKey(this.harness.name, this.spec.launchMode, this.spec.sshHost);
  }

  /** Open (or confirm) the harness session without touching credentials. */
  async ensureReady(): Promise<SessionStatus> {
    this.requireOpen();
    if (this.state !== "ready" || !this.harnessSessionId) {
      await this.openHarnessSession();
      this.persistAll();
      this.recorder.writeMeta(this.buildMeta());
    }
    return this.status();
  }

  private adapterClient(): AdapterClient {
    const transport = this.transport;
    return {
      sessionId: () => transport.sessionId,
      initializeResponse: () => transport.initializeResponseMessage?.() ?? {},
      request: (method: string, params: Record<string, unknown>) => {
        const request = transport.request;
        if (!request) {
          throw new SessionError("unsupported", "transport does not support ACP requests");
        }
        return request.call(transport, method, params);
      },
    };
  }

  private async openHarnessSession(): Promise<void> {
    this.harnessSessionId = await this.transport.openSession(this.resumeSessionId);
    // Permission-mode routing: CodeBuddy used argv flags; Codex/Agy need an ACP round trip.
    await this.adapter.setMode(this.adapterClient(), this.adapterConfig, this.harnessSessionId);
    if (this.harness.name === "codebuddy") {
      // CodeBuddy was launched with --model, so the harness-reported model wins.
      this.modelId = this.transport.modelId ?? this.modelId;
    } else {
      await this.transport.setModel(this.modelId);
    }
    this.modelName = this.transport.modelName ?? this.modelId;
    if (this.thinkingLevel) {
      this.assertDeclaredThinkingLevel(this.modelId, this.thinkingLevel);
      await this.adapter.setThinkingLevel(
        this.adapterClient(),
        this.harnessSessionId,
        this.modelId,
        this.thinkingLevel,
        this.transport.configOptions?.() ?? null,
      );
    }
    this.state = "ready";
    this.log(`session ready harness_session_id=${this.harnessSessionId} model=${this.modelId}`);
  }

  /** Complete authentication for a session left in `authentication_required`. */
  async authenticate(methodId: string): Promise<SessionStatus> {
    this.requireOpen();
    try {
      const info = await this.adapter.authenticate(this.adapterClient(), methodId);
      this.authenticated = info.authenticated;
      this.authUser = info.user;
    } catch (error) {
      // A harness without a status endpoint cannot confirm; a successful `authenticate`
      // round trip is itself the proof.
      if (!(error instanceof AuthStatusUnsupported)) throw error;
      this.authenticated = true;
    }
    await this.openHarnessSession();
    this.persistAll();
    this.recorder.writeMeta(this.buildMeta());
    return this.status();
  }

  /**
   * Change the model between turns, optionally applying a new thinking level.
   *
   * The level is validated against the configuration declaration **before** the switch, so an
   * undeclared level leaves the model unchanged. When it is accepted the model is switched
   * first and the level is then routed through the adapter against the *new* model's live ACP
   * config options (the transport drops the previous model's options on `session/set_model`),
   * so an advertised option is always checked against the model actually in effect. Omitting
   * `thinkingLevel` keeps the previous behaviour and changes only the model.
   */
  async setModel(modelId: string, thinkingLevel?: string | null): Promise<SessionStatus> {
    this.requireOpen();
    if (this.switchingModel) {
      throw new SessionError("busy", "a model switch is already in flight");
    }
    if (this.transport.turnActive || this.blockingMessage()) {
      throw new SessionError("busy", "cannot switch model while a message is in flight");
    }
    const level = thinkingLevel ?? null;
    if (level !== null && !this.harnessSessionId) {
      throw new SessionError("not_ready", "cannot set thinking_level before the harness session is open");
    }
    if (level !== null) this.assertDeclaredThinkingLevel(modelId, level);
    // `switching_model` marks the whole async switch so a concurrent `send_message`/`set_model`
    // cannot slip into the await gaps below.
    this.switchingModel = true;
    try {
      await this.transport.setModel(modelId);
      this.modelId = modelId;
      this.modelName = this.transport.modelName ?? modelId;
      // Commit the switch before applying the level: the harness model has already changed, so
      // status/persistence must reflect it even if the level is then rejected by the new model's
      // live options.
      this.persistAll();
      this.log(`model set to ${modelId}`);
      if (level !== null) {
        // `session/set_model` cleared the old model's options, so this validates against the new
        // model's advertised options (or the harness's own validation when none are advertised).
        await this.adapter.setThinkingLevel(
          this.adapterClient(),
          this.harnessSessionId as string,
          modelId,
          level,
          this.transport.configOptions?.() ?? null,
        );
        this.persistAll();
        this.log(`thinking_level set to ${level} for model ${modelId}`);
      }
    } finally {
      this.switchingModel = false;
    }
    return this.status();
  }

  /**
   * Reject a thinking level the configuration explicitly declares unsupported.
   *
   * A model whose `thinking_levels` is omitted in the configuration is *unknown*, not
   * "supported": it is left to the harness's live ACP config option validation. A declared
   * empty list means the model was configured to support none, so every level is rejected.
   */
  private assertDeclaredThinkingLevel(modelId: string, level: string): void {
    const declared = this.harness.models.find((model) => model.id === modelId)?.thinkingLevels ?? null;
    if (declared === null || declared.includes(level)) return;
    const detail = declared.length > 0 ? `declared: ${declared.join(", ")}` : "no levels are declared for this model";
    throw new SessionError(
      "invalid_thinking_level",
      `thinking_level ${JSON.stringify(level)} is not declared for ${this.harness.name} model ${modelId} (${detail})`,
    );
  }

  /**
   * Create a message and return only its id.
   *
   * A session runs at most one message at a time. If any message is still non-terminal
   * (`queued`, `running`, or `waiting_input`) this throws `busy` and creates nothing: no
   * steering, no queueing, no cancellation, and no persisted record.
   *
   * `idempotencyKey` is resolved **before** the busy check, so a retry of an already-accepted
   * submission returns the original `message_id` even while that message is still running; the
   * same key with different text/mode throws `idempotency_conflict`; a new key (or no key)
   * while busy throws `busy`.
   *
   * The new message and its key mapping are committed by a **single** atomic queue snapshot
   * before any harness side effect. If that write fails the submission is rolled back and the
   * error propagates, so the caller never sees a success that was not persisted.
   *
   * This method is fully synchronous up to `pump()`, so two concurrent IPC `send_message`
   * calls cannot interleave: Node runs the busy check, the insert, and the atomic commit as
   * one critical section and no additional lock is needed (the daemon is the single writer of
   * a session).
   */
  sendMessage(
    text: string,
    options: { mode?: MessageMode | "steer"; idempotencyKey?: string } = {},
  ): { message_id: string } {
    this.requireOpen();
    const prompt = typeof text === "string" ? text : "";
    if (!prompt.trim()) throw new SessionError("empty_message", "message text must not be empty");
    if (Buffer.byteLength(prompt, "utf8") > MAX_MESSAGE_BYTES) {
      throw new SessionError("message_too_large", `message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
    const mode = normalizeMessageMode(options.mode);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const token = idempotencyKey === null ? null : idempotencyKeyHash(idempotencyKey);
    // The fingerprint uses the normalized mode, so "steer" and "steering" compare equal.
    const requestHash = token === null ? null : idempotencyRequestHash(mode, prompt);
    if (token !== null && requestHash !== null) {
      const replay = resolveIdempotentReplay(this.idempotency.get(token), requestHash);
      if (replay) {
        this.log(`message ${replay.message_id} replayed for a repeated idempotency_key`);
        return replay;
      }
    }

    const blocking = this.blockingMessage();
    if (blocking) {
      throw new SessionError(
        "busy",
        `busy: session already has a non-terminal message (${blocking.message_id}, state ${blocking.state}); ` +
          "wait for it to finish, answer it, or cancel it before sending another",
      );
    }
    // Settlement window: every message may already be terminal, but the previous ACP
    // `session/prompt` has not been answered yet (a cancel is being confirmed) or a model
    // switch is in flight. Starting a new turn here would desync the stream, so the session
    // is still `busy` until the operation slot returns to `idle`.
    if (this.switchingModel || this.transport.turnActive) {
      throw new SessionError(
        "busy",
        "busy: the previous harness operation has not settled yet " +
          `(operation ${this.operationState()}); retry once it does`,
      );
    }

    const id = newMessageId();
    const message: SessionMessageRecord = {
      message_id: id,
      text: prompt,
      mode,
      state: "queued",
      seq: (this.seq += 1),
      created_at: this.nowIso(),
      started_at: null,
      finished_at: null,
      stop_reason: null,
      cancelled_by: null,
      cancel_reason: null,
      error: null,
      interaction: null,
      preview_start: null,
      preview_end: null,
      text_result: null,
      tool_calls: [],
      harness_session_id: null,
    };
    this.messages.set(id, message);
    // Stage the mapping in memory before the commit, so the single snapshot below carries
    // both the message and the key that names it.
    if (token !== null && requestHash !== null) {
      this.idempotency.set(token, {
        message_id: id,
        request_hash: requestHash,
        created_at: message.created_at,
      });
    }
    this.queue.push(id);

    try {
      this.persistAll();
    } catch (error) {
      // Nothing reached the harness: undo the uncommitted submission so a retry is a fresh
      // submit (note: an already-committed mapping, if any, is untouched because the key is
      // only added above for a brand-new request).
      this.messages.delete(id);
      const position = this.queue.indexOf(id);
      if (position >= 0) this.queue.splice(position, 1);
      if (token !== null) this.idempotency.delete(token);
      this.seq -= 1;
      this.log(`message ${id} submit failed before commit: ${String(error)}`);
      throw error;
    }

    this.log(`message ${id} accepted`);
    void this.pump();
    return { message_id: id };
  }

  /** The one message that is still non-terminal, or `null` when the session is idle. */
  private blockingMessage(): SessionMessageRecord | null {
    for (const message of this.messages.values()) {
      if (!isTerminalMessageState(message.state)) return message;
    }
    return null;
  }

  /**
   * Derived state of the single operation slot (see `SessionOperation`).
   *
   * `cancelling` is the settlement window in which every message is already terminal but the
   * ACP `session/prompt` request has not been answered yet; `accepting` covers a queued
   * message the pump has not picked up. Neither can be read off the message states alone.
   */
  private operationState(): SessionOperation {
    if (this.switchingModel) return "switching_model";
    const blocking = this.blockingMessage();
    if (blocking) {
      if (blocking.state === "waiting_input") return "waiting_input";
      if (blocking.state === "running") return "running";
      return "accepting";
    }
    if (this.transport.turnActive) return "cancelling";
    return "idle";
  }

  /**
   * Validate and answer the pending interaction request (permission or information).
   *
   * `options.answer` selects the routed outcome: `"accept"` (default) requires the concrete
   * `response`; `"reject"` declines the request, `"timeout"` reports that no decision was
   * made, and `"cancel"` withdraws it outright — all routed per interaction type (see
   * `AcpClient.respondInteraction`). A plain information request has no protocol-level
   * decline/cancel, so rejecting, timing out, or cancelling it cancels the message's turn
   * (with `cancel_reason` `"rejected"`, `"interaction_timeout"`, or `"user_cancel"`).
   */
  async answerQuestion(
    messageId: string,
    requestId: string,
    response: unknown,
    options: { answer?: InteractionAnswer } = {},
  ): Promise<{ message_id: string; request_id: string; accepted: boolean }> {
    const message = this.messages.get(messageId);
    if (!message) throw new SessionError("unknown_message", `unknown message: ${messageId}`);
    if (message.state !== "waiting_input" || !message.interaction) {
      throw new SessionError("no_pending_request", `message ${messageId} has no pending request`);
    }
    if (message.interaction.request_id !== requestId) {
      throw new SessionError(
        "request_id_mismatch",
        `request_id ${requestId} does not match pending request ${message.interaction.request_id}`,
      );
    }
    const answer = normalizeInteractionAnswer(options.answer);
    if (answer === "accept") {
      if (message.interaction.permission) {
        const candidate = isRecord(response) ? response.option_id : undefined;
        if (typeof candidate !== "string" || !candidate) {
          throw new SessionError("invalid_option", "permission response requires option_id");
        }
        const valid = new Set(
          message.interaction.options
            .map((option) => option.optionId)
            .filter((value): value is string => typeof value === "string"),
        );
        if (!valid.has(candidate)) {
          throw new SessionError("invalid_option", `unknown permission option_id: ${candidate}`);
        }
      } else if (!isRecord(response)) {
        throw new SessionError("invalid_response", "information response must be an object");
      }
    }

    // reject/timeout/cancel carry no payload; the ACP layer derives the outcome from the
    // interaction.
    const payload = answer === "accept" ? response : {};
    const responded = await this.transport.respondInteraction(requestId, payload, answer);
    if (!responded) {
      // No protocol decline/cancel exists (plain information request): end the turn.
      this.log(`message ${messageId} ${answer} request=${requestId} -> cancelling turn`);
      this.markCancelled(message, {
        reason: interactionCancelReason(answer),
        by: null,
        interrupt: true,
      });
      return { message_id: messageId, request_id: requestId, accepted: true };
    }
    this.interactionResolve?.("answered");
    this.log(`message ${messageId} answered request=${requestId} answer=${answer}`);
    return { message_id: messageId, request_id: requestId, accepted: true };
  }

  /** Cancel a running or waiting message. Terminal messages are returned unchanged. */
  cancelMessage(messageId: string): MessageStatus {
    const message = this.messages.get(messageId);
    if (!message) throw new SessionError("unknown_message", `unknown message: ${messageId}`);
    if (isTerminalMessageState(message.state)) return this.statusOf(message);
    if (message.state === "queued") {
      const index = this.queue.indexOf(messageId);
      if (index >= 0) this.queue.splice(index, 1);
      this.markCancelled(message, { reason: "user_cancel", by: null, interrupt: false });
    } else {
      this.markCancelled(message, { reason: "user_cancel", by: null, interrupt: true });
    }
    return this.statusOf(message);
  }

  /**
   * Result for a message.
   *
   * Always returns the full status; the result fields (`text`, `tool_calls`,
   * `harness_session_id`) are added only once the message is terminal, so a poller can tell a
   * partial in-flight view from a final result. `terminal` is `false` while it is still
   * running or waiting for an answer.
   */
  messageResult(messageId: string): MessageResult {
    const message = this.messages.get(messageId);
    if (message) return this.resultOf(message);
    const persisted = this.recorder.readResult(messageId);
    if (persisted) return persistedResult(persisted);
    throw new SessionError("unknown_message", `unknown message: ${messageId}`);
  }

  listModels(): AcpModel[] {
    const discovered = this.transport.listModels();
    // Only id/name cross the ACP-facing surface; the configured `thinking_levels` declaration
    // is reported by `harness_info`, not mixed into the harness model list.
    return discovered.length > 0
      ? discovered.map((model) => ({ id: model.id, name: model.name }))
      : this.harness.models.map((model) => ({ id: model.id, name: model.name }));
  }

  /** Auth/login state for the session. `user` is always whitelisted, never credentials. */
  authInfo(): AuthInfo {
    return {
      authenticated: this.authenticated,
      auth_methods: this.transport.authMethods(),
      state: this.state,
      model_id: this.modelId,
      model_name: this.modelName,
      harness_session_id: this.harnessSessionId,
      user: this.authUser,
    };
  }

  /**
   * Runtime echo for `launch_info`.
   *
   * Pids come from the per-session supervisor's metadata, because the supervisor — not the
   * daemon — spawns the harness. For a reused container the image, mounts, ports, and network
   * reported here are the values read back from `docker inspect`, because the request that
   * reused it cannot know them and the defaults would be misleading.
   */
  launchInfo(): Record<string, unknown> {
    const inspection = this.containerInspection;
    const supervisor = this.transport.supervisorInfo?.() ?? {};
    const base: Record<string, unknown> = {
      target: this.target,
      runtime: this.runtime,
      permission_mode: this.permissionMode,
      cwd: this.cwd,
      remote_host: this.spec.sshHost,
      supervisor_pid:
        typeof supervisor.supervisor_pid === "number" ? supervisor.supervisor_pid : process.pid,
      transport_pid:
        typeof supervisor.transport_pid === "number"
          ? supervisor.transport_pid
          : (this.transport.processId ?? null),
      transport_pgid:
        typeof supervisor.transport_pgid === "number"
          ? supervisor.transport_pgid
          : (this.transport.processGroupId ?? null),
      remote_pid_file:
        typeof supervisor.remote_pid_file === "string"
          ? supervisor.remote_pid_file
          : this.spec.remotePidFile,
      started_at:
        typeof supervisor.started_at === "string" ? supervisor.started_at : this.startedAt,
    };
    if (this.runtime !== "docker") return base;
    const reused = this.spec.reuseContainer;
    return {
      ...base,
      container_policy: this.containerPolicy,
      reused_container: reused,
      docker_container_name: this.spec.dockerContainerName,
      docker_image: reused ? (inspection?.image ?? null) : this.spec.dockerImage,
      mounts: (reused ? (inspection?.mounts ?? []) : this.spec.dockerMounts).map((mount) => ({ ...mount })),
      ports: (reused ? (inspection?.ports ?? []) : this.spec.dockerPorts).map((port) => ({ ...port })),
      host_network: reused ? (inspection?.hostNetwork ?? false) : this.spec.dockerHostNetwork,
    };
  }

  /**
   * The full container id to report at `create_session` top level for a kept container.
   *
   * Only a `keep` policy returns an id: the caller needs it to `reuse` the container in a
   * later session, whereas a `remove` container is deleted on close and reports none. The id
   * comes from the supervisor's metadata, because the supervisor — not the daemon — runs
   * `docker run` (or `docker start` when reusing). A missing or malformed id is a hard error,
   * so a caller never receives a bogus reuse handle.
   */
  keptContainerId(): string | null {
    if (this.runtime !== "docker" || this.containerPolicy !== "keep") return null;
    const info = this.transport.supervisorInfo?.() ?? {};
    const dockerId = info.docker_id;
    if (!isDockerId(dockerId)) {
      throw new SessionError(
        "docker_id_unavailable",
        "Docker container was kept but its container ID is unavailable",
      );
    }
    return dockerId;
  }

  /** True when nothing is running, queued, or awaiting an answer. */
  isIdle(): boolean {
    return this.current === null && this.queue.length === 0 && this.interactionResolve === null;
  }

  /**
   * Read the rolling preview by absolute byte offset.
   *
   * `offset` is a byte offset into the session preview stream. When it falls behind the
   * retained window the read is clamped forward and reported as `truncated` with the number
   * of dropped bytes, so a poller can resynchronize instead of losing data silently.
   * `stopped` becomes true once no further output can arrive (terminal message, or a closed
   * session), or immediately when `stop` is requested.
   */
  readOutput(options: LiveOutputOptions = {}): LiveOutput {
    const window = this.recorder.previewWindow();
    const maxBytes = Math.min(
      MAX_LIVE_OUTPUT_BYTES,
      Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_LIVE_OUTPUT_BYTES)),
    );
    const message = options.messageId ? this.messages.get(options.messageId) : undefined;
    if (options.messageId && !message) {
      throw new SessionError("unknown_message", `unknown message: ${options.messageId}`);
    }
    const terminal = message ? isTerminalMessageState(message.state) : this.closed;
    const base = {
      session_id: this.sessionId,
      message_id: message?.message_id ?? null,
      max_bytes: maxBytes,
      state: (message?.state ?? this.state) as MessageState | SessionState,
      terminal,
      window_start: window.start,
      window_end: window.end,
      message_end_offset: message?.preview_end ?? null,
      waited_ms: 0,
    };

    if (options.stop) {
      const offset = Math.max(0, Math.floor(options.offset ?? window.end));
      this.log(`live_output stopped${message ? ` for ${message.message_id}` : ""}`);
      return {
        ...base,
        chunk: "",
        offset,
        next_offset: offset,
        truncated: false,
        dropped_bytes: 0,
        stopped: true,
      };
    }

    const fallback = message ? (message.preview_start ?? window.end) : window.start;
    const from = options.offset ?? fallback;
    const slice = this.recorder.readPreviewChunk(from, maxBytes);
    const stopped = message
      ? terminal && message.preview_end !== null && slice.nextOffset >= message.preview_end
      : this.closed && slice.nextOffset >= window.end;
    return {
      ...base,
      chunk: slice.text,
      offset: slice.offset,
      next_offset: slice.nextOffset,
      truncated: slice.truncated,
      dropped_bytes: slice.droppedBytes,
      stopped,
    };
  }

  /**
   * Long-poll variant of `readOutput`: wait (bounded) for output to arrive or for the
   * message/session to settle, waking on preview changes instead of busy-polling. Aborts
   * early when `signal` fires (the IPC caller disconnected).
   */
  async listenOutput(options: LiveOutputOptions = {}): Promise<LiveOutput> {
    const waitMs = Math.max(0, Math.min(MAX_PREVIEW_WAIT_MS, Math.floor(options.waitMs ?? 0)));
    if (waitMs === 0) return this.readOutput(options);
    const settled = (): boolean => {
      try {
        const output = this.readOutput(options);
        return output.chunk.length > 0 || output.stopped;
      } catch {
        return true;
      }
    };
    const activity = await awaitPreviewActivity({
      previewPath: this.recorder.previewPath,
      waitMs,
      isSettled: settled,
      signal: options.signal,
    });
    return { ...this.readOutput(options), waited_ms: activity.waitedMs };
  }

  snapshot(): Record<string, unknown> {
    return { ...this.recorder.snapshot() };
  }

  status(): SessionStatus {
    return {
      session_id: this.sessionId,
      directory: this.directory,
      harness: this.harness.name,
      state: this.state,
      operation: this.operationState(),
      authenticated: this.authenticated,
      model_id: this.modelId,
      model_name: this.modelName,
      harness_session_id: this.harnessSessionId,
      cwd: this.cwd,
      permission_mode: this.permissionMode,
      created_at: this.createdAt,
      updated_at: this.nowIso(),
      closed_at: this.closedAt,
      running_message_id: this.current,
      queued_message_ids: [...this.queue],
      messages_total: this.messages.size,
      preview_bytes: this.recorder.previewSize(),
      harness_models: this.listModels(),
    };
  }

  /**
   * Close the session: cancel the running turn, cancel every queued message (with a
   * persisted result so it stays readable), close the transport, and flush the recorder.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.log("session closing");

    const running = this.current ? this.messages.get(this.current) : undefined;
    if (running && !isTerminalMessageState(running.state)) {
      this.markCancelled(running, { reason: "session_closed", by: null, interrupt: true });
    }
    for (const id of [...this.queue]) {
      const message = this.messages.get(id);
      if (message) this.markCancelled(message, { reason: "session_closed", by: null, interrupt: false });
    }
    this.queue.length = 0;
    this.interactionResolve?.("cancelled");

    // Closing the transport asks the supervisor to terminate the harness process group and
    // release the container/remote per policy before it exits.
    await this.transport.close().catch(() => undefined);
    this.removeSupervisorMetadata();
    if (this.pumpPromise) {
      // Bound the wait: a harness that never answers must not hold up close.
      await settleWithin(this.pumpPromise, CLOSE_PUMP_GRACE_MS);
    }

    this.state = "closed";
    this.closedAt = this.nowIso();
    this.persistAll();
    this.recorder.writeMeta(this.buildMeta());
    this.log("session closed");
    await this.recorder.close();
    this.recorderClosed = true;
  }

  /** Remove the supervisor's metadata file (best effort; the path is session-private). */
  private removeSupervisorMetadata(): void {
    if (this.metadataPath === null) return;
    try {
      unlinkSync(this.metadataPath);
    } catch {
      // Already gone.
    }
  }

  // --- queue pump ----------------------------------------------------------

  private pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    const promise = this.runPump().finally(() => {
      if (this.pumpPromise === promise) this.pumpPromise = null;
    });
    this.pumpPromise = promise;
    return promise;
  }

  private async runPump(): Promise<void> {
    while (!this.closed) {
      const id = this.queue.shift();
      if (!id) break;
      await this.runMessage(id);
    }
  }

  private async runMessage(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message || isTerminalMessageState(message.state)) return;
    message.state = "running";
    message.started_at = this.nowIso();
    message.preview_start = this.recorder.previewTotalBytes;
    this.current = messageId;
    this.persistAll();
    this.log(`message ${messageId} running`);

    try {
      await this.transport.beginTurn(message.text);
      while (!isTerminalMessageState(message.state)) {
        const event = await this.transport.waitForTurnEvent(this.config.transport.turnTimeoutSeconds * 1000);
        if (event.kind === "interaction") {
          const resumed = await this.handleInteraction(message, event.interaction);
          if (!resumed) break;
          continue;
        }
        this.completeMessage(message, event.result);
        break;
      }
    } catch (error) {
      if (!isTerminalMessageState(message.state)) this.failMessage(message, error);
      if (this.transport.turnActive) await this.transport.cancelTurn().catch(() => undefined);
    } finally {
      if (this.current === messageId) this.current = null;
      if (!this.closed) this.persistAll();
    }
  }

  private async handleInteraction(
    message: SessionMessageRecord,
    interaction: AcpInteraction,
  ): Promise<boolean> {
    if (isTerminalMessageState(message.state)) return false;
    message.state = "waiting_input";
    message.interaction = interactionDict(interaction);
    this.persistAll();
    this.log(`message ${message.message_id} waiting_input request=${interaction.requestId}`);

    const outcome = await this.waitForInteraction();
    message.interaction = null;
    if (outcome === "cancelled") return false;
    if (outcome === "timeout") {
      this.failMessage(
        message,
        new SessionError("interaction_timeout", `no answer for request ${interaction.requestId}`),
      );
      await this.transport.cancelTurn().catch(() => undefined);
      return false;
    }
    if (isTerminalMessageState(message.state)) return false;
    message.state = "running";
    this.persistAll();
    this.log(`message ${message.message_id} resumed`);
    return true;
  }

  private waitForInteraction(): Promise<InteractionOutcome> {
    return new Promise<InteractionOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: InteractionOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.interactionResolve = null;
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("timeout"), this.config.transport.turnTimeoutSeconds * 1000);
      if (typeof timer.unref === "function") timer.unref();
      this.interactionResolve = finish;
    });
  }

  // --- terminal transitions ------------------------------------------------

  private markCancelled(
    message: SessionMessageRecord,
    options: { reason: string; by: string | null; interrupt: boolean },
  ): void {
    if (isTerminalMessageState(message.state)) return;
    const captured =
      this.current === message.message_id && this.transport.turnActive
        ? this.transport.previewText
        : (message.text_result ?? "");
    message.state = "cancelled";
    message.finished_at = this.nowIso();
    message.stop_reason = null;
    message.cancelled_by = options.by;
    message.cancel_reason = options.reason;
    message.interaction = null;
    message.text_result = captured;
    message.tool_calls = this.transport.toolCallSummaries?.() ?? message.tool_calls;
    message.harness_session_id = this.transport.sessionId ?? message.harness_session_id;
    if (message.preview_start === null) message.preview_start = this.recorder.previewTotalBytes;
    message.preview_end = this.recorder.previewTotalBytes;
    this.persistResult(message);
    this.persistAll();
    this.log(
      `message ${message.message_id} cancelled (${options.reason}${options.by ? ` by ${options.by}` : ""})`,
    );
    if (options.interrupt) {
      this.interactionResolve?.("cancelled");
      if (this.transport.running) void this.transport.cancelTurn().catch(() => undefined);
    }
  }

  private completeMessage(message: SessionMessageRecord, result: AcpTurnResult): void {
    if (isTerminalMessageState(message.state)) return;
    message.state = result.status === "cancelled" ? "cancelled" : "completed";
    message.finished_at = this.nowIso();
    message.stop_reason = result.stopReason;
    message.interaction = null;
    message.text_result = result.text;
    message.tool_calls = result.toolCalls ?? [];
    message.harness_session_id = result.harnessSessionId;
    message.preview_end = this.recorder.previewTotalBytes;
    if (message.state === "cancelled") message.cancel_reason = "harness_cancelled";
    this.persistResult(message);
    this.persistAll();
    this.log(`message ${message.message_id} ${message.state} stop_reason=${message.stop_reason ?? "none"}`);
  }

  private failMessage(message: SessionMessageRecord, error: unknown): void {
    if (isTerminalMessageState(message.state)) return;
    message.state = "failed";
    message.finished_at = this.nowIso();
    message.interaction = null;
    message.preview_end = this.recorder.previewTotalBytes;
    // A failure is never a partial success: the final text and tool calls are discarded (any
    // streamed output stays available as a diagnostic preview through live_output).
    message.text_result = null;
    message.tool_calls = [];
    message.error = toErrorInfo(error);
    this.persistResult(message);
    this.persistAll();
    // Wake a turn that was waiting for an answer so it cannot dangle after the failure.
    this.interactionResolve?.("cancelled");
    this.log(`message ${message.message_id} failed code=${message.error.code}`);
  }

  /**
   * Fail an in-flight message when the transport goes away underneath it.
   *
   * Triggered by the transport's `exit`/`closed` events so a `waiting_input` or running turn
   * reaches a terminal `failed` state immediately instead of waiting out the turn timeout. A
   * normal session close sets `closed` first, so this is a no-op there.
   */
  private onTransportGone(): void {
    if (this.closed) return;
    const running = this.current ? this.messages.get(this.current) : undefined;
    if (running && !isTerminalMessageState(running.state)) {
      this.failMessage(
        running,
        new SessionError("transport", "the harness ACP transport closed before the message finished"),
      );
    }
    // The transport died outside a normal close (a fatal desync, a crash, an external kill):
    // the session can never interact with the harness again. Mark it failed so every further
    // mutating call is rejected instead of half-working against a dead transport.
    if (this.state !== "failed") {
      this.state = "failed";
      this.persistAll();
      this.log("session failed: the harness ACP transport is gone");
    }
  }

  // --- snapshots -----------------------------------------------------------

  private persistResult(message: SessionMessageRecord): void {
    if (this.recorderClosed) return;
    this.recorder.writeResult(message.message_id, this.resultOf(message) as unknown as Record<string, unknown>);
  }

  private persistAll(): void {
    if (this.recorderClosed) return;
    this.recorder.writeState(this.stateSnapshot());
    this.recorder.writeQueue(this.queueSnapshot());
  }

  private stateSnapshot(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      harness: this.harness.name,
      state: this.state,
      operation: this.operationState(),
      authenticated: this.authenticated,
      model_id: this.modelId,
      model_name: this.modelName,
      harness_session_id: this.harnessSessionId,
      cwd: this.cwd,
      permission_mode: this.permissionMode,
      created_at: this.createdAt,
      updated_at: this.nowIso(),
      closed_at: this.closedAt,
      running_message_id: this.current,
      queued_message_ids: [...this.queue],
      messages_total: this.messages.size,
      preview_bytes: this.recorder.previewSize(),
      // Absolute preview length so a post-restart reader can reconstruct the window.
      preview_total_bytes: this.recorder.previewTotalBytes,
    };
  }

  private queueSnapshot(): Record<string, unknown> {
    return {
      updated_at: this.nowIso(),
      running: this.current,
      queued: [...this.queue],
      // Committed in the SAME atomic write as the messages below: a message and the
      // idempotency mapping that names it can never disagree after a crash.
      idempotency: Object.fromEntries(this.idempotency),
      messages: Object.fromEntries(
        [...this.messages.values()].map((message) => [
          message.message_id,
          {
            state: message.state,
            seq: message.seq,
            mode: message.mode,
            created_at: message.created_at,
            started_at: message.started_at,
            finished_at: message.finished_at,
            cancelled_by: message.cancelled_by,
            cancel_reason: message.cancel_reason,
            stop_reason: message.stop_reason,
            error: message.error,
            output_start_offset: message.preview_start,
            output_end_offset: message.preview_end,
            interaction: message.interaction
              ? {
                  request_id: message.interaction.request_id,
                  permission: message.interaction.permission,
                }
              : null,
            result_file: `${RESULTS_DIR}/${message.message_id}.json`,
          },
        ]),
      ),
    };
  }

  private statusOf(message: SessionMessageRecord): MessageStatus {
    const terminal = isTerminalMessageState(message.state);
    return {
      message_id: message.message_id,
      state: message.state,
      terminal,
      mode: message.mode,
      seq: message.seq,
      created_at: message.created_at,
      started_at: message.started_at,
      finished_at: message.finished_at,
      queue_position: message.state === "queued" ? this.queue.indexOf(message.message_id) : null,
      cancellable: !terminal,
      interaction: message.interaction,
      cancelled_by: message.cancelled_by,
      cancel_reason: message.cancel_reason,
      stop_reason: message.stop_reason,
      error: message.error,
      preview_bytes: this.recorder.previewSize(),
      output_start_offset: message.preview_start,
      output_end_offset: message.preview_end,
      result_available: terminal,
    };
  }

  private resultOf(message: SessionMessageRecord): MessageResult {
    const status = this.statusOf(message);
    // Result fields are exposed only for a terminal message: a non-terminal poll must not be
    // mistakable for a final answer, even though the preview is readable via live_output.
    if (!status.terminal) return status;
    return {
      ...status,
      text: message.text_result,
      tool_calls: message.tool_calls,
      harness_session_id: message.harness_session_id,
    };
  }

  private onSessionUpdate(update: unknown): void {
    if (!isRecord(update) || update.sessionUpdate !== "agent_message_chunk") return;
    const content = update.content;
    if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
      // Incremental append keeps preview.txt tail-able by live_output.
      this.recorder.appendPreview(content.text);
    }
  }

  // --- meta / misc ---------------------------------------------------------

  private buildMeta(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      harness: this.harness.name,
      state: this.state,
      created_at: this.createdAt,
      updated_at: this.nowIso(),
      session_dir: this.directory,
      // Creation parameters as requested.
      params: {
        harness: this.harness.name,
        cwd: this.cwd,
        model_id: this.modelId,
        permission_mode: this.permissionMode,
        runtime: this.runtime,
        target: this.target,
        remote_host: this.spec.sshHost,
        resume_session_id: this.resumeSessionId,
        authenticate: this.authenticateMethod,
        docker: this.runtime === "docker" ? this.dockerParams() : null,
        buffers: {
          max_read_bytes: this.config.buffers.maxReadBytes,
          max_output_bytes: this.config.buffers.maxOutputBytes,
          preview_bytes: this.config.buffers.previewBytes,
        },
      },
      // Effective values actually used (echo). Redaction is applied on write.
      echo: {
        command: this.spec.argv[0] ?? null,
        args: this.spec.argv.slice(1),
        env: this.harness.env,
        cwd: this.cwd,
        permission_mode: this.permissionMode,
        model_id: this.transport.modelId ?? this.modelId,
        model_name: this.transport.modelName,
        harness_session_id: this.harnessSessionId,
        launch_info: this.launchInfo(),
      },
    };
  }

  /** Docker creation parameters, as supplied (a reused container reports `null` options). */
  private dockerParams(): Record<string, unknown> {
    const reused = this.spec.reuseContainer;
    return {
      docker_id: this.spec.dockerId,
      docker_image: reused ? null : this.spec.dockerImage,
      container_policy: this.containerPolicy,
      reused_container: reused,
      mounts: reused ? [] : this.spec.dockerMounts.map((mount) => ({ ...mount })),
      ports: reused ? [] : this.spec.dockerPorts.map((port) => ({ ...port })),
      host_network: reused ? false : this.spec.dockerHostNetwork,
    };
  }

  private log(text: string): void {
    this.recorder.appendLog(text);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private requireOpen(): void {
    if (this.closed) throw new SessionError("session_closed", `session ${this.sessionId} is closed`);
    if (this.state === "failed") {
      throw new SessionError(
        "session_failed",
        `session ${this.sessionId} is no longer usable: the harness ACP transport is gone`,
      );
    }
  }
}

function persistedResult(result: Record<string, unknown>): MessageResult {
  const state = typeof result.state === "string" ? (result.state as MessageState) : "failed";
  return {
    message_id: String(result.message_id ?? ""),
    state,
    terminal: isTerminalMessageState(state),
    mode: (result.mode === "steering" ? "steering" : "queue") as MessageMode,
    seq: typeof result.seq === "number" ? result.seq : 0,
    created_at: String(result.created_at ?? ""),
    started_at: strField(result, "started_at"),
    finished_at: strField(result, "finished_at"),
    queue_position: null,
    cancellable: false,
    interaction: null,
    cancelled_by: strField(result, "cancelled_by"),
    cancel_reason: strField(result, "cancel_reason"),
    stop_reason: strField(result, "stop_reason"),
    error: isRecord(result.error) ? (result.error as unknown as MessageErrorInfo) : null,
    preview_bytes: numField(result, "preview_bytes") ?? 0,
    output_start_offset: numField(result, "output_start_offset"),
    output_end_offset: numField(result, "output_end_offset"),
    result_available: true,
    persisted: true,
    text: strField(result, "text"),
    tool_calls: Array.isArray(result.tool_calls)
      ? (result.tool_calls.filter(isRecord) as Array<Record<string, unknown>>)
      : [],
    harness_session_id: strField(result, "harness_session_id"),
  };
}

function toErrorInfo(error: unknown): MessageErrorInfo {
  if (error instanceof SessionError) {
    return { code: error.code, message: error.message, detail: redactSensitive(error.detail) };
  }
  // Transport/output failures carry a stable machine code (invalid_json, malformed_message,
  // line_too_large, output_limit, output_timeout, transport, acp_rpc_error).
  const acpCode = acpErrorCode(error);
  if (acpCode !== null) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: acpCode, message: String(redactSensitive(message)) };
  }
  if (error instanceof Error) {
    return {
      code: error.name === "Error" ? "error" : error.name,
      message: String(redactSensitive(error.message)),
    };
  }
  return { code: "error", message: String(redactSensitive(error)) };
}

/**
 * Path of the compiled per-session supervisor.
 *
 * Resolved next to this module (`dist/supervisor.js` beside `dist/session.js`), overridable
 * with `HARNESS_ACP_SUPERVISOR` for a custom build layout.
 */
function supervisorScriptPath(): string {
  const override = process.env.HARNESS_ACP_SUPERVISOR;
  if (override) return override;
  return fileURLToPath(new URL("./supervisor.js", import.meta.url));
}

/**
 * Build the ACP transport for a launch spec.
 *
 * The daemon spawns the per-session supervisor (never the harness directly). The supervisor
 * prepares the container, owns the harness process group, proxies stdio byte-for-byte, and
 * cleans up when this process closes the pipe or dies.
 */
function createAcpClient(
  spec: LaunchSpec,
  config: BridgeConfig,
  recorder: SessionRecorder,
  logger: AcpLogger | undefined,
  metadataPath: string,
): AcpTransport {
  const supervisorSpec: SupervisorSpec = { ...spec, metadataPath, daemonPid: process.pid };
  return new AcpClient({
    command: process.execPath,
    args: [supervisorScriptPath()],
    // The supervisor runs locally; the ACP cwd belongs to the harness target and must
    // not be used as the local spawn cwd (it may exist only inside remote Docker).
    sessionCwd: spec.cwd,
    env: { [SUPERVISOR_SPEC_ENV]: JSON.stringify(supervisorSpec) },
    configuredModels: [],
    recorder,
    metadataPath,
    maxReadBytes: config.buffers.maxReadBytes,
    stderrTailLines: config.transport.stderrTailLines,
    startupTimeoutMs: config.transport.startupTimeoutSeconds * 1000,
    cancelTimeoutMs: config.transport.turnCancelTimeoutSeconds * 1000,
    terminateGraceMs: config.transport.terminateGraceSeconds * 1000,
    // One graceful close budget: the supervisor needs terminate grace plus the bounded
    // container/remote cleanup before it exits.
    supervisorShutdownMs:
      (config.transport.terminateGraceSeconds + config.transport.remoteCleanupTimeoutSeconds) * 1000,
    logger,
  });
}
