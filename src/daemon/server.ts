/**
 * Bridge daemon: a Unix-socket server that owns the session registry and every call the
 * MCP stdio client exposes.
 *
 * Only one daemon runs per socket: a PID lock file guards startup (with stale-lock
 * takeover) and the socket bind itself is the final guarantee. The socket lives in a 0700
 * directory with mode 0600, so the daemon is reachable only by the owning user, and it
 * rejects launch internals (command, args, env, ssh/docker options, base directories) from
 * callers so a client can never redirect where a harness runs or write.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import { AuthCoordinator, AuthLedger } from "../auth.js";
import { acpErrorCode } from "../acp.js";
import { resolveHarness, type BridgeConfig } from "../config.js";
import {
  isValidSessionId,
  idempotencyKeyHash,
  idempotencyRequestHash,
  newSessionId,
  removeSession,
} from "../persistence.js";
import { PersistedSession } from "../recovery.js";
import {
  assertAllowedKeys,
  normalizeCreateParams,
  ParamError,
} from "../create-params.js";
import {
  BridgeSession,
  normalizeIdempotencyKey,
  normalizeMessageMode,
  resolveIdempotentReplay,
  type InteractionAnswer,
  type PermissionMode,
} from "../session.js";
import { MAX_IPC_LINE_BYTES } from "../ipc.js";

export class DaemonError extends Error {
  override name = "DaemonError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DispatchContext {
  signal?: AbortSignal;
}

export interface HarnessDaemonOptions {
  config: BridgeConfig;
  configPath?: string | null;
  socketPath?: string;
  lockPath?: string;
}

interface SessionEntry {
  session: BridgeSession;
  lastActivity: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new DaemonError("invalid_param", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new DaemonError("invalid_param", `${name} must be a non-empty string`);
  }
  return value.trim();
}

const INTERACTION_ANSWERS: readonly InteractionAnswer[] = ["accept", "reject", "timeout", "cancel"];

/** Validate the optional `answer` kind; defaults to `"accept"`. */
function optionalInteractionAnswer(params: Record<string, unknown>): InteractionAnswer {
  const value = params.answer;
  if (value === undefined || value === null) return "accept";
  if (typeof value !== "string" || !(INTERACTION_ANSWERS as readonly string[]).includes(value)) {
    throw new DaemonError("invalid_param", "answer must be one of accept, reject, timeout, cancel");
  }
  return value as InteractionAnswer;
}

export class HarnessDaemon {
  readonly config: BridgeConfig;
  readonly configPath: string | null;
  readonly socketPath: string;
  readonly lockPath: string;

  private readonly sessions = new Map<string, SessionEntry>();
  /** Read-only views of persisted sessions, used after close/restart. */
  private readonly persisted = new Map<string, PersistedSession>();
  private readonly authCoordinator: AuthCoordinator;
  private server: Server | null = null;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();
  private stopping = false;

  constructor(options: HarnessDaemonOptions) {
    this.config = options.config;
    this.configPath = options.configPath ?? null;
    this.socketPath = options.socketPath ?? options.config.server.socketPath;
    this.lockPath = options.lockPath ?? options.config.server.lockPath;
    const authentication = options.config.authentication;
    this.authCoordinator = new AuthCoordinator({
      ledger: new AuthLedger({
        path: authentication.ledgerPath,
        rateLimit: authentication.rateLimit,
      }),
      maxConcurrentTargets: authentication.maxConcurrentTargets,
      timeoutSeconds: authentication.timeoutSeconds,
      // A timed-out authentication closes and cleans up its session.
      closeSession: (sessionId) => this.closeSessionInternal(sessionId),
    });
  }

