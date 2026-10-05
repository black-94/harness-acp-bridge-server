/**
 * ACP JSON-RPC 2.0 stdio transport.
 *
 * Ports the reference client from `harness_acp_mcp/acp.py`: newline-delimited JSON-RPC
 * over the harness's stdin/stdout, bounded oversized-line handling, redacted raw-stream
 * recording, ACP session lifecycle, model list/selection, turn prompts, and reverse
 * interaction requests (unified permission / information requests).
 *
 * This layer stays deliberately turn-based (one `beginTurn` -> `waitForTurnEvent` cycle).
 * `BridgeSession` (src/session.ts) owns the per-session queue and drives cycles one at a
 * time; the daemon and the MCP client never block on a cycle, they poll instead.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { HarnessAdapter } from "./adapters.js";
import {
  RollingPreview,
  SessionRecorder,
  readJsonFileSafe,
  redactSensitive,
  type RawStream,
} from "./persistence.js";

export const PROTOCOL_VERSION = 1;
export const CLIENT_NAME = "harness-acp-bridge";
// Both src/ (tests) and dist/ (published CLI) live one level below package.json.
// Keep the MCP/ACP handshake version in sync with `npm version`.
export const CLIENT_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

// Bound the work spent on misbehaving harness output: within the budget only the
// offending line is dropped; beyond it the transport is closed.
const MAX_CONSECUTIVE_OVERSIZED_LINES = 32;
const OVERSIZED_LINE_BYTE_BUDGET_MULTIPLIER = 8;
const DEFAULT_MAX_READ_BYTES = 100 * 1024 * 1024;
const DEFAULT_STDERR_TAIL_LINES = 200;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

export type JsonRpcMessage = Record<string, unknown>;

export class AcpError extends Error {
  override name = "AcpError";
}

/**
 * Categories for a failure caused by the harness's output stream or a response timeout.
 *
 * A message whose turn hits one of these is **failed** with this code; the bridge never
 * continues on partial output (see `BridgeSession.failMessage`). They are machine-readable so
 * a caller can tell a malformed stream apart from a limit or a timeout without parsing text.
 */
export type AcpOutputErrorCode =
  | "invalid_json"
  | "malformed_message"
  | "line_too_large"
  | "output_limit"
  | "output_timeout";

/** A protocol/output failure that must fail the message rather than be silently skipped. */
export class AcpOutputError extends AcpError {
  override name = "AcpOutputError";
  readonly outputCode: AcpOutputErrorCode;

  constructor(code: AcpOutputErrorCode, message: string) {
    super(message);
    this.outputCode = code;
  }
}

/** The harness exceeded the bounded discard budget; the transport is closed. */
export class AcpDiscardLimitExceeded extends AcpOutputError {
  override name = "AcpDiscardLimitExceeded";

  constructor(message: string) {
    super("output_limit", message);
  }
}

export class AcpRpcError extends AcpError {
  override name = "AcpRpcError";
  readonly code: number | null;
  readonly error: unknown;

  constructor(error: unknown) {
    super(`ACP request failed: ${JSON.stringify(redactSensitive(error))}`);
    this.error = error;
    this.code =
      error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "number"
        ? ((error as { code: number }).code)
        : null;
  }
}

/** One ACP stdout line exceeded max_read_bytes: the stream cannot be trusted, so it is closed. */
export class AcpLineTooLarge extends AcpOutputError {
  override name = "AcpLineTooLarge";
  readonly limit: number;

  constructor(limit: number) {
    super(
      "line_too_large",
      `ACP JSON line exceeded max_read_bytes (${limit} bytes); the message is failed and the ` +
        "transport is closed instead of resynchronizing on a possibly truncated line.",
    );
    this.limit = limit;
  }
}

/**
 * Machine-readable code for a failure raised by the ACP transport, or `null` for an unrelated
 * error. `BridgeSession` reports this as the failed message's `error.code`.
 */
export function acpErrorCode(error: unknown): string | null {
  if (error instanceof AcpOutputError) return error.outputCode;
  if (error instanceof AcpRpcError) return "acp_rpc_error";
  if (error instanceof AcpError) return "transport";
  return null;
}

export interface AcpModel {
  id: string;
  name: string;
}

/**
 * A reverse request from the harness, unified across permission and information sources.
 *
 * `permission` is the only marker that distinguishes them: it is `true` when the harness
 * asked for permission (`session/request_permission`) and `false` for an information request
 * (`session/request_input`/`session/request_information`/`session/request_user_input`/
 * `elicitation/create`).
 */
