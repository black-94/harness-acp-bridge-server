/**
 * Authentication concurrency, rate limiting, and the persistent per-target attempt ledger.
 *
 * Ports `harness_acp_mcp/auth_store.py` plus the authentication half of
 * `harness_acp_mcp/bridge.py:SessionRegistry`. Four independent bounds apply to every
 * authentication path — including the `create_session` convenience parameter, which routes
 * through this module rather than calling the adapter directly:
 *
 *   - a persistent ledger records one attempt per harness+target, so `min_interval`,
 *     `max_attempts` and `window` survive a daemon restart;
 *   - same-target serialization: at most one in-flight authentication per target key, so
 *     two sessions can never write the same target's credentials at the same time;
 *   - `max_concurrent_targets` bounds how many distinct targets authenticate at once;
 *   - an authentication timeout closes and cleans up the session.
 *
 * The ledger is a private JSON file written atomically (temp file + rename, mode 0600).
 * A single-writer daemon needs no database dependency for this. It stores only SHA-256
 * hashes of the target identity and timestamps — never the harness name, ssh host, or any
 * credential — so a leaked ledger reveals nothing about the account.
 */
import { createHash, randomUUID } from "node:crypto";

import { BridgeError, errorInfo } from "./errors.js";
import { readJsonFileSafe, writeAtomicFileSync } from "./persistence.js";
import { validateObjectSchema } from "./adapter/protocol.js";

export interface RateLimitSettings {
  enabled: boolean;
  minIntervalSeconds: number;
  maxAttempts: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
  windowResetsAt: number | null;
}

export const LEDGER_VERSION = 1;

/**
 * Opaque ledger key for one authentication target.
 *
 * Port of `AuthRateStore.target_key`: the identity is `harness \0 launch mode \0 target`,
 * where the target is `local` or the lower-cased ssh host, then SHA-256 hashed. Hashing
 * keeps the harness name and ssh host out of the ledger file.
 */
export function authTargetKey(
  harness: string,
  launchMode: string,
  sshHost: string | null | undefined,
): string {
  const target = launchMode === "local" ? "local" : (sshHost ?? "").trim().toLowerCase();
  return createHash("sha256").update(`${harness}\0${launchMode}\0${target}`, "utf8").digest("hex");
}

export interface AuthLedgerOptions {
  path: string;
  rateLimit: RateLimitSettings;
  /** Injectable clock (seconds since epoch) for deterministic tests. */
  now?: () => number;
}

interface LedgerFile {
  version: number;
  /** target key -> attempt timestamps in seconds since epoch. */
  attempts: Record<string, number[]>;
}

/**
 * Persistent, atomic per-target attempt ledger.
 *
 * Every mutation is a synchronous read-modify-write of an in-memory map followed by an
 * atomic file write, and mutations are serialized through a promise chain so concurrent
 * callers can never interleave and lose an attempt. When the rate limit is disabled the
 * store is a no-op that never touches disk.
 */
