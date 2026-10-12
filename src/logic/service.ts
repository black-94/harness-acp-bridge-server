/** Public operations and session registry; HTTP knows nothing about ACP or files. */
import { appendFileSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AuthCoordinator, AuthLedger } from "./auth.js";
import { harnessInfo, type BridgeConfig } from "./config.js";
import { assertAllowedKeys, normalizeCreateParams } from "./create-params.js";
import { authenticationRequired, BridgeError, isRecord } from "./errors.js";
import { isValidSessionId, newSessionId, QUEUE_FILE, RAW_FILE, readJsonFileSafe, RESULTS_DIR, SESSION_FILE, sessionDirectory, writeJsonAtomicSync } from "../io/persistence.js";
import { Redactor, collectSecrets } from "../redact/redact.js";
import { HarnessSession } from "./session.js";

export const METHODS = ["ping", "search_harness", "create_session", "close_session", "authenticate", "auth_status", "set_session_options", "send_message", "cancel_message", "message_status", "answer_question"] as const;
/** Bumped when the public HTTP contract changes incompatibly (interactive auth, no live_output). */
export const PROTOCOL_VERSION = 3;
export interface RequestContext { signal?: AbortSignal }
function string(params: Record<string, unknown>, key: string, optional = false, opaque = false): string | null {
  const value = params[key];
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !value.trim()) throw new BridgeError("invalid_param", `${key} must be a non-empty string`);
  return opaque ? value : value.trim();
}
export class HarnessService {
  readonly sessions = new Map<string, HarnessSession>();
  private readonly auth: AuthCoordinator;
  private readonly redactor: Redactor;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private readonly startedAt = Date.now();
  private lockToken: string | null = null;
  constructor(readonly config: BridgeConfig) {
    this.redactor = new Redactor(collectSecrets(process.env, config.harnesses));
    this.auth = new AuthCoordinator({ ledger: new AuthLedger({ path: config.authentication.ledgerPath, rateLimit: config.authentication.rateLimit }),
      maxConcurrentTargets: config.authentication.maxConcurrentTargets, timeoutSeconds: config.timeouts.authenticationTimeoutSeconds,
      inputTimeoutSeconds: config.timeouts.inputTimeoutSeconds,
      closeSession: async id => { await this.sessions.get(id)?.close(); } });
  }
  start(): void {
    this.acquireLock();
    try { this.recover(); } catch (error) { this.releaseLock(); throw error; }
    this.reaper = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.isClosed) this.sessions.delete(session.sessionId);
        else if (session.isIdle && this.config.sessions.idleTimeoutSeconds && Date.now() - session.lastActivity >= this.config.sessions.idleTimeoutSeconds * 1000) {
          let failure: Error | undefined;
          try { session.store.event("idle_timeout"); }
          catch (error) { failure = new BridgeError("storage_error", `could not journal idle timeout: ${String(error)}`); }
          void session.close(failure).catch(() => undefined);
        }
      }
    }, this.config.sessions.reapIntervalSeconds * 1000);
    this.reaper.unref();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reaper) clearInterval(this.reaper);
    await Promise.allSettled([...this.sessions.values()].map(session => session.close()));
    this.releaseLock();
  }
  private acquireLock(): void {
    mkdirSync(this.config.paths.sessionDir, { recursive: true, mode: 0o700 });
    const path = join(this.config.paths.sessionDir, ".server.lock");
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
        finally { closeSync(fd); }
        this.lockToken = token; return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = readJsonFileSafe(path);
        if (!owner || typeof owner.pid !== "number") throw new BridgeError("state_directory_busy", "state directory lock is incomplete");
        try { process.kill(owner.pid, 0); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(path); continue; }
        }
        throw new BridgeError("state_directory_busy", "another server owns the session directory");
      }
    }
    throw new BridgeError("state_directory_busy", "could not acquire session directory lock");
  }
  private releaseLock(): void {
    if (!this.lockToken) return;
    const path = join(this.config.paths.sessionDir, ".server.lock");
    if (readJsonFileSafe(path)?.token === this.lockToken) unlinkSync(path);
    this.lockToken = null;
  }
  private live(id: string): HarnessSession {
    const session = this.sessions.get(id);
    if (!session) { this.directory(id); throw new BridgeError("session_closed", "session has no live harness"); }
    if (session.isClosed) throw new BridgeError("session_closed", "session has no live harness");
    return session;
  }
  private directory(id: string): string {
    if (!isValidSessionId(id)) throw new BridgeError("invalid_param", "invalid session_id");
    const directory = sessionDirectory(this.config.paths.sessionDir, id);
    try { if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(); }
    catch { throw new BridgeError("session_not_found", "unknown session_id"); }
    return directory;
  }
  async dispatch(method: string, params: Record<string, unknown>, context: RequestContext = {}): Promise<Record<string, unknown>> {
    if (!isRecord(params)) throw new BridgeError("invalid_param", "request body must be a JSON object");
    if (!METHODS.includes(method as typeof METHODS[number])) throw new BridgeError("unsupported_request", `unsupported method: ${method}`);
    if (this.stopping) throw new BridgeError("server_stopping", "server is shutting down");
    switch (method) {
      case "ping":
        assertAllowedKeys(params, []);
        return { status: "ok", protocol_version: PROTOCOL_VERSION, pid: process.pid, started_at: new Date(this.startedAt).toISOString(),
          uptime_seconds: (Date.now() - this.startedAt) / 1000, sessions: [...this.sessions.values()].filter(session => !session.isClosed).length,
          config_fingerprint: this.config.fingerprint };
      case "search_harness":
        assertAllowedKeys(params, ["harness"]);
        return { harnesses: harnessInfo(this.config, string(params, "harness", true)) };
      case "create_session": {
        const options = normalizeCreateParams(params);
        if ([...this.sessions.values()].filter(session => !session.isClosed).length >= this.config.sessions.maxConcurrency) throw new BridgeError("session_limit", "maximum live session count reached");
        const id = options.sessionId ?? newSessionId();
        if (!isValidSessionId(id)) throw new BridgeError("invalid_param", "invalid session_id");
        if (this.sessions.has(id) || existsSync(sessionDirectory(this.config.paths.sessionDir, id))) throw new BridgeError("session_exists", "session_id already exists");
        const session = new HarnessSession(this.config, options, id, this.redactor);
        this.sessions.set(id, session);
        await session.initialize();
        // `create_session.authenticate` no longer exists (it bypassed the flow). An unauthenticated
        // session stays alive and is reported with a structured next_action instead.
        if (!session.isAuthenticated()) throw authenticationRequired(id);
        return session.snapshot();
      }
      case "close_session": {
        assertAllowedKeys(params, ["session_id"]);
        const id = string(params, "session_id")!;
        const directory = this.directory(id);
        // Close always cleans up, even for a session that never authenticated; abandon its flow.
        await this.auth.cancel(id);
        await this.sessions.get(id)?.close();
        return { session_id: id, state: readJsonFileSafe(join(directory, SESSION_FILE))?.state ?? "closed" };
      }
      case "authenticate": {
        assertAllowedKeys(params, ["session_id"]);
        return this.auth.start(this.live(string(params, "session_id")!));
      }
      case "auth_status": {
        assertAllowedKeys(params, ["session_id"]);
        const id = string(params, "session_id")!;
        // A live flow is returned verbatim (read-only, never re-probed) — even after it closed the
        // session on failure, so the client still learns the terminal outcome. With no flow, keep
        // the reliable probe and never guess an unsupported status.
        const flow = this.sessions.get(id) ? this.auth.status(this.sessions.get(id)!) : null;
        if (flow) return flow;
        const session = this.live(id);
        const info = await session.refreshAuthInfo();
        if (!info) throw new BridgeError("unsupported_response", "harness authentication status is unsupported", session.unsupportedAuthInfo());
        return { session_id: id, ...session.authInfo() };
      }
      case "set_session_options": {
        assertAllowedKeys(params, ["session_id", "model_id", "thinking_level", "permission_mode"]);
        const model = string(params, "model_id", true); const level = string(params, "thinking_level", true); const mode = string(params, "permission_mode", true);
        if (mode && !["read", "edit", "auto", "yolo"].includes(mode)) throw new BridgeError("invalid_param", "permission_mode must be read, edit, auto, or yolo");
        if (!model && !level && !mode) throw new BridgeError("invalid_param", "at least one session option is required");
        return this.live(string(params, "session_id")!).setOptions({ ...(model ? { model_id: model } : {}), ...(level ? { thinking_level: level } : {}), ...(mode ? { permission_mode: mode as "read" | "edit" | "auto" | "yolo" } : {}) });
      }
      case "send_message": {
        assertAllowedKeys(params, ["session_id", "text", "idempotency_key"]);
        const key = string(params, "idempotency_key", true);
        if (key && Buffer.byteLength(key) > 256) throw new BridgeError("invalid_param", "idempotency_key exceeds 256 bytes");
        if (typeof params.text !== "string" || !params.text.trim()) throw new BridgeError("invalid_param", "text must be a non-empty string");
        return this.live(string(params, "session_id")!).sendMessage(params.text, key ?? undefined);
      }
      case "message_status": {
        assertAllowedKeys(params, ["session_id", "message_id"]);
        const id = string(params, "session_id")!; const message = string(params, "message_id")!;
        if (!isValidSessionId(message)) throw new BridgeError("invalid_param", "invalid message_id");
        const directory = this.directory(id);
        const session = this.sessions.get(id);
        if (session) return session.messageStatus(message);
        const result = readJsonFileSafe(join(directory, RESULTS_DIR, `${message}.json`));
        if (!result) throw new BridgeError("message_not_found", "unknown message_id");
        return result;
      }
      case "cancel_message":
        assertAllowedKeys(params, ["session_id", "message_id"]);
        return this.live(string(params, "session_id")!).cancelMessage(string(params, "message_id")!);
      case "answer_question": {
        assertAllowedKeys(params, ["session_id", "message_id", "request_id", "answer", "option_id", "content"]);
        const id = string(params, "session_id")!;
        this.live(id);
        const answer = string(params, "answer", true) ?? "accept";
        if (!["accept", "reject", "timeout", "cancel"].includes(answer)) throw new BridgeError("invalid_param", "answer must be accept, reject, timeout, or cancel");
        if (params.content !== undefined && !isRecord(params.content)) throw new BridgeError("invalid_param", "content must be an object");
        const messageId = string(params, "message_id", true);
        const requestId = string(params, "request_id", false, true)!;
        const optionId = string(params, "option_id", true, true);
        const content = (params.content as Record<string, unknown>) ?? null;
        // An omitted message_id scopes the answer to the session's authentication flow.
        if (messageId === null) return this.auth.answer(id, requestId, answer, optionId, content);
        return this.sessions.get(id)!.answerQuestion(messageId, requestId, answer, optionId, content);
      }
    }
    throw new BridgeError("unsupported_request", `unsupported method: ${method}`);
  }
  /** Restart preserves history, but never reattaches to a stale harness/process. */
  private recover(): void {
    if (!existsSync(this.config.paths.sessionDir)) return;
    for (const entry of readdirSync(this.config.paths.sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
      const directory = join(this.config.paths.sessionDir, entry.name);
      const snapshot = readJsonFileSafe(join(directory, SESSION_FILE));
      if (!snapshot) continue;
      const wasLive = !["closed", "failed", "interrupted"].includes(String(snapshot.state));
      const queue = readJsonFileSafe(join(directory, QUEUE_FILE));
      const messages = Array.isArray(queue?.messages) ? queue.messages.filter(isRecord) : [];
      let changed = false;
      for (const message of messages) {
        if (message.terminal || typeof message.message_id !== "string" || !isValidSessionId(message.message_id)) continue;
        changed = true;
        const resultPath = join(directory, RESULTS_DIR, `${message.message_id}.json`);
        const previous = readJsonFileSafe(resultPath);
        if (previous?.terminal) {
          const { result, ...status } = previous; Object.assign(message, status);
        } else {
          Object.assign(message, { state: "failed", terminal: true, questions: [], finished_at: new Date().toISOString(), error: { code: "session_interrupted", message: "server restarted during message processing" }, result: null });
          writeJsonAtomicSync(resultPath, message, this.redactor);
        }
      }
      if (!wasLive && !changed) continue;
      writeJsonAtomicSync(join(directory, QUEUE_FILE), { ...queue, active_message_id: null, messages }, this.redactor);
      writeJsonAtomicSync(join(directory, SESSION_FILE), { ...snapshot, state: wasLive ? "interrupted" : snapshot.state, operation: "closed", updated_at: new Date().toISOString() }, this.redactor);
      const rawPath = join(directory, RAW_FILE);
      if (!existsSync(rawPath) || lstatSync(rawPath).isSymbolicLink()) continue;
      // Recover the sequence using only the tail. Trim a crash's incomplete final append.
      const fd = openSync(rawPath, "r+");
      let seq = 0;
      try {
        let size = lstatSync(rawPath).size;
        const block = Buffer.alloc(64 * 1024);
        let position = size;
        while (position > 0) {
          const count = Math.min(block.length, position);
          readSync(fd, block, 0, count, position - count);
          const newline = block.subarray(0, count).lastIndexOf(10);
          if (newline >= 0) { size = position - count + newline + 1; break; }
          position -= count;
        }
        if (position === 0) size = 0;
        ftruncateSync(fd, size);
        // Locate the last complete record, then read its small sequence prefix.
        position = Math.max(0, size - 1);
        let start = 0;
        while (position > 0) {
          const count = Math.min(block.length, position);
          readSync(fd, block, 0, count, position - count);
          const newline = block.subarray(0, count).lastIndexOf(10);
          if (newline >= 0) { start = position - count + newline + 1; break; }
          position -= count;
        }
        const prefix = Buffer.alloc(Math.min(256, size - start));
        readSync(fd, prefix, 0, prefix.length, start);
        seq = Number(/"seq"\s*:\s*(\d+)/.exec(prefix.toString("utf8"))?.[1] ?? 0);
      } finally { closeSync(fd); }
      appendFileSync(rawPath, `${JSON.stringify({ version: 1, seq: seq + 1, timestamp: new Date().toISOString(), session_id: entry.name, message_id: null, type: "lifecycle", event: "session_interrupted", data: { reason: "server_restart" } })}\n`);
    }
  }
}