export interface AcpInteraction {
  rpcId: number | string;
  requestId: string;
  permission: boolean;
  sessionId: string;
  title: string;
  message: string;
  options: Array<Record<string, unknown>>;
  schema: Record<string, unknown> | null;
  defaults: Record<string, unknown> | null;
  responseStyle: "content" | "elicitation";
  rawInput: Record<string, unknown>;
  meta: Record<string, unknown>;
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

/**
 * How a pending interaction is answered.
 *
 * `accept` carries the concrete answer. The three non-accept kinds differ in intent and are
 * routed to the harness-specific outcome by `AcpClient.respondInteraction`:
 * - `reject` declines this one request; for a permission a "soft no" selects the offered
 *   reject/deny option when one exists, so the harness may continue.
 * - `timeout` reports that no decision was made in time (an implicit non-answer).
 * - `cancel` explicitly withdraws the request: a permission is always sent the terminal
 *   `cancelled` outcome (never a deny option) and an elicitation is cancelled.
 */
export type InteractionAnswer = "accept" | "reject" | "timeout" | "cancel";

export interface AcpTurnResult {
  status: "completed" | "cancelled";
  text: string;
  stopReason: string | null;
  toolCalls: Array<Record<string, unknown>>;
  harnessSessionId: string | null;
}

export type AcpTurnEvent =
  | { kind: "complete"; result: AcpTurnResult }
  | { kind: "interaction"; interaction: AcpInteraction };

export interface AcpLogger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

export interface AcpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the spawned transport; `undefined` inherits (docker/remote). */
  cwd?: string;
  /** Harness working directory sent over ACP; may exist only on a remote/container target. */
  sessionCwd?: string;
  /** Configured model list used when the harness does not advertise its own. */
  configuredModels?: AcpModel[];
  /** Harness-owned model selection (the transport still owns state and busy checks). */
  modelAdapter?: HarnessAdapter;
  /** Opt-in append-only recording of redacted raw ACP traffic. */
  recorder?: SessionRecorder | null;
  maxReadBytes?: number;
  stderrTailLines?: number;
  startupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  terminateGraceMs?: number;
  /**
   * How long to wait for the child to exit on its own after its stdin is closed.
   *
   * When the child is a per-session supervisor, closing stdin is the close request: the
   * supervisor terminates the harness process group and runs the container/remote cleanup
   * before exiting, which can take `terminate_grace + remote_cleanup_timeout`.
   */
  supervisorShutdownMs?: number;
  /** Private metadata file written by a supervisor child (pids, container id). */
  metadataPath?: string;
  clientName?: string;
  clientVersion?: string;
  logger?: AcpLogger;
}

type LineEvent =
  | { kind: "line"; line: Buffer }
  | { kind: "overflow" }
  | { kind: "discardLimit" };

/**
 * Newline splitter with a bounded discard budget.
 *
 * Accumulated bytes are dropped once a single line exceeds `maxLineBytes`; the rest of
 * that line is skipped until its newline, and the transport is reported as unusable when
 * one line grows past `maxDiscardBytes` (mirrors Python's `acp.LimitOverrunError` path).
 */
class LineSplitter {
  private buffer = Buffer.alloc(0);
  private discarding = false;
  private discarded = 0;

  constructor(
    private readonly maxLineBytes: number,
    private readonly maxDiscardBytes: number,
  ) {}

  push(chunk: Buffer): LineEvent[] {
    const events: LineEvent[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (this.discarding) {
        const end = newline === -1 ? chunk.length : newline;
        this.discarded += end - offset + (newline === -1 ? 0 : 1);
        if (this.discarded > this.maxDiscardBytes) {
          events.push({ kind: "discardLimit" });
          return events;
        }
        if (newline === -1) {
          offset = chunk.length;
        } else {
          this.discarding = false;
          this.discarded = 0;
          this.buffer = Buffer.alloc(0);
          offset = newline + 1;
          events.push({ kind: "overflow" });
        }
        continue;
      }
      if (newline === -1) {
        const rest = chunk.subarray(offset);
        this.buffer = this.buffer.length === 0 ? Buffer.from(rest) : Buffer.concat([this.buffer, rest]);
        offset = chunk.length;
        if (this.buffer.length > this.maxLineBytes) {
          this.discarded = this.buffer.length;
          this.buffer = Buffer.alloc(0);
          this.discarding = true;
          if (this.discarded > this.maxDiscardBytes) {
            events.push({ kind: "discardLimit" });
            return events;
          }
        }
        continue;
      }
      const piece = chunk.subarray(offset, newline);
      const line = this.buffer.length === 0 ? Buffer.from(piece) : Buffer.concat([this.buffer, piece]);
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      events.push(line.length > this.maxLineBytes ? { kind: "overflow" } : { kind: "line", line });
    }
    return events;
  }
}

interface PendingRequest {
  method: string;
  resolve(message: JsonRpcMessage): void;
  reject(error: Error): void;
}

interface InteractionWaiter {
  resolve(interaction: AcpInteraction): void;
  reject(error: Error): void;
}