export class AuthLedger {
  private readonly path: string;
  private readonly rateLimit: RateLimitSettings;
  private readonly now: () => number;
  private attempts: Map<string, number[]> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: AuthLedgerOptions) {
    this.path = options.path;
    this.rateLimit = options.rateLimit;
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  get enabled(): boolean {
    return this.rateLimit.enabled;
  }

  /** Atomically decide whether an attempt is allowed, recording it when it is. */
  checkAndRecord(key: string): Promise<RateLimitDecision> {
    if (!this.rateLimit.enabled) {
      return Promise.resolve({
        allowed: true,
        retryAfterSeconds: 0,
        remainingAttempts: 0,
        windowResetsAt: null,
      });
    }
    return this.enqueue(() => this.record(key));
  }

  private enqueue<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(operation);
    // Keep the chain alive even when one call fails, so later calls still run.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Port of `AuthRateStore._check_and_record_sync`. */
  private record(key: string): RateLimitDecision {
    const { minIntervalSeconds, maxAttempts, windowSeconds } = this.rateLimit;
    const now = this.now();
    const cutoff = now - windowSeconds;
    const attempts = this.load();

    // Expire stale attempts for every target so the file stays bounded.
    for (const [existing, times] of attempts) {
      const kept = times.filter((time) => time >= cutoff);
      if (kept.length > 0) attempts.set(existing, kept);
      else attempts.delete(existing);
    }

    const times = attempts.get(key) ?? [];
    times.sort((a, b) => a - b);
    let retryAfter = 0;
    if (times.length > 0) {
      retryAfter = Math.max(0, minIntervalSeconds - (now - times[times.length - 1]!));
    }
    if (times.length >= maxAttempts) {
      const resetAt = times[0]! + windowSeconds;
      retryAfter = Math.max(retryAfter, resetAt - now);
      this.persist(attempts);
      return {
        allowed: false,
        retryAfterSeconds: retryAfter,
        remainingAttempts: 0,
        windowResetsAt: resetAt,
      };
    }
    if (retryAfter > 0) {
      this.persist(attempts);
      return {
        allowed: false,
        retryAfterSeconds: retryAfter,
        remainingAttempts: Math.max(0, maxAttempts - times.length),
        windowResetsAt: times.length > 0 ? times[0]! + windowSeconds : null,
      };
    }
    times.push(now);
    attempts.set(key, times);
    this.persist(attempts);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remainingAttempts: Math.max(0, maxAttempts - times.length),
      windowResetsAt: times[0]! + windowSeconds,
    };
  }

  private load(): Map<string, number[]> {
    if (this.attempts) return this.attempts;
    const map = new Map<string, number[]>();
    const file = readJsonFileSafe(this.path) as unknown as LedgerFile | null;
    const stored = file?.attempts;
    if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const times = value.filter(
          (time): time is number => typeof time === "number" && Number.isFinite(time),
        );
        if (times.length > 0) map.set(key, times);
      }
    }
    this.attempts = map;
    return map;
  }

  private persist(attempts: Map<string, number[]>): void {
    const payload: LedgerFile = { version: LEDGER_VERSION, attempts: {} };
    for (const [key, times] of attempts) {
      if (times.length > 0) payload.attempts[key] = [...times];
    }
    writeAtomicFileSync(this.path, `${JSON.stringify(payload)}\n`);
  }
}

/** Minimal counting semaphore; `run` releases it even when the operation throws. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(count: number) {
    this.available = Math.max(1, Math.floor(count));
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }
}

export interface AuthCandidate {
  id: string;
  name: string;
  description?: string;
  type: string;
  supported: boolean;
}

export interface AuthPrompt {
  kind: "permission" | "information" | "elicitation";
  title: string;
  message: string;
  options: Array<Record<string, unknown>>;
  schema: Record<string, unknown> | null;
  raw?: unknown;
  respond(answer: string, optionId: string | null, content: Record<string, unknown> | null): Promise<void>;
  /** Installed by the coordinator; withdraws this stale question without ending the workflow. */
  cancel?(): void;
}

export interface AuthSession {
  readonly sessionId: string;
  authTargetKey(): string;
  refreshAuthInfo(): Promise<{ authenticated: boolean } | null>;
  /** Credentials are known to be present (the harness session may still need opening). */
  isAuthenticated(): boolean;
  /** True only when the harness session is open and usable. */
  isReady(): boolean;
  ensureReady(): Promise<unknown>;
  authenticate(methodId: string): Promise<unknown>;
  authInfo(): object;
  authCandidates(): AuthCandidate[];
  setAuthQuestionSink(sink: ((prompt: AuthPrompt) => boolean) | null): void;
}

export interface AuthCoordinatorOptions {
  ledger: AuthLedger;
  maxConcurrentTargets: number;
  timeoutSeconds: number;
  inputTimeoutSeconds: number;
  /** Close and clean up a session, e.g. after an authentication timeout. */
  closeSession(sessionId: string): Promise<void>;
}

export type AuthState = "waiting_input" | "authenticating" | "ready" | "failed" | "cancelled" | "authentication_rate_limited";
interface PendingAuthQuestion {
  request_id: string;
  kind: AuthPrompt["kind"];
  title: string;
  message: string;
  options: Array<Record<string, unknown>>;
  schema: Record<string, unknown> | null;
  raw?: unknown;
  selection?: boolean;
  prompt?: AuthPrompt;
}
interface AuthWorkflow {
  session: AuthSession;
  candidates: AuthCandidate[];
  state: AuthState;
  terminal: boolean;
  authenticated?: boolean;
  error?: ReturnType<typeof errorInfo>;
  questions: Map<string, PendingAuthQuestion>;
  timeout: ReturnType<typeof setTimeout>;
  inputTimeout?: ReturnType<typeof setTimeout>;
  loginStarted: boolean;
}