  async start(): Promise<void> {
    this.acquireLock();
    const directory = dirname(this.socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best effort; the process umask may already be restrictive.
    }
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // A live daemon would have failed the lock above; ignore races here.
      }
    }
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolvePromise());
    });
    try {
      chmodSync(this.socketPath, 0o600);
    } catch {
      // Non-POSIX platforms ignore the mode.
    }
    this.startReaper();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    await this.closeAll();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    for (const path of [this.socketPath, this.lockPath]) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }

  /** Per-request context; `signal` aborts a long-poll when the caller disconnects. */
  async dispatch(
    method: string,
    params: Record<string, unknown>,
    context: DispatchContext = {},
  ): Promise<Record<string, unknown>> {
    if (!isRecord(params)) throw new DaemonError("invalid_param", "params must be an object");
    const handlers: Record<
      string,
      (p: Record<string, unknown>, ctx: DispatchContext) => Promise<Record<string, unknown>>
    > = {
      ping: (p) => this.ping(p),
      list_sessions: (p) => this.listSessions(p),
      create_session: (p) => this.createSession(p),
      authenticate: (p) => this.authenticate(p),
      auth_info: (p) => this.authInfo(p),
      set_model: (p) => this.setModel(p),
      send_message: (p) => this.sendMessage(p),
      message_result: (p) => this.messageResult(p),
      answer_question: (p) => this.answerQuestion(p),
      cancel_message: (p) => this.cancelMessage(p),
      live_output: (p, ctx) => this.liveOutput(p, ctx),
      close_session: (p) => this.closeSession(p),
      shutdown: (p) => this.shutdown(p),
    };
    const handler = handlers[method];
    if (!handler) throw new DaemonError("unsupported_method", `unsupported daemon method: ${method}`);
    return handler(params, context);
  }

  // --- handlers ------------------------------------------------------------

  private async ping(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, []);
    return {
      status: "ok",
      pid: process.pid,
      protocol_version: 1,
      config_fingerprint: this.config.fingerprint,
      config_path: this.configPath,
      socket_path: this.socketPath,
      started_at: new Date(this.startedAt).toISOString(),
      uptime_seconds: (Date.now() - this.startedAt) / 1000,
      sessions: this.sessions.size,
      session_dir: this.config.paths.sessionDir,
    };
  }

  private async listSessions(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, []);
    return {
      status: "ok",
      sessions: [...this.sessions.values()].map((entry) => ({
        session_id: entry.session.sessionId,
        state: entry.session.state,
        harness: entry.session.harness.name,
        model_id: entry.session.modelId,
        idle: entry.session.isIdle(),
        last_activity: new Date(entry.lastActivity).toISOString(),
      })),
    };
  }

  private async createSession(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Full reference validation: launch internals are rejected, docker options are checked,
    // and mutually exclusive combinations (direct + docker options, reuse + new-container
    // options, host_network + published ports) fail before anything is started.
    const normalized = normalizeCreateParams(params);
    const harness = resolveHarness(this.config, normalized.harness);
    const sessionId = normalized.sessionId ?? newSessionId();
    if (!isValidSessionId(sessionId)) {
      throw new DaemonError("invalid_session_id", `invalid session_id: ${sessionId}`);
    }
    const sessionRoot = this.config.paths.sessionDir;
    const target = join(sessionRoot, sessionId);
    if (this.sessions.size >= this.config.sessions.maxConcurrency) {
      throw new DaemonError(
        "max_sessions",
        `session limit reached (${this.config.sessions.maxConcurrency}); close a session first`,
      );
    }
    // Claim the session directory exclusively and synchronously, before the first `await`.
    // A check-then-create would race: two concurrent create_session calls with the same
    // session id could both observe the path absent. `mkdir` without `recursive` fails with
    // EEXIST for any existing entry (directory, file, or symlink), so exactly one call can
    // own the path and a second one can neither reuse nor delete the first's directory. The
    // parent is created first (idempotent) so the exclusive create cannot fail for a missing
    // root.
    mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DaemonError(
          "session_exists",
          `refusing to reuse an existing session path: ${sessionId}`,
        );
      }
      throw error;
    }
    let session: BridgeSession;
    try {
      session = await BridgeSession.create({
        config: this.config,
        harness,
        cwd: normalized.cwd,
        modelId: normalized.modelId,
        thinkingLevel: normalized.thinkingLevel,
        permissionMode: normalized.permissionMode,
        target: normalized.target,
        remoteHost: normalized.remoteHost,
        runtime: normalized.runtime,
        dockerId: normalized.dockerId,
        dockerImage: normalized.dockerImage,
        dockerMounts: normalized.dockerMounts,
        dockerPorts: normalized.dockerPorts,
        dockerHostNetwork: normalized.dockerHostNetwork,
        containerPolicy: normalized.containerPolicy,
        resumeSessionId: normalized.resumeSessionId,
        authenticate: normalized.authenticate ?? undefined,
        sessionId,
      });
    } catch (error) {
      // Only this call could have claimed the path, so the directory holds nothing but what
      // this call created; removing it cannot touch a concurrent session.
      await removeSession(sessionRoot, sessionId).catch(() => undefined);
      throw error;
    }
    // A kept container hands its real id back so the caller can `reuse` it later; a removed
    // container reports none. Resolve it before registering: a kept container whose id cannot
    // be verified must fail the create rather than leave a live session and a bogus handle.
    let keptContainerId: string | null;
    try {
      keptContainerId = session.keptContainerId();
    } catch (error) {
      await session.close().catch(() => undefined);
      await removeSession(sessionRoot, sessionId).catch(() => undefined);
      throw error;
    }
    this.sessions.set(session.sessionId, { session, lastActivity: Date.now() });
    const result: Record<string, unknown> = {
      status: session.state,
      ...session.status(),
      launch_info: session.launchInfo(),
    };
    if (keptContainerId !== null) result.docker_id = keptContainerId;
    if (normalized.authenticate) {
      // The convenience `authenticate` parameter goes through the same coordinator as the
      // `authenticate` tool, so it cannot bypass the ledger, same-target serialization,
      // concurrency bound, or timeout.
      const auth = await this.authCoordinator.authenticate(session, normalized.authenticate);
      return { ...result, ...auth, state: session.state, launch_info: session.launchInfo() };
    }
    return result;
  }

  private async authenticate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "method_id"]);
    const session = this.requireSession(params);
    const methodId = requiredString(params, "method_id");
    // Rate limiting, same-target serialization, the cross-target concurrency bound, and the
    // authentication timeout are all owned by the coordinator.
    return await this.authCoordinator.authenticate(session, methodId);
  }

  private async authInfo(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id"]);
    const session = this.requireSession(params);
    // Show the latest whitelisted account; a probe failure (or a harness without a status
    // endpoint) keeps the last known state instead of failing the call.
    await session.refreshAuthInfo().catch(() => undefined);
    return { status: "ok", session_id: session.sessionId, ...session.authInfo() };
  }

  private async setModel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "model_id", "thinking_level"]);
    const session = this.requireSession(params);
    const modelId = requiredString(params, "model_id");
    // Optional: omit it and only the model changes, exactly as before.
    const thinkingLevel = optionalString(params, "thinking_level");
    const status = await session.setModel(modelId, thinkingLevel);
    return {
      status: "model_set",
      session_id: session.sessionId,
      model_id: status.model_id,
      model_name: status.model_name,
      ...(thinkingLevel !== null ? { thinking_level: thinkingLevel } : {}),
    };
  }

  /** Asynchronous submit: only the message id comes back; the caller polls. */
  private async sendMessage(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "text", "mode", "idempotency_key"]);
    const sessionId = requiredString(params, "session_id");
    const text = requiredString(params, "text");
    const mode = normalizeMessageMode(params.mode);
    const idempotencyKey = normalizeIdempotencyKey(params.idempotency_key);
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastActivity = Date.now();
      const result = entry.session.sendMessage(text, { mode, idempotencyKey: idempotencyKey ?? undefined });
      return { message_id: result.message_id };
    }
    // A closed or restarted (persisted) session cannot accept a new message, but a repeated
    // idempotency key still resolves to its original message, so a retried submit is safe.
    if (idempotencyKey !== null) {
      const view = this.persistedSession(sessionId);
      if (view) {
        const existing = view.idempotencyEntry(idempotencyKeyHash(idempotencyKey));
        const replay = resolveIdempotentReplay(existing, idempotencyRequestHash(mode, text));
        if (replay) return replay;
      }
    }
    throw new DaemonError("unknown_session", `unknown session: ${sessionId}`);
  }

  /**
   * Message status and result in one call.
   *
   * With `message_id`: the full status, plus `text`/`tool_calls`/`harness_session_id` only once
   * the message is terminal. Without `message_id`: whole-session status. Served read-only from
   * the persisted snapshots after `close_session` and after a restart.
   */
  private async messageResult(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "message_id"]);
    const sessionId = requiredString(params, "session_id");
    const messageId = optionalString(params, "message_id");
    const session = this.sessions.get(sessionId)?.session;
    if (session) {
      this.touch(sessionId);
      if (messageId === null) return { status: "ok", ...session.status() };
      return { status: "ok", session_id: sessionId, ...session.messageResult(messageId) };
    }
    // Read-only recovery path for a closed session or a restarted daemon.
    const view = this.persistedSession(sessionId);
    if (!view) throw new DaemonError("unknown_session", `unknown session: ${sessionId}`);
    if (messageId === null) return { status: "ok", ...view.sessionStatus() };
    const result = view.messageResult(messageId);
    if (!result) throw new DaemonError("unknown_message", `unknown message: ${messageId}`);
    return { status: "ok", session_id: sessionId, ...result };
  }

  private async answerQuestion(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "message_id", "request_id", "response", "answer"]);
    const session = this.requireSession(params);
    const messageId = requiredString(params, "message_id");
    const requestId = requiredString(params, "request_id");
    const answer = optionalInteractionAnswer(params);
    const response = params.response;
    // `reject`/`timeout`/`cancel` carry no payload; only `accept` requires the answer object.
    if (answer === "accept" && !isRecord(response)) {
      throw new DaemonError("invalid_param", "response must be an object for answer=accept");
    }
    const answered = await session.answerQuestion(messageId, requestId, response, { answer });
    return { status: "accepted", session_id: session.sessionId, ...answered };
  }

  private async cancelMessage(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "message_id"]);
    const session = this.requireSession(params);
    const messageId = requiredString(params, "message_id");
    const status = session.cancelMessage(messageId);
    return { status: "ok", session_id: session.sessionId, ...status };
  }

  private async liveOutput(
    params: Record<string, unknown>,
    context: DispatchContext,
  ): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id", "message_id", "offset", "max_bytes", "stop", "wait_ms"]);
    const sessionId = requiredString(params, "session_id");
    const messageId = optionalString(params, "message_id");
    const offset = params.offset;
    if (offset !== undefined && offset !== null && (typeof offset !== "number" || !Number.isFinite(offset))) {
      throw new DaemonError("invalid_param", "offset must be a number");
    }
    const maxBytes = params.max_bytes;
    if (
      maxBytes !== undefined &&
      maxBytes !== null &&
      (typeof maxBytes !== "number" || !Number.isFinite(maxBytes))
    ) {
      throw new DaemonError("invalid_param", "max_bytes must be a number");
    }
    const waitMs = params.wait_ms;
    if (
      waitMs !== undefined &&
      waitMs !== null &&
      (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0)
    ) {
      throw new DaemonError("invalid_param", "wait_ms must be a non-negative number");
    }
    if (params.stop !== undefined && typeof params.stop !== "boolean") {
      throw new DaemonError("invalid_param", "stop must be boolean");
    }
    const options = {
      messageId,
      offset: typeof offset === "number" ? offset : null,
      maxBytes: typeof maxBytes === "number" ? maxBytes : undefined,
      stop: params.stop === true,
      waitMs: typeof waitMs === "number" ? waitMs : 0,
      signal: context.signal,
    };

    const session = this.sessions.get(sessionId)?.session;
    if (session) {
      this.touch(sessionId);
      const output = await session.listenOutput(options);
      return { status: "ok", ...output };
    }
    const view = this.persistedSession(sessionId);
    if (!view) throw new DaemonError("unknown_session", `unknown session: ${sessionId}`);
    try {
      const output = await view.listenOutput(options);
      return { status: "ok", ...output };
    } catch (error) {
      throw new DaemonError("unknown_message", error instanceof Error ? error.message : String(error));
    }
  }

  private async closeSession(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, ["session_id"]);
    const sessionId = requiredString(params, "session_id");
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new DaemonError("unknown_session", `unknown session: ${sessionId}`);
    await this.closeSessionInternal(sessionId);
    return { status: "closed", session_id: sessionId, session_dir: entry.session.directory };
  }

  /**
   * Unregister and close a session, exactly once.
   *
   * Shared by `close_session` and the authentication-timeout path; the session's own
   * `close()` is idempotent, so a race between the two cannot double-clean the runtime.
   */
  private async closeSessionInternal(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.persisted.delete(sessionId);
    if (entry) await entry.session.close().catch(() => undefined);
  }

  private async shutdown(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertAllowedKeys(params, []);
    // Let the response flush before tearing the socket down.
    setTimeout(() => {
      void this.stop().finally(() => process.exit(0));
    }, 25);
    return { status: "stopping", pid: process.pid };
  }

  // --- connection handling -------------------------------------------------

  private handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    // A disconnect must abort a long-polling handler instead of leaving it waiting.
    const controller = new AbortController();
    socket.on("close", () => controller.abort());
    socket.on("error", () => controller.abort());
    const fail = (code: string, message: string): void => {
      handled = true;
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message, data: { code } } })}\n`);
    };
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_IPC_LINE_BYTES) {
        fail("request_too_large", "daemon request exceeded the size limit");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void this.respond(socket, buffer.slice(0, newline), { signal: controller.signal });
    });
  }

  private async respond(
    socket: Socket,
    line: string,
    context: DispatchContext,
  ): Promise<void> {
    let id: unknown = null;
    let response: Record<string, unknown>;
    try {
      const request: unknown = JSON.parse(line);
      if (!isRecord(request) || typeof request.method !== "string") {
        throw new DaemonError("invalid_request", "invalid daemon request");
      }
      id = request.id ?? null;
      const params = isRecord(request.params) ? request.params : {};
      const result = await this.dispatch(request.method, params, context);
      response = { jsonrpc: "2.0", id, result };
    } catch (error) {
      const code = errorCode(error);
      response = {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof DaemonError ? -32602 : -32000,
          message: errorMessage(error),
          data: { code, type: error instanceof Error ? error.name : "Error" },
        },
      };
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }

  private requireSession(params: Record<string, unknown>): BridgeSession {
    const sessionId = requiredString(params, "session_id");
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new DaemonError("unknown_session", `unknown session: ${sessionId}`);
    entry.lastActivity = Date.now();
    return entry.session;
  }

  private touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastActivity = Date.now();
  }

  /**
   * Open (and cache) a read-only view of a persisted session.
   *
   * Only ids that resolve to a real, non-symlinked directory directly under the configured
   * session root are accepted; opening also reconciles messages left in flight by a
   * previous daemon run so they can never stay non-terminal.
   */
  private persistedSession(sessionId: string): PersistedSession | null {
    const cached = this.persisted.get(sessionId);
    if (cached) return cached;
    const view = PersistedSession.open(this.config.paths.sessionDir, sessionId);
    if (!view) return null;
    this.persisted.set(sessionId, view);
    return view;
  }

  // --- lifecycle -----------------------------------------------------------

  private acquireLock(): void {
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      const descriptor = openSync(this.lockPath, "wx", 0o600);
      writeSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let existing = Number.NaN;
    try {
      existing = Number.parseInt(readFileSync(this.lockPath, "utf8").trim(), 10);
    } catch {
      existing = Number.NaN;
    }
    if (Number.isInteger(existing) && existing > 0 && isProcessAlive(existing)) {
      throw new DaemonError(
        "daemon_already_running",
        `a harness-acp-bridge daemon is already running (pid ${existing})`,
      );
    }
    writeFileSync(this.lockPath, `${process.pid}\n`, { mode: 0o600 });
  }

  private startReaper(): void {
    const intervalMs = Math.max(1000, this.config.sessions.reapIntervalSeconds * 1000);
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, intervalMs);
    if (typeof this.reaper.unref === "function") this.reaper.unref();
  }

  private async reapIdle(): Promise<void> {
    const timeoutMs = this.config.sessions.idleTimeoutSeconds * 1000;
    if (timeoutMs <= 0) return;
    const now = Date.now();
    for (const [sessionId, entry] of [...this.sessions]) {
      if (now - entry.lastActivity < timeoutMs) continue;
      if (!entry.session.isIdle()) continue;
      // An authentication in flight looks idle (no messages) but must not be reaped.
      if (this.authCoordinator.isAuthenticating(sessionId)) continue;
      await this.closeSessionInternal(sessionId);
    }
  }

  private async closeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) {
      await entry.session.close().catch(() => undefined);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errorCode(error: unknown): string {
  // A transport/output failure carries its classification outside a `.code` field.
  const acp = acpErrorCode(error);
  if (acp !== null) return acp;
  if (error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if (error instanceof Error) return error.name;
  return "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
