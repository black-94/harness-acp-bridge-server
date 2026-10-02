/**
 * Unit coverage for the authentication ledger and coordinator.
 *
 * These exercise the ported semantics without a harness process: the persistent per-target
 * attempt ledger (`harness_acp_mcp/auth_store.py`) and the concurrency/serialization rules
 * of `bridge.py:SessionRegistry.start_authentication`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthCoordinator,
  AuthLedger,
  type AuthSession,
  authTargetKey,
  type RateLimitSettings,
} from "../src/auth";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rateLimit(overrides: Partial<RateLimitSettings> = {}): RateLimitSettings {
  return {
    enabled: true,
    minIntervalSeconds: 0,
    maxAttempts: 3,
    windowSeconds: 3600,
    ...overrides,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

// --- ledger ------------------------------------------------------------------

describe("AuthLedger", () => {
  it("records attempts atomically and persists them across a restart", async () => {
    const path = join(tmpDir("hab-ledger-"), "auth-rate.json");
    const key = authTargetKey("codex", "local", null);
    const first = new AuthLedger({ path, rateLimit: rateLimit({ maxAttempts: 2 }) });
    expect((await first.checkAndRecord(key)).allowed).toBe(true);
    expect((await first.checkAndRecord(key)).allowed).toBe(true);
    const limited = await first.checkAndRecord(key);
    expect(limited.allowed).toBe(false);
    expect(limited.remainingAttempts).toBe(0);
    expect(limited.windowResetsAt).toBeGreaterThan(0);

    // A fresh instance (a restarted daemon) sees the same budget.
    const restarted = new AuthLedger({ path, rateLimit: rateLimit({ maxAttempts: 2 }) });
    expect((await restarted.checkAndRecord(key)).allowed).toBe(false);
  });

  it("serializes concurrent attempts so none is lost", async () => {
    const path = join(tmpDir("hab-ledger-atomic-"), "auth-rate.json");
    const key = authTargetKey("agy", "ssh", "host-a");
    const ledger = new AuthLedger({ path, rateLimit: rateLimit({ maxAttempts: 3 }) });
    const decisions = await Promise.all([
      ledger.checkAndRecord(key),
      ledger.checkAndRecord(key),
      ledger.checkAndRecord(key),
      ledger.checkAndRecord(key),
    ]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
  });

  it("can be disabled without creating state", async () => {
    const dir = tmpDir("hab-ledger-off-");
    const path = join(dir, "auth-rate.json");
    const ledger = new AuthLedger({ path, rateLimit: rateLimit({ enabled: false, maxAttempts: 1 }) });
    expect((await ledger.checkAndRecord("opaque")).allowed).toBe(true);
    expect((await ledger.checkAndRecord("opaque")).allowed).toBe(true);
    expect(() => statSync(path)).toThrow();
  });

  it("writes a private file whose key never contains the target text", async () => {
    const path = join(tmpDir("hab-ledger-key-"), "auth-rate.json");
    const key = authTargetKey("agy", "ssh", "super-secret-host");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("super-secret-host");
    const ledger = new AuthLedger({ path, rateLimit: rateLimit() });
    await ledger.checkAndRecord(key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("super-secret-host");
  });

  it("enforces min_interval and expires attempts after the window", async () => {
    const path = join(tmpDir("hab-ledger-window-"), "auth-rate.json");
    let clock = 1000;
    const ledger = new AuthLedger({
      path,
      rateLimit: rateLimit({ minIntervalSeconds: 30, maxAttempts: 5, windowSeconds: 100 }),
      now: () => clock,
    });
    expect((await ledger.checkAndRecord("k")).allowed).toBe(true);
    const tooSoon = await ledger.checkAndRecord("k");
    expect(tooSoon.allowed).toBe(false);
    expect(tooSoon.retryAfterSeconds).toBe(30);

    clock += 30;
    expect((await ledger.checkAndRecord("k")).allowed).toBe(true);

    // Both earlier attempts fall outside the 100s window and stop counting.
    clock += 101;
    const afterWindow = await ledger.checkAndRecord("k");
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remainingAttempts).toBe(4);
  });
});

// --- coordinator -------------------------------------------------------------

class FakeSession implements AuthSession {
  authenticated = false;
  readonly authCalls: string[] = [];
  readyCalls = 0;
  /** When set, the credential write waits for this gate before completing. */
  gate: Promise<void> | null = null;
  /** `null` models a harness without an auth-status endpoint. */
  probeResult: { authenticated: boolean } | null = { authenticated: false };
  activeWrites = 0;
  maxActiveWrites = 0;

  constructor(
    readonly sessionId: string,
    private readonly key: string,
  ) {}

  authTargetKey(): string {
    return this.key;
  }
  async refreshAuthInfo(): Promise<{ authenticated: boolean } | null> {
    return this.probeResult;
  }
  isAuthenticated(): boolean {
    return this.authenticated;
  }
  async ensureReady(): Promise<void> {
    this.readyCalls += 1;
  }
  async authenticate(methodId: string): Promise<void> {
    this.authCalls.push(methodId);
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.gate) await this.gate;
      this.authenticated = true;
    } finally {
      this.activeWrites -= 1;
    }
  }
  authInfo(): object {
    return { authenticated: this.authenticated, state: "ready" };
  }
}