export class AuthCoordinator {
  private readonly ledger: AuthLedger;
  private readonly timeoutMs: number;
  private readonly inputTimeoutMs: number;
  private readonly slots: Semaphore;
  private readonly closeSession: (sessionId: string) => Promise<void>;
  /** target key -> owning session id, for same-target serialization. */
  private readonly owners = new Map<string, string>();
  private readonly workflows = new Map<string, AuthWorkflow>();

  constructor(options: AuthCoordinatorOptions) {
    this.ledger = options.ledger;
    this.timeoutMs = options.timeoutSeconds * 1000;
    this.inputTimeoutMs = options.inputTimeoutSeconds * 1000;
    this.slots = new Semaphore(options.maxConcurrentTargets);
    this.closeSession = options.closeSession;
  }

  /** True while a session has an authentication operation in flight. */
  isAuthenticating(sessionId: string): boolean {
    return Boolean(this.workflows.get(sessionId) && !this.workflows.get(sessionId)!.terminal);
  }

  start(session: AuthSession): Record<string, unknown> {
    const existing = this.workflows.get(session.sessionId);
    if (existing && !existing.terminal) return this.snapshot(existing);
    // A finished flow (ready/failed/cancelled) is replaced: calling authenticate again starts a
    // fresh flow rather than replaying a dead snapshot.
    if (existing) { this.cleanup(existing); this.workflows.delete(session.sessionId); }
    if (session.isReady()) return { session_id: session.sessionId, state: "ready", terminal: true, questions: [], authenticated: true, candidates: session.authCandidates() };
    const candidates = session.authCandidates();
    const workflow: AuthWorkflow = {
      session, candidates, state: "waiting_input", terminal: false, questions: new Map(), loginStarted: false,
      timeout: setTimeout(() => { void this.timeout(session.sessionId, "authentication_timeout", "authentication workflow timed out"); }, this.timeoutMs),
    };
    workflow.timeout.unref?.();
    this.workflows.set(session.sessionId, workflow);
    session.setAuthQuestionSink(prompt => this.enqueue(workflow, prompt));
    if (session.isAuthenticated()) {
      // Credentials already exist (an externally completed login, or a prior success whose
      // session-open failed). Open the harness session WITHOUT a credential write or a
      // rate-limited attempt, and only report ready if it truly opens.
      workflow.state = "authenticating"; workflow.loginStarted = true;
      void this.open(workflow);
      return this.snapshot(workflow);
    }
    const supported = candidates.filter(candidate => candidate.supported).map(candidate => candidate.id);
    if (!supported.length) {
      this.finish(workflow, "failed", new BridgeError("unsupported_authentication", "No advertised authentication method is supported by harness_acp_bridge"));
      return this.snapshot(workflow);
    }
    const requestId = randomUUID();
    workflow.questions.set(requestId, {
      request_id: requestId, kind: "information", title: "Choose an authentication method",
      message: `Choose one supported authentication method. Advertised candidates:\n${JSON.stringify(candidates, null, 2)}`,
      options: [], selection: true,
      schema: { type: "object", properties: { method_id: { type: "string", enum: supported } }, required: ["method_id"], additionalProperties: false },
    });
    this.armInputTimeout(workflow);
    return this.snapshot(workflow);
  }

  /** Re-open the harness session for already-present credentials; never charges an attempt. */
  private async open(workflow: AuthWorkflow): Promise<void> {
    try {
      await workflow.session.ensureReady();
      if (workflow.terminal) return;
      if (workflow.session.isReady()) this.finish(workflow, "ready", undefined, true);
      else this.finish(workflow, "failed", new BridgeError("authentication_failed", "credentials are present but the harness session did not open"));
    } catch (error) {
      if (!workflow.terminal) this.finish(workflow, "failed", error);
    }
  }

  status(session: AuthSession): Record<string, unknown> | null {
    const workflow = this.workflows.get(session.sessionId);
    return workflow ? this.snapshot(workflow) : null;
  }

