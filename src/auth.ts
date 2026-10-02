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
import { createHash } from "node:crypto";

import { readJsonFileSafe, writeAtomicFileSync } from "./persistence.js";

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

/** Raised when the authentication timeout elapses. */
export class AuthTimeoutError extends Error {
  override name = "AuthTimeoutError";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AuthTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The slice of a session the coordinator drives.
 *
 * Declared structurally so unit tests can inject a fake without spawning a harness.
 */
export interface AuthSession {
  readonly sessionId: string;
  /** Opaque ledger key for this session's harness+target (see `authTargetKey`). */
  authTargetKey(): string;
  /** Re-probe login state; `null` when the harness has no status endpoint. */
  refreshAuthInfo(): Promise<{ authenticated: boolean } | null>;
  /** True when the session is already logged in. */
  isAuthenticated(): boolean;
  /** Open (or confirm) the harness session without changing credentials. */
  ensureReady(): Promise<unknown>;
  /** Apply an auth method and open the harness session (the credential-writing step). */
  authenticate(methodId: string): Promise<unknown>;
  /** Public login/auth snapshot (whitelisted account, never credentials). */
  authInfo(): object;
}

export interface AuthCoordinatorOptions {
  ledger: AuthLedger;
  maxConcurrentTargets: number;
  timeoutSeconds: number;
  /** Close and clean up a session, e.g. after an authentication timeout. */
  closeSession(sessionId: string): Promise<void>;
}

export type AuthResult = Record<string, unknown>;

/**
 * Owns the in-flight authentication table and the cross-target concurrency bound.
 *
 * Port of `bridge.py:SessionRegistry.start_authentication`, with the reference's
 * `_auth_targets` map and `_auth_slots` semaphore. `authenticate` never rejects for a
 * benign condition (already in progress or rate limited); it returns a status the caller
 * polls, matching the async contract of the rest of the bridge.
 */
export class AuthCoordinator {
  private readonly ledger: AuthLedger;
  private readonly timeoutMs: number;
  private readonly slots: Semaphore;
  private readonly closeSession: (sessionId: string) => Promise<void>;
  /** target key -> owning session id, for same-target serialization. */
  private readonly owners = new Map<string, string>();
  /** session id -> in-flight operation, so repeated calls coalesce. */
  private readonly operations = new Map<string, Promise<AuthResult>>();

  constructor(options: AuthCoordinatorOptions) {
    this.ledger = options.ledger;
    this.timeoutMs = options.timeoutSeconds * 1000;
    this.slots = new Semaphore(options.maxConcurrentTargets);
    this.closeSession = options.closeSession;
  }

  /** True while a session has an authentication operation in flight. */
  isAuthenticating(sessionId: string): boolean {
    return this.operations.has(sessionId);
  }

  /**
   * Start (or join) the authentication for `session`.
   *
   * The claim on the target key and the per-session operation are recorded before any
   * `await`, so two concurrent calls can never both start a credential write: a repeat call
   * for the same session returns the in-flight operation, and a call for another session on
   * the same target is refused while one is running.
   */
  authenticate(session: AuthSession, methodId: string): Promise<AuthResult> {
    const existing = this.operations.get(session.sessionId);
    if (existing) return existing;
    const key = session.authTargetKey();
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== session.sessionId) {
      return Promise.resolve({
        status: "authentication_in_progress",
        session_id: session.sessionId,
        poll_after_seconds: 2,
      });
    }
    this.owners.set(key, session.sessionId);
    const operation = this.run(session, methodId, key).finally(() => {
      if (this.owners.get(key) === session.sessionId) this.owners.delete(key);
      this.operations.delete(session.sessionId);
    });
    this.operations.set(session.sessionId, operation);
    return operation;
  }

  private async run(session: AuthSession, methodId: string, key: string): Promise<AuthResult> {
    // A session that is already logged in is confirmed (and opened) without spending an
    // attempt, mirroring the reference's pre-authenticate `get_auth_info` check.
    const probe = await session.refreshAuthInfo().catch(() => null);
    if (probe?.authenticated || session.isAuthenticated()) {
      await session.ensureReady();
      return this.ready(session);
    }
    const decision = await this.ledger.checkAndRecord(key);
    if (!decision.allowed) {
      return {
        status: "authentication_rate_limited",
        session_id: session.sessionId,
        retry_after_seconds: decision.retryAfterSeconds,
        remaining_attempts: decision.remainingAttempts,
        window_resets_at: decision.windowResetsAt,
      };
    }
    try {
      await this.slots.run(() =>
        withTimeout(session.authenticate(methodId), this.timeoutMs, "harness authentication"),
      );
    } catch (error) {
      if (error instanceof AuthTimeoutError) {
        // A half-authenticated session is not left behind: close it (releasing the harness
        // transport and the container/remote per policy) and report the timeout.
        await this.closeSession(session.sessionId);
        return { status: "authentication_timed_out", session_id: session.sessionId };
      }
      throw error;
    }
    return this.ready(session);
  }

  private ready(session: AuthSession): AuthResult {
    return { status: "ready", session_id: session.sessionId, ...session.authInfo() };
  }
}