interface TurnState {
  promise: Promise<JsonRpcMessage>;
  settled: boolean;
  message: JsonRpcMessage | null;
  error: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A JSON number that is finite (rejects `Infinity`/`-Infinity` from e.g. `1e999`). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(finish, finish);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpOutputError("output_timeout", `${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AcpClient extends EventEmitter {
  readonly options: Pick<AcpClientOptions, "command" | "cwd" | "args" | "env">;

  sessionId: string | null = null;
  modelId: string | null = null;
  modelName: string | null = null;
  initializeResponse: JsonRpcMessage = {};

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: LineSplitter | null = null;
  private stderrReader: LineSplitter | null = null;
  private readonly maxReadBytes: number;
  private readonly maxDiscardBytes: number;
  private readonly stderrTailLines: number;
  private readonly startupTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly terminateGraceMs: number;
  private readonly supervisorShutdownMs: number;
  private readonly metadataPath: string | null;
  private readonly sessionCwd: string;
  private readonly configuredModels: AcpModel[];
  private readonly modelAdapter: HarnessAdapter | undefined;
  private observedReasoningEffort: string | null = null;
  private readonly recorder: SessionRecorder | null;
  private readonly preview: RollingPreview;
  private readonly logger: AcpLogger;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private turn: TurnState | null = null;
  private pendingInteraction: AcpInteraction | null = null;
  private readonly interactionQueue: AcpInteraction[] = [];
  private readonly interactionWaiters: InteractionWaiter[] = [];
  private readonly stderrTail: string[] = [];
  private readonly toolCalls = new Map<string, Record<string, unknown>>();
  private readonly modelNames = new Map<string, string>();
  private availableModels: AcpModel[] = [];
  private sessionConfigOptions: Array<Record<string, unknown>> | null = null;
  private consecutiveOversizedStderr = 0;
  private closed = false;
  /**
   * Set when a fatal output/protocol error has failed the pending work. Once broken the
   * transport ignores any further stdout, so a residual line can never be mistaken for the
   * continuation of the failed turn.
   */
  private broken = false;

  private readonly clientName: string;
  private readonly clientVersion: string;

  constructor(options: AcpClientOptions) {
    super();
    this.options = { command: options.command, cwd: options.cwd, args: options.args, env: options.env };
    this.sessionCwd = options.sessionCwd ?? options.cwd ?? process.cwd();
    this.clientName = options.clientName ?? CLIENT_NAME;
    this.clientVersion = options.clientVersion ?? CLIENT_VERSION;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxDiscardBytes = this.maxReadBytes * OVERSIZED_LINE_BYTE_BUDGET_MULTIPLIER;
    this.stderrTailLines = options.stderrTailLines ?? DEFAULT_STDERR_TAIL_LINES;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    this.supervisorShutdownMs = options.supervisorShutdownMs ?? this.terminateGraceMs;
    this.metadataPath = options.metadataPath ?? null;
    this.configuredModels = options.configuredModels ?? [];
    this.modelAdapter = options.modelAdapter;
    this.recorder = options.recorder ?? null;
    this.preview = new RollingPreview();
    this.logger = options.logger ?? {};
  }

  get running(): boolean {
    // A broken transport is not usable even while its process is still exiting: `fatal()`
    // terminated it, and `beginTurn`/`setModel` must refuse immediately, not race the exit.
    return (
      !this.closed &&
      !this.broken &&
      this.child !== null &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  get turnActive(): boolean {
    return this.turn !== null && !this.turn.settled;
  }

  get pendingInteractionRequest(): AcpInteraction | null {
    return this.pendingInteraction;
  }

  /** Rolling preview of the current (or last completed) turn's assistant text. */
  get previewText(): string {
    return this.preview.text();
  }

  get stderrTailText(): string {
    return this.stderrTail.join("\n");
  }

  get processId(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * The transport's process group id.
   *
   * The child is spawned as a session leader, so its group id equals its pid. Exposed so
   * `launch_info` can report it, matching the reference supervisor's `transport_pgid`.
   */
  get processGroupId(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Metadata written by a per-session supervisor child (pids, container id), or `{}`.
   *
   * The supervisor owns the harness process group, so its own pid is not the transport pid;
   * `launch_info` reads the real values from here.
   */
  supervisorInfo(): Record<string, unknown> {
    if (this.metadataPath === null) return {};
    return readJsonFileSafe(this.metadataPath) ?? {};
  }

  /** The raw `initialize` response, for adapters that probe authentication. */
  initializeResponseMessage(): JsonRpcMessage {
    return this.initializeResponse;
  }

  toolCallSummaries(): Array<Record<string, unknown>> {
    return [...this.toolCalls.values()];
  }

  /**
   * Config model list basics plus ACP discovery: models advertised by the harness during
   * initialize / session creation take precedence over the configured list.
   */
  listModels(): AcpModel[] {
    const models = this.availableModels.length > 0 ? this.availableModels : this.configuredModels;
    if (this.modelAdapter?.name !== "codex") return models.map((model) => ({ ...model }));
    // Codex's legacy discovery expands every model into model[effort] variants.
    // Expose the same base IDs used by the modern model option and our config.
    const option = this.sessionConfigOptions?.find((entry) => entry.id === "model" || entry.configId === "model");
    if (Array.isArray(option?.options)) {
      const advertised = option.options.filter(isRecord).filter((entry) => typeof entry.value === "string");
      if (advertised.length > 0) return advertised.map((entry) => ({ id: entry.value as string, name: typeof entry.name === "string" ? entry.name : entry.value as string }));
    }
    const unique = new Map<string, AcpModel>();
    for (const model of models) {
      const id = model.id.replace(/\[[^\]]+\]$/, "");
      if (!unique.has(id)) unique.set(id, { id, name: model.name.replace(/ \((?:low|medium|high|xhigh|max|ultra|minimal)\)$/, "") });
    }
    return [...unique.values()];
  }

  /** Null means the harness did not advertise config options; [] means none are supported. */
  configOptions(): Array<Record<string, unknown>> | null {
    return this.sessionConfigOptions;
  }

  authMethods(): Array<Record<string, unknown>> {
    const result = isRecord(this.initializeResponse.result) ? this.initializeResponse.result : null;
    const methods = result?.authMethods;
    return Array.isArray(methods) ? methods.filter(isRecord) : [];
  }

  /** Launch the harness and complete the ACP `initialize` handshake. */
  async start(): Promise<JsonRpcMessage> {
    if (this.running) return this.initializeResponse;
    if (this.closed) throw new AcpError("ACP client is closed");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: { ...process.env, ...(this.options.env ?? {}) },
        detached: process.platform !== "win32",
      });
    } catch (error) {
      throw new AcpError(`failed to launch harness: ${errorMessage(error)}`);
    }
    this.child = child;
    this.stdoutReader = new LineSplitter(this.maxReadBytes, this.maxDiscardBytes);
    this.stderrReader = new LineSplitter(this.maxReadBytes, this.maxDiscardBytes);

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.stdin.on("error", (error) => this.failPending(new AcpError(this.exitMessage(`harness ACP stdin failed: ${errorMessage(error)}`))));
    child.on("error", (error) => this.onProcessError(error));
    child.on("exit", (code, signal) => this.onProcessExit(code, signal));

    try {
      this.initializeResponse = await withTimeout(
        this.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { configOptions: { boolean: {} } },
            // Form-only ACP elicitation. `url` is deliberately never advertised, so the harness
            // must not request it; a URL-mode request is answered with -32602 (see
            // handleIncomingRequest). This matches the stabilized ACP elicitation capability,
            // where each supported mode must be explicit.
            elicitation: { form: {} },
          },
          clientInfo: {
            name: this.clientName,
            title: "Harness ACP Bridge",
            version: this.clientVersion,
          },
        }),
        this.startupTimeoutMs,
        "ACP initialize",
      );
      this.updateModelInfo(this.initializeResponse);
    } catch (error) {
      await this.close();
      throw error;
    }
    return this.initializeResponse;
  }

  /** Create a new ACP session, or load `resumeSessionId` when provided. */
  async openSession(resumeSessionId?: string | null): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (!this.running) throw new AcpError("harness ACP transport is not running");
    const response = resumeSessionId
      ? await this.request("session/load", { sessionId: resumeSessionId, cwd: this.sessionCwd, mcpServers: [] })
      : await this.request("session/new", { cwd: this.sessionCwd, mcpServers: [] });
    this.updateModelInfo(response);
    this.updateConfigOptions(response);
    const result = isRecord(response.result) ? response.result : null;
    let sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
    if (!sessionId && resumeSessionId) sessionId = resumeSessionId;
    if (!sessionId) throw new AcpError(`harness did not return a sessionId: ${JSON.stringify(response)}`);
    this.sessionId = sessionId;
    return sessionId;
  }

  /** Switch the harness model while no turn is active. */
  async setModel(modelId: string): Promise<void> {
    const target = modelId.trim();
    if (!target) throw new AcpError("model_id must not be empty");
    if (!this.running || !this.sessionId) throw new AcpError("harness ACP session is not ready");
    if (this.turnActive || this.pendingInteraction !== null) {
      throw new AcpError("cannot switch model while a turn is active");
    }
    const response = this.modelAdapter
      ? await this.modelAdapter.setModel({
          sessionId: () => this.sessionId,
          initializeResponse: () => this.initializeResponse,
          configOptions: () => this.sessionConfigOptions,
          modelId: () => this.modelId,
          reasoningEffort: () => this.observedReasoningEffort,
          request: (method, params) => this.request(method, params),
        }, target)
      : await this.request("session/set_model", { sessionId: this.sessionId, modelId: target });
    // A new model may support different levels; don't validate against stale options.
    this.sessionConfigOptions = null;
    this.updateConfigOptions(response);
    this.modelId = target;
    this.modelName = this.listModels().find((model) => model.id === target)?.name ?? this.modelNames.get(target) ?? target;
  }

  /** Authenticate the harness with one of its advertised `authMethods`. */
  async authenticate(methodId: string): Promise<JsonRpcMessage> {
    const available = new Set(
      this.authMethods()
        .map((method) => method.id)
        .filter((value): value is string => typeof value === "string"),
    );
    if (available.size > 0 && !available.has(methodId)) {
      throw new AcpError(`authentication method ${JSON.stringify(methodId)} is unavailable`);
    }
    return this.request("authenticate", { methodId });
  }

  /** Start a turn. The returned promise is consumed by `waitForTurnEvent`. */
  async beginTurn(prompt: string): Promise<void> {
    if (!this.running || !this.sessionId) throw new AcpError("harness ACP session is not ready");
    if (this.turn) throw new AcpError("a harness turn is already active");
    if (this.pendingInteraction !== null) throw new AcpError("an interaction is awaiting a response");
    this.preview.reset();
    this.toolCalls.clear();
    this.drainInteractions();

    const promise = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    const state: TurnState = { promise, settled: false, message: null, error: null };
    this.turn = state;
    promise.then(
      (message) => {
        state.settled = true;
        state.message = message;
      },
      (error) => {
        state.settled = true;
        state.error = error;
      },
    );
  }

  /** Await either turn completion or the next interaction the harness requests. */
  async waitForTurnEvent(timeoutMs: number): Promise<AcpTurnEvent> {
    const turn = this.turn;
    if (!turn) throw new AcpError("no harness turn is active");
    const { promise: interactionPromise, cancel } = this.takeInteraction();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const winner = await Promise.race([
        turn.promise.then((message) => ({ kind: "turn" as const, message })),
        interactionPromise.then((interaction) => ({ kind: "interaction" as const, interaction })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new AcpOutputError("output_timeout", `harness turn timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      if (winner.kind === "turn") {
        cancel();
        this.turn = null;
        this.pendingInteraction = null;
        return { kind: "complete", result: this.turnResult(winner.message) };
      }
      this.pendingInteraction = winner.interaction;
      return { kind: "interaction", interaction: winner.interaction };
    } catch (error) {
      cancel();
      if (this.turn === turn && turn.settled) this.turn = null;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Answer the pending interaction and continue.
   *
   * `answer` selects the ACP outcome routed to the harness:
   * - `"accept"` (default) requires the concrete answer in `response`.
   * - `"reject"` declines: a permission request selects the offered reject/deny option when
   *   one exists (otherwise the `cancelled` outcome); an elicitation request is declined.
   * - `"timeout"` reports that no decision was made: a permission request gets the
   *   `cancelled` outcome and an elicitation request is cancelled.
   * - `"cancel"` withdraws the request outright: a permission request always gets the
   *   terminal `cancelled` outcome (never a deny option) and an elicitation request is
   *   cancelled.
   *
   * Returns `false` when the interaction has no protocol-level decline/cancel — a plain
   * information request only accepts `{ content }` — leaving it to the caller to cancel the
   * turn. Returns `true` once a response was sent.
   */
  async respondInteraction(
    requestId: string,
    response: unknown,
    answer: InteractionAnswer = "accept",
  ): Promise<boolean> {
    const interaction = this.pendingInteraction;
    if (!interaction) throw new AcpError("no interaction is pending");
    if (interaction.requestId !== requestId) {
      throw new AcpError("request_id does not match the pending interaction");
    }
    let result: Record<string, unknown>;
    if (answer === "accept") {
      if (interaction.permission) {
        const optionId = isRecord(response) ? response.option_id : undefined;
        if (typeof optionId !== "string") throw new AcpError("permission response requires option_id");
        const valid = new Set(
          interaction.options
            .map((option) => option.optionId)
            .filter((value): value is string => typeof value === "string"),
        );
        if (!valid.has(optionId)) throw new AcpError(`unknown permission option_id: ${optionId}`);
        result = { outcome: { outcome: "selected", optionId } };
      } else {
        if (!isRecord(response)) throw new AcpError("information response must be an object");
        result =
          interaction.responseStyle === "elicitation"
            ? { action: "accept", content: response }
            : { content: response };
      }
    } else if (interaction.permission) {
      // `reject` prefers an offered deny option (a "soft no" the harness can recover from);
      // `timeout` and `cancel` always send the terminal `cancelled` outcome.
      const reject = answer === "reject" ? AcpClient.rejectOption(interaction) : null;
      result = reject
        ? { outcome: { outcome: "selected", optionId: reject } }
        : { outcome: { outcome: "cancelled" } };
    } else if (interaction.responseStyle === "elicitation") {
      // `reject` declines this one request; `timeout` and `cancel` withdraw the elicitation.
      result = { action: answer === "reject" ? "decline" : "cancel" };
    } else {
      // A plain information request only understands `{ content }`; there is no protocol
      // decline/cancel, so the caller must cancel the turn instead.
      return false;
    }
    this.pendingInteraction = null;
    await this.send({ jsonrpc: "2.0", id: interaction.rpcId, result });
    return true;
  }

  /**
   * Cancel the current turn and wait for the `session/prompt` settlement.
   *
   * Best effort while the session can stay alive: if the harness honours the cancel (or at
   * least settles the prompt request) within `cancelTimeoutMs`, the session is reusable. A
   * harness that ignores `session/cancel` past the budget leaves the stream out of sync, so
   * the transport is fatally closed instead (see the settlement block below) and the client
   * becomes unusable.
   */
  async cancelTurn(): Promise<void> {
    const interaction = this.pendingInteraction;
    if (interaction) {
      if (interaction.permission) {
        const reject = AcpClient.rejectOption(interaction);
        if (reject) {
          await this.respondInteraction(interaction.requestId, { option_id: reject }).catch(() => undefined);
        }
      } else if (interaction.responseStyle === "elicitation") {
        this.pendingInteraction = null;
        await this.send({ jsonrpc: "2.0", id: interaction.rpcId, result: { action: "cancel" } }).catch(() => undefined);
      }
      this.pendingInteraction = null;
    }
    if (this.sessionId && this.running) {
      await this.notify("session/cancel", { sessionId: this.sessionId }).catch(() => undefined);
    }
    // The settlement of the outstanding `session/prompt` JSON-RPC request is the only safe
    // boundary: until its response (or error) arrives, the harness still owns the turn and
    // any further stream output cannot be attributed. Observe the settlement instead of
    // ignoring it: once settled (either outcome) the session is reusable; if the harness
    // ignored `session/cancel` and never settles within the budget, the stream is out of
    // sync — fail everything and close the transport, leaving the turn in place so no new
    // turn can begin on this client (`beginTurn` also refuses because `running` is false).
    const turn = this.turn;
    if (turn) {
      const settled = await waitFor(turn.promise, this.cancelTimeoutMs);
      if (!settled) {
        this.fatal(
          new AcpOutputError(
            "output_timeout",
            `harness did not settle the session/prompt response within ${this.cancelTimeoutMs}ms ` +
              "of session/cancel; the transport was closed because further output cannot be trusted",
          ),
        );
        return;
      }
      this.turn = null;
    }
    this.pendingInteraction = null;
    this.drainInteractions();
  }

  /** Pick a deny/reject option from a permission request, if one is offered. */
  static rejectOption(interaction: AcpInteraction): string | null {
    for (const option of interaction.options) {
      const kind = String(option.kind ?? "").toLowerCase();
      const name = String(option.name ?? "").toLowerCase();
      const optionId = option.optionId;
      if (
        typeof optionId === "string" &&
        (kind.startsWith("reject") || name.includes("deny") || optionId.toLowerCase().includes("reject"))
      ) {
        return optionId;
      }
    }
    return null;
  }

  /** Terminate the harness, fail outstanding requests, and release listeners. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.running && this.sessionId) {
      await this.cancelTurn().catch(() => undefined);
    }
    await this.terminate();
    this.failPending(new AcpError("harness ACP client closed"));
    this.pending.clear();
    this.turn = null;
    this.pendingInteraction = null;
    this.drainInteractions();
    this.emit("closed");
  }

  async request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new AcpError(String(error)));
      });
    });
    if (method === "session/set_config_option") {
      // Option setters also return refreshed model-specific options. Cache them even
      // when called by an adapter directly (e.g. reasoning effort after selection).
      this.updateConfigOptions(response);
      const result = isRecord(response.result) ? response.result : null;
      const returnedEffort = Array.isArray(result?.configOptions)
        ? result.configOptions.filter(isRecord).find(option => option.id === "reasoning_effort" || option.configId === "reasoning_effort")
        : undefined;
      if (params.configId === "reasoning_effort" && typeof params.value === "string" && typeof returnedEffort?.currentValue !== "string") {
        // Legacy acknowledgements lack readback. Retain the accepted command for
        // compatibility, but never overwrite an actual (possibly contradictory) value.
        this.observedReasoningEffort = params.value;
      }
    } else if (method === "session/set_model" && typeof params.modelId === "string") {
      this.observedReasoningEffort = params.modelId.match(/\[([^\]]+)\]$/)?.[1] ?? this.observedReasoningEffort;
    }
    return response;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  // --- internals -----------------------------------------------------------

  private send(message: JsonRpcMessage): Promise<void> {
    if (this.broken) {
      return Promise.reject(new AcpError("harness ACP transport was closed after an output error"));
    }
    const stream = this.child?.stdin;
    if (!stream || stream.destroyed || this.child?.exitCode !== null) {
      return Promise.reject(new AcpError(this.exitMessage("harness ACP stdin closed")));
    }
    this.record("client", message);
    const payload = `${JSON.stringify(message)}\n`;
    return new Promise<void>((resolve, reject) => {
      stream.write(payload, (error) => {
        if (error) reject(new AcpError(this.exitMessage(`harness ACP stdin write failed: ${errorMessage(error)}`)));
        else resolve();
      });
    });
  }

  private record(stream: RawStream, value: unknown): void {
    try {
      this.recorder?.appendRaw(stream, value);
    } catch (error) {
      this.logger.warn?.(`could not append to session raw stream: ${errorMessage(error)}`);
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.broken) return;
    const reader = this.stdoutReader;
    if (!reader) return;
    for (const event of reader.push(chunk)) {
      if (this.broken) return;
      if (event.kind === "discardLimit") {
        this.fatal(new AcpDiscardLimitExceeded(this.exitMessage("harness ACP stdout exceeded the bounded discard budget")));
        return;
      }
      if (event.kind === "overflow") {
        // A single oversized line is no longer dropped-and-continued: the framing of the
        // stream cannot be trusted, so the current message is failed and the transport closed.
        this.fatal(new AcpLineTooLarge(this.maxReadBytes));
        return;
      }
      const line = event.line;
      if (line.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        const preview = redactSensitive(line.subarray(0, 200).toString("utf8"));
        this.fatal(new AcpOutputError("invalid_json", `invalid ACP JSON: ${JSON.stringify(preview)}`));
        return;
      }
      this.record("stdout", message);
      if (!this.dispatch(message)) {
        const preview = redactSensitive(JSON.stringify(message)?.slice(0, 200) ?? String(message));
        this.fatal(
          new AcpOutputError("malformed_message", `unrecognized ACP JSON-RPC message: ${preview}`),
        );
        return;
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    if (this.broken) return;
    const reader = this.stderrReader;
    if (!reader) return;
    for (const event of reader.push(chunk)) {
      if (event.kind === "discardLimit") {
        this.fatal(new AcpDiscardLimitExceeded(this.exitMessage("harness ACP stderr exceeded the discard budget")));
        return;
      }
      if (event.kind === "overflow") {
        this.consecutiveOversizedStderr += 1;
        if (this.checkOversizedFlood("stderr", this.consecutiveOversizedStderr)) return;
        this.pushStderrTail("[discarded stderr line exceeding configured read limit]");
        this.record("stderr", { error: "Stderr line exceeded the configured read limit." });
        continue;
      }
      this.consecutiveOversizedStderr = 0;
      const line = event.line.toString("utf8").trimEnd();
      if (line.length === 0) continue;
      // The stderr tail can be surfaced to callers, so it is redacted before retention.
      const safe = redactSensitive(line);
      this.pushStderrTail(typeof safe === "string" ? safe : JSON.stringify(safe));
      this.record("stderr", safe);
      this.emit("stderr", safe);
    }
  }

  private checkOversizedFlood(stream: string, count: number): boolean {
    if (count > MAX_CONSECUTIVE_OVERSIZED_LINES) {
      this.fatal(
        new AcpDiscardLimitExceeded(
          `harness produced more than ${MAX_CONSECUTIVE_OVERSIZED_LINES} consecutive ACP ${stream} ` +
            "lines exceeding max_read_bytes; the transport was closed to bound discard work",
        ),
      );
      return true;
    }
    return false;
  }

  /**
   * Route one decoded JSON-RPC message.
   *
   * Returns `false` when the frame is not a recognized response, request, session update,
   * or supported vendor notification. Unknown/malformed frames still fail closed.
   */
  private dispatch(message: unknown): boolean {
    if (!isRecord(message)) return false;
    const id = message.id;
    const hasId = typeof id === "number" || typeof id === "string";
    if (hasId && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id as number);
      // A response to an id we never sent is a residual/unrelated frame; failing it is safer
      // than letting it be silently mistaken for part of the current turn.
      if (!pending) return false;
      this.pending.delete(id as number);
      if ("error" in message) pending.reject(new AcpRpcError(message.error));
      else pending.resolve(message);
      return true;
    }
    const method = message.method;
    if (hasId && typeof method === "string") {
      this.handleIncomingRequest(id as number | string, method, isRecord(message.params) ? message.params : {});
      return true;
    }
    // Real Codex/CodeBuddy versions emit these out-of-band notifications during
    // initialize/authenticate or a turn. They are advisory, not RPC responses, proof of
    // login, or turn events; status probing and session opening must still complete
    // normally. The raw recorder already retains a redacted copy (including the login URL)
    // for callers to inspect.
    if (
      method === "_auth/status_update" ||
      method === "_codebuddy.ai/authUrl" ||
      method === "_codebuddy.ai/command" ||
      method === "_codebuddy.ai/checkpoint"
    ) {
      if (message.jsonrpc !== "2.0" || "id" in message || !isRecord(message.params)) return false;
      const params = message.params;
      if (method === "_auth/status_update") {
        if (!isRecord(params.authStatus) || typeof params.authStatus.kind !== "string") return false;
      } else if (method === "_codebuddy.ai/authUrl") {
        if (typeof params.authUrl !== "string") return false;
      } else if (method === "_codebuddy.ai/command") {
        if (typeof params.sessionId !== "string" || typeof params.action !== "string" || !isRecord(params.params)) {
          return false;
        }
      } else if (!AcpClient.isCheckpointNotification(params)) {
        return false;
      }
      // `command` describes CodeBuddy UI state (e.g. workspace_info) and `checkpoint`
      // describes file-checkpoint activity. Both are advisory observations only: never
      // interpret an action as a command to execute, a permission approval, a rollback,
      // or a turn-completion signal.
      this.emit(
        method === "_codebuddy.ai/command" || method === "_codebuddy.ai/checkpoint"
          ? "vendorNotification"
          : "authNotification",
        redactSensitive({ method, params }),
      );
      return true;
    }
    if (method === "session/update") {
      const update = isRecord(message.params) ? message.params.update : undefined;
      if (!isRecord(update)) return false;
      this.recordUpdate(update);
      this.emit("sessionUpdate", update);
      return true;
    }
    return false;
  }