  async answer(sessionId: string, requestId: string, answer: string, optionId: string | null, content: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const workflow = this.workflows.get(sessionId);
    if (!workflow || workflow.terminal) throw new BridgeError("no_pending_question", "authentication is not awaiting input");
    const question = workflow.questions.get(requestId);
    if (!question) throw new BridgeError("question_not_found", "unknown or stale authentication request_id");
    // A reject is a real answer for a permission question; elsewhere it aborts the flow.
    const aborts = answer === "cancel" || answer === "timeout" || (answer === "reject" && question.kind !== "permission");
    if (aborts) return this.abort(workflow, requestId, answer);

    if (question.selection) {
      if (!content) throw new BridgeError("invalid_answer", "content must be an object");
      const methodId = content.method_id;
      if (typeof methodId !== "string") throw new BridgeError("invalid_answer", "method_id is required");
      const candidate = workflow.candidates.find(item => item.id === methodId);
      if (!candidate) throw new BridgeError("invalid_option", "method_id is not advertised by the harness");
      if (!candidate.supported) throw new BridgeError("unsupported_authentication", `Authentication method ${methodId} is not supported in harness_acp_bridge`);
      validateObjectSchema(question.schema!, content);
      this.consume(workflow, requestId);
      workflow.state = "authenticating"; workflow.loginStarted = true;
      void this.run(workflow, methodId).catch(() => undefined);
      return this.snapshot(workflow);
    }
    if (question.kind === "permission") {
      // A permission answer is an offered option id and needs no content object.
      if (answer === "accept" && (!optionId || !question.options.some(option => option.optionId === optionId))) {
        throw new BridgeError("invalid_option", "option_id is not offered by the harness");
      }
    } else {
      if (!content) throw new BridgeError("invalid_answer", "content must be an object");
      if (question.schema) validateObjectSchema(question.schema, content);
    }
    // Claim the question synchronously so a concurrent answer for the same request_id cannot emit a
    // second RPC response. An invalid answer still threw above, leaving the question pending.
    this.consume(workflow, requestId);
    try {
      await question.prompt!.respond(answer, optionId, content);
    } catch (error) {
      // A failed write is terminal: the answer was claimed and the harness never received it. Fail
      // now (preserving the original error) instead of waiting for the overall auth deadline, and
      // take down a started login. A late success/failure must not overwrite this state.
      if (!workflow.terminal) {
        const close = workflow.loginStarted;
        this.finish(workflow, "failed", error);
        if (close) await this.closeSession(workflow.session.sessionId).catch(() => undefined);
      }
      throw error;
    }
    // The flow may have reached a terminal state while the write was in flight (e.g. cancelled or a
    // harness completion); never overwrite it.
    if (!workflow.terminal) this.settle(workflow);
    return this.snapshot(workflow);
  }

  /** Abandon a session's flow (e.g. on close); a started login takes the session down with it. */
  async cancel(sessionId: string): Promise<void> {
    const workflow = this.workflows.get(sessionId);
    if (!workflow || workflow.terminal) return;
    const close = workflow.loginStarted;
    this.finish(workflow, "cancelled");
    if (close) await this.closeSession(sessionId).catch(() => undefined);
  }

  private consume(workflow: AuthWorkflow, requestId: string): void {
    workflow.questions.delete(requestId);
    clearTimeout(workflow.inputTimeout);
  }

  /** Reflect the remaining queue without overwriting a terminal state. */
  private settle(workflow: AuthWorkflow): void {
    if (workflow.terminal) return;
    workflow.state = workflow.questions.size ? "waiting_input" : "authenticating";
    if (workflow.questions.size) this.armInputTimeout(workflow);
  }

  private async abort(workflow: AuthWorkflow, requestId: string, answer: string): Promise<Record<string, unknown>> {
    this.consume(workflow, requestId);
    const close = workflow.loginStarted;
    this.finish(workflow, "cancelled", answer === "timeout" ? new BridgeError("input_timeout", "authentication question timed out") : undefined);
    if (close) await this.closeSession(workflow.session.sessionId).catch(() => undefined);
    return this.snapshot(workflow);
  }