function coordinator(options: {
  ledger?: AuthLedger;
  maxConcurrentTargets?: number;
  timeoutSeconds?: number;
  closed?: string[];
} = {}): AuthCoordinator {
  return new AuthCoordinator({
    ledger:
      options.ledger ??
      new AuthLedger({ path: join(tmpDir("hab-coord-ledger-"), "auth-rate.json"), rateLimit: rateLimit() }),
    maxConcurrentTargets: options.maxConcurrentTargets ?? 2,
    timeoutSeconds: options.timeoutSeconds ?? 5,
    closeSession: async (sessionId) => {
      options.closed?.push(sessionId);
    },
  });
}

describe("AuthCoordinator", () => {
  it("serializes authentication for one target across sessions", async () => {
    const auth = coordinator();
    const gate = deferred();
    const first = new FakeSession("s1", "same-target");
    first.gate = gate.promise;
    const second = new FakeSession("s2", "same-target");

    const pending = auth.authenticate(first, "api-key");
    await waitUntil(() => first.authCalls.length === 1);

    const refused = await auth.authenticate(second, "api-key");
    expect(refused.status).toBe("authentication_in_progress");
    expect(refused.poll_after_seconds).toBe(2);
    expect(second.authCalls).toEqual([]);

    gate.resolve();
    expect((await pending).status).toBe("ready");
    // Once the target is free, the second session may authenticate.
    expect((await auth.authenticate(second, "api-key")).status).toBe("ready");
  });

  it("coalesces repeated authenticate calls for one session into a single credential write", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    const gate = deferred();
    session.gate = gate.promise;

    const first = auth.authenticate(session, "api-key");
    const second = auth.authenticate(session, "api-key");
    await waitUntil(() => session.authCalls.length === 1);
    expect(auth.isAuthenticating("s1")).toBe(true);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(session.authCalls).toEqual(["api-key"]);
    expect(auth.isAuthenticating("s1")).toBe(false);
  });

  it("bounds how many distinct targets authenticate at once", async () => {
    const auth = coordinator({ maxConcurrentTargets: 1 });
    const gateA = deferred();
    const gateB = deferred();
    const a = new FakeSession("s1", "target-a");
    const b = new FakeSession("s2", "target-b");
    a.gate = gateA.promise;
    b.gate = gateB.promise;

    const pendingA = auth.authenticate(a, "api-key");
    const pendingB = auth.authenticate(b, "api-key");
    await waitUntil(() => a.activeWrites + b.activeWrites === 1);
    // Only one credential write is in flight; the other waits for the slot.
    expect([a.authCalls.length, b.authCalls.length].sort()).toEqual([0, 1]);

    gateA.resolve();
    await waitUntil(() => b.authCalls.length === 1);
    gateB.resolve();
    await Promise.all([pendingA, pendingB]);
    expect(Math.max(a.maxActiveWrites, b.maxActiveWrites)).toBe(1);
  });

  it("rate limits a second session on the same target", async () => {
    const auth = coordinator({
      ledger: new AuthLedger({
        path: join(tmpDir("hab-coord-limit-"), "auth-rate.json"),
        rateLimit: rateLimit({ maxAttempts: 1 }),
      }),
    });
    const first = new FakeSession("s1", "target");
    const second = new FakeSession("s2", "target");

    expect((await auth.authenticate(first, "api-key")).status).toBe("ready");
    const limited = await auth.authenticate(second, "api-key");
    expect(limited.status).toBe("authentication_rate_limited");
    expect(limited.remaining_attempts).toBe(0);
    expect(second.authCalls).toEqual([]);
  });

  it("confirms an already-authenticated session without spending an attempt", async () => {
    const path = join(tmpDir("hab-coord-ready-"), "auth-rate.json");
    const auth = coordinator({ ledger: new AuthLedger({ path, rateLimit: rateLimit({ maxAttempts: 1 }) }) });
    const session = new FakeSession("s1", "target");
    session.probeResult = { authenticated: true };

    const result = await auth.authenticate(session, "api-key");
    expect(result.status).toBe("ready");
    expect(session.authCalls).toEqual([]);
    expect(session.readyCalls).toBe(1);
    // No attempt was recorded, so the ledger file was never created.
    expect(() => statSync(path)).toThrow();
  });

  it("closes and cleans up a session when authentication times out", async () => {
    const closed: string[] = [];
    const auth = coordinator({ timeoutSeconds: 0.05, closed });
    const session = new FakeSession("s1", "target");
    session.gate = new Promise<void>(() => undefined); // never resolves

    const result = await auth.authenticate(session, "api-key");
    expect(result.status).toBe("authentication_timed_out");
    expect(closed).toEqual(["s1"]);
    expect(auth.isAuthenticating("s1")).toBe(false);
  });
});