  /**
   * Minimal structural validation for a CodeBuddy `_codebuddy.ai/checkpoint` broadcast.
   *
   * CodeBuddy emits this when it creates/updates/reverts a file checkpoint; the shape is
   * `{ sessionId, event, checkpoint: { id, createdAt, fileChanges: { files, totalAdditions,
   * totalDeletions } } }` (see its `CheckpointBroadcastInfo`). The bridge only observes the
   * notification — it never replays, rolls back, or executes anything from it — so only the
   * required fields are type-checked. Required numbers must be finite (a JSON frame can carry
   * `1e999`, which parses to `Infinity` and is not a valid timestamp/count). Optional per-file
   * detail (`diff`, `additions`, ...) and optional `label`/`revertedAt` are retained as-is by
   * the raw recorder, not interpreted.
   */
  private static isCheckpointNotification(params: Record<string, unknown>): boolean {
    const { sessionId, event, checkpoint } = params;
    if (typeof sessionId !== "string" || typeof event !== "string" || !isRecord(checkpoint)) return false;
    if (typeof checkpoint.id !== "string" || !isFiniteNumber(checkpoint.createdAt)) return false;
    const fileChanges = checkpoint.fileChanges;
    if (!isRecord(fileChanges)) return false;
    if (
      !Array.isArray(fileChanges.files) ||
      !isFiniteNumber(fileChanges.totalAdditions) ||
      !isFiniteNumber(fileChanges.totalDeletions)
    ) {
      return false;
    }
    return fileChanges.files.every(
      (file) => isRecord(file) && typeof file.uri === "string" && typeof file.changeType === "string",
    );
  }