  private async run(workflow: AuthWorkflow, methodId: string): Promise<void> {
    const { session } = workflow;
    const key = session.authTargetKey();
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== session.sessionId) {
      this.finish(workflow, "failed", new BridgeError("authentication_in_progress", "another session is authenticating this target"));
      return;
    }
    this.owners.set(key, session.sessionId);
    try {
      let decision;
      try { decision = await this.ledger.checkAndRecord(key); }
      catch (error) {
        // A ledger failure must become a failed flow, never an unhandled rejection.
        if (!workflow.terminal) this.finish(workflow, "failed", error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // The flow may have ended (cancelled/timed out) while the ledger awaited; never write then.
      if (workflow.terminal) return;
      if (!decision.allowed) {
        workflow.state = "authentication_rate_limited"; workflow.terminal = true;
        workflow.error = errorInfo(new BridgeError("authentication_rate_limited", "authentication attempt was rate limited", {
          retry_after_seconds: decision.retryAfterSeconds, remaining_attempts: decision.remainingAttempts, window_resets_at: decision.windowResetsAt,
        }));
        this.cleanup(workflow); return;
      }
      await this.slots.run(async () => {
        // Re-check after queueing behind the concurrency bound, before any credential write.
        if (workflow.terminal) return;
        await session.authenticate(methodId);
      });
      if (!workflow.terminal) this.finish(workflow, "ready", undefined, true);
    } catch (error) {
      if (!workflow.terminal) this.finish(workflow, "failed", error);
    } finally {
      if (this.owners.get(key) === session.sessionId) this.owners.delete(key);
    }
  }

  private enqueue(workflow: AuthWorkflow, prompt: AuthPrompt): boolean {
    if (workflow.terminal || !workflow.loginStarted) return false;
    const requestId = randomUUID();
    prompt.cancel = () => {
      if (workflow.terminal) return;
      workflow.questions.delete(requestId);
      clearTimeout(workflow.inputTimeout);
      // Maintain the remaining questions (state + a fresh input deadline); never leave sibling
      // reverse questions without an input timeout after one is withdrawn.
      this.settle(workflow);
    };
    workflow.questions.set(requestId, { request_id: requestId, kind: prompt.kind, title: prompt.title, message: prompt.message,
      options: prompt.options, schema: prompt.schema, raw: prompt.raw, prompt });
    workflow.state = "waiting_input"; this.armInputTimeout(workflow); return true;
  }

  private armInputTimeout(workflow: AuthWorkflow): void {
    clearTimeout(workflow.inputTimeout);
    if (!this.inputTimeoutMs) return;
    workflow.inputTimeout = setTimeout(() => { void this.timeout(workflow.session.sessionId, "input_timeout", "authentication question was not answered before deadline"); }, this.inputTimeoutMs);
    workflow.inputTimeout.unref?.();
  }

  private async timeout(sessionId: string, code: string, message: string): Promise<void> {
    const workflow = this.workflows.get(sessionId);
    if (!workflow || workflow.terminal) return;
    const close = workflow.loginStarted;
    this.finish(workflow, "failed", new BridgeError(code, message));
    if (close) await this.closeSession(sessionId).catch(() => undefined);
  }

  private finish(workflow: AuthWorkflow, state: AuthState, error?: unknown, authenticated = false): void {
    workflow.state = state; workflow.terminal = true; workflow.questions.clear(); workflow.authenticated = authenticated;
    if (error) workflow.error = errorInfo(error);
    this.cleanup(workflow);
  }

  private cleanup(workflow: AuthWorkflow, key?: string): void {
    clearTimeout(workflow.timeout); clearTimeout(workflow.inputTimeout);
    workflow.session.setAuthQuestionSink(null);
    if (key && this.owners.get(key) === workflow.session.sessionId) this.owners.delete(key);
  }

  private snapshot(workflow: AuthWorkflow): Record<string, unknown> {
    return { session_id: workflow.session.sessionId, state: workflow.state, terminal: workflow.terminal,
      questions: [...workflow.questions.values()].map(({ prompt, selection, ...question }) => question),
      candidates: workflow.candidates, ...(workflow.authenticated !== undefined ? { authenticated: workflow.authenticated } : {}),
      ...(workflow.error ? { error: workflow.error } : {}) };
  }
}