  private handleIncomingRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") {
      this.enqueueInteraction(this.parsePermission(id, params));
      return;
    }
    if (method === "elicitation/create") {
      // Stabilized ACP requires an explicit `mode`; this client only advertises form support,
      // so any other explicit mode is answered with -32602 (Invalid params) rather than being
      // mis-rendered. An omitted mode is accepted as the MCP-style form default for backward
      // compatibility with harnesses that predate the explicit-mode requirement.
      const mode = params.mode;
      if (mode !== undefined && mode !== null && mode !== "form") {
        void this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `unsupported elicitation mode: ${JSON.stringify(mode)}` },
        }).catch(() => undefined);
        return;
      }
      this.enqueueInteraction(this.parseInformation(id, method, params));
      return;
    }
    if (
      method === "session/request_input" ||
      method === "session/request_information" ||
      method === "session/request_user_input"
    ) {
      this.enqueueInteraction(this.parseInformation(id, method, params));
      return;
    }
    void this.send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported ACP client method: ${method}` },
    }).catch(() => undefined);
  }

  private parsePermission(id: number | string, params: Record<string, unknown>): AcpInteraction {
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const toolMeta = isRecord(toolCall._meta) ? toolCall._meta : {};
    const title = toolMeta["codebuddy.ai/toolName"] ?? toolCall.title ?? "Permission";
    const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
    return {
      rpcId: id,
      requestId: String(meta["codebuddy.ai/requestId"] ?? id),
      permission: true,
      sessionId: String(params.sessionId ?? this.sessionId ?? ""),
      title: String(title),
      message: String(params.message ?? `Permission requested for ${String(title)}`),
      options: Array.isArray(params.options) ? params.options.filter(isRecord) : [],
      schema: null,
      defaults: null,
      responseStyle: "content",
      rawInput,
      meta: { ...toolMeta, ...meta },
    };
  }

  private parseInformation(id: number | string, method: string, params: Record<string, unknown>): AcpInteraction {
    const schema = params.requestedSchema ?? params.schema;
    return {
      rpcId: id,
      requestId: String(params.requestId ?? id),
      permission: false,
      sessionId: String(params.sessionId ?? this.sessionId ?? ""),
      title: String(params.title ?? "Information requested"),
      message: String(params.message ?? params.prompt ?? "Provide information"),
      options: [],
      schema: isRecord(schema) ? schema : { type: "object" },
      defaults: isRecord(params.defaults) ? params.defaults : null,
      responseStyle: method === "elicitation/create" ? "elicitation" : "content",
      rawInput: {},
      meta: isRecord(params._meta) ? params._meta : {},
    };
  }

  private recordUpdate(update: unknown): void {
    if (!isRecord(update)) return;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const content = update.content;
      if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        this.preview.append(content.text);
      }
      return;
    }
    if (kind === "model_update" || kind === "config_option_update") {
      this.updateModelInfo({ result: { models: update } });
      this.updateConfigOptions({ result: update });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const callId = update.toolCallId;
      if (typeof callId !== "string") return;
      const summary = this.toolCalls.get(callId) ?? { tool_call_id: callId };
      for (const [source, target] of [
        ["title", "title"],
        ["status", "status"],
        ["rawInput", "raw_input"],
      ] as const) {
        if (source in update) summary[target] = update[source];
      }
      this.toolCalls.set(callId, summary);
    }
  }

  private updateConfigOptions(response: JsonRpcMessage): void {
    const result = isRecord(response.result) ? response.result : null;
    if (result && Array.isArray(result.configOptions)) {
      this.sessionConfigOptions = result.configOptions.filter(isRecord);
      const effort = this.sessionConfigOptions.find((option) => option.id === "reasoning_effort" || option.configId === "reasoning_effort");
      if (typeof effort?.currentValue === "string") this.observedReasoningEffort = effort.currentValue;
    }
  }

  private updateModelInfo(response: JsonRpcMessage): void {
    const result = isRecord(response.result) ? response.result : null;
    if (!result) return;
    const models = isRecord(result.models) ? result.models : result;
    const current = models.currentModelId ?? models.current_model_id ?? models.modelId ?? models.model;
    const currentId = isRecord(current) ? current.modelId ?? current.id : current;
    if (typeof currentId === "string" && currentId) {
      this.modelId = currentId;
      this.observedReasoningEffort = currentId.match(/\[([^\]]+)\]$/)?.[1] ?? this.observedReasoningEffort;
    }

    const available = models.availableModels;
    if (Array.isArray(available)) {
      const discovered: AcpModel[] = [];
      for (const item of available) {
        if (!isRecord(item)) continue;
        const id = item.modelId ?? item.id;
        const name = item.name ?? item.displayName;
        if (typeof id === "string" && id) {
          const label = typeof name === "string" ? name : id;
          this.modelNames.set(id, label);
          discovered.push({ id, name: label });
        }
      }
      if (discovered.length > 0) this.availableModels = discovered;
    }
    if (this.modelId) this.modelName = this.modelNames.get(this.modelId) ?? this.modelId;
  }

  private turnResult(message: JsonRpcMessage): AcpTurnResult {
    const result = isRecord(message.result) ? message.result : {};
    const stopReason = typeof result.stopReason === "string" ? result.stopReason : null;
    return {
      status: stopReason === "cancelled" ? "cancelled" : "completed",
      text: this.preview.text(),
      stopReason,
      toolCalls: this.toolCallSummaries(),
      harnessSessionId: this.sessionId,
    };
  }

  private takeInteraction(): { promise: Promise<AcpInteraction>; cancel: () => void } {
    if (this.interactionQueue.length > 0) {
      const interaction = this.interactionQueue.shift() as AcpInteraction;
      return { promise: Promise.resolve(interaction), cancel: () => undefined };
    }
    let waiter!: InteractionWaiter;
    const promise = new Promise<AcpInteraction>((resolve, reject) => {
      waiter = { resolve, reject };
      this.interactionWaiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        const index = this.interactionWaiters.indexOf(waiter);
        if (index >= 0) this.interactionWaiters.splice(index, 1);
      },
    };
  }

  private enqueueInteraction(interaction: AcpInteraction): void {
    const waiter = this.interactionWaiters.shift();
    if (waiter) waiter.resolve(interaction);
    else this.interactionQueue.push(interaction);
  }

  private drainInteractions(): void {
    this.interactionQueue.length = 0;
    const waiters = this.interactionWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(new AcpError("interaction queue was drained"));
  }

  private failPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  /**
   * Fail every outstanding request and close the transport.
   *
   * Used for output/protocol failures that must not continue: the pending turn is rejected (so
   * the session marks the message `failed`), any queued interaction waiters are rejected (so a
   * `waiting_input` turn does not hang), and further stdout is ignored.
   */
  private fatal(error: Error): void {
    if (this.broken) return;
    this.broken = true;
    this.logger.error?.(error.message);
    // Rejecting the outstanding requests makes `waitForTurnEvent` fail with `error`, so the
    // session records the real classification. A turn that is `waiting_input` is woken by the
    // session via the transport `exit`/`closed` events, so no interaction drain is needed here.
    this.failPending(error);
    void this.terminate();
  }

  private onProcessError(error: Error): void {
    if (this.closed) return;
    this.failPending(new AcpError(this.exitMessage(`harness process error: ${errorMessage(error)}`)));
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("exit", code, signal);
    if (this.closed) return;
    this.failPending(new AcpError(this.exitMessage(`harness ACP process exited (code=${code}, signal=${signal})`)));
  }

  private pushStderrTail(line: string): void {
    this.stderrTail.push(line);
    while (this.stderrTail.length > this.stderrTailLines) this.stderrTail.shift();
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (process.platform !== "win32" && typeof pid === "number") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall through to a direct child kill when the process group is gone.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    // Closing stdin is the graceful close signal: a supervisor child terminates the harness
    // process group and releases container/remote resources before exiting, which can take
    // longer than a plain terminate grace.
    if (await waitFor(exited, this.supervisorShutdownMs)) return;
    this.signalChild(child, "SIGTERM");
    if (await waitFor(exited, this.terminateGraceMs)) return;
    this.signalChild(child, "SIGKILL");
    await waitFor(exited, KILL_GRACE_MS);
  }

  private exitMessage(prefix: string): string {
    const code = this.child?.exitCode;
    let detail = `${prefix} (exit code: ${code ?? "none"})`;
    if (this.stderrTail.length > 0) detail += `\nstderr tail:\n${this.stderrTailText}`;
    return detail;
  }
}
