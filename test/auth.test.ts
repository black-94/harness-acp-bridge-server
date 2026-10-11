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
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthCoordinator,
  AuthLedger,
  type AuthCandidate,
  type AuthPrompt,
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
  ready = false;
  /** When set, `ensureReady` fails — modelling a credential write whose session open failed. */
  ensureReadyFails = false;
  candidates: AuthCandidate[] = [{ id: "api-key", name: "API Key", type: "agent", supported: true }];
  readonly authCalls: string[] = [];
  sink: ((prompt: AuthPrompt) => boolean) | null = null;
  /** When set, the credential write waits for this gate before completing. */
  gate: Promise<void> | null = null;
  /** Custom login body (used to drive reverse prompts) replacing the gate/success default. */
  onAuthenticate: ((session: FakeSession) => Promise<void>) | null = null;
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
    return { authenticated: this.authenticated };
  }
  isAuthenticated(): boolean {
    return this.authenticated;
  }
  isReady(): boolean {
    return this.ready;
  }
  async ensureReady(): Promise<unknown> {
    if (this.ensureReadyFails) throw new Error("harness session did not open");
    this.ready = true;
    return {};
  }
  authInfo(): object {
    return { authenticated: this.authenticated };
  }
  authCandidates(): AuthCandidate[] {
    return this.candidates;
  }
  setAuthQuestionSink(sink: ((prompt: AuthPrompt) => boolean) | null): void {
    this.sink = sink;
  }
  async authenticate(methodId: string): Promise<void> {
    this.authCalls.push(methodId);
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.onAuthenticate) await this.onAuthenticate(this);
      else if (this.gate) await this.gate;
      this.authenticated = true;
      this.ready = true;
    } finally {
      this.activeWrites -= 1;
    }
  }
}

function coordinator(options: {
  ledger?: AuthLedger;
  maxConcurrentTargets?: number;
  timeoutSeconds?: number;
  inputTimeoutSeconds?: number;
  closed?: string[];
} = {}): AuthCoordinator {
  return new AuthCoordinator({
    ledger:
      options.ledger ??
      new AuthLedger({ path: join(tmpDir("hab-coord-ledger-"), "auth-rate.json"), rateLimit: rateLimit() }),
    maxConcurrentTargets: options.maxConcurrentTargets ?? 2,
    timeoutSeconds: options.timeoutSeconds ?? 5,
    inputTimeoutSeconds: options.inputTimeoutSeconds ?? 0,
    closeSession: async (sessionId) => {
      options.closed?.push(sessionId);
    },
  });
}

type Snapshot = Record<string, any>;

/** The method-selection question the coordinator always asks first. */
function selection(snapshot: Snapshot): any {
  return (snapshot.questions as any[]).find(question => question.schema?.properties?.method_id);
}

async function choose(auth: AuthCoordinator, session: FakeSession, methodId: string): Promise<Snapshot> {
  const snapshot = auth.start(session);
  const question = selection(snapshot);
  expect(question, JSON.stringify(snapshot)).toBeDefined();
  return auth.answer(session.sessionId, question.request_id, "accept", null, { method_id: methodId });
}

async function waitForQuestion(auth: AuthCoordinator, session: FakeSession, timeoutMs = 2000): Promise<Snapshot> {
  let snapshot: Snapshot = {};
  await waitUntil(() => {
    snapshot = auth.status(session) ?? {};
    return Array.isArray(snapshot.questions) && snapshot.questions.length > 0;
  }, timeoutMs);
  return snapshot;
}

const BROWSER_PROMPT = (respond: AuthPrompt["respond"]): AuthPrompt => ({
  kind: "information",
  title: "Complete authentication",
  message: "https://example.test/login",
  options: [],
  schema: { type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"], additionalProperties: false },
  respond,
});

describe("AuthCoordinator", () => {
  it("opens an already-authenticated session without spending an attempt", async () => {
    const path = join(tmpDir("hab-coord-ready-"), "auth-rate.json");
    const auth = coordinator({ ledger: new AuthLedger({ path, rateLimit: rateLimit({ maxAttempts: 1 }) }) });
    const session = new FakeSession("s1", "target");
    // Credentials are present but the harness session is not open yet.
    session.authenticated = true;
    session.ready = false;
    const started = auth.start(session);
    expect(started.state).toBe("authenticating");
    await waitUntil(() => auth.status(session)?.state === "ready");
    expect(auth.status(session)!.authenticated).toBe(true);
    expect(session.authCalls).toEqual([]);
    // No attempt was recorded, so the ledger file was never created.
    expect(() => statSync(path)).toThrow();
  });

  it("does not report ready when the credentials exist but the session open fails", async () => {
    const path = join(tmpDir("hab-coord-openfail-"), "auth-rate.json");
    const auth = coordinator({ ledger: new AuthLedger({ path, rateLimit: rateLimit({ maxAttempts: 1 }) }) });
    const session = new FakeSession("s1", "target");
    session.authenticated = true;
    session.ready = false;
    session.ensureReadyFails = true;
    auth.start(session);
    await waitUntil(() => auth.status(session)?.state === "failed");
    expect(auth.status(session)!.terminal).toBe(true);
    expect(session.authCalls).toEqual([]);
    expect(() => statSync(path)).toThrow(); // no credential write, so no rate charge
  });

  it("requires an explicit method choice and never auto-selects", () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    const snapshot = auth.start(session);
    expect(snapshot.state).toBe("waiting_input");
    expect(snapshot.terminal).toBe(false);
    expect(session.authCalls).toEqual([]);
    const question = selection(snapshot);
    expect(question.kind).toBe("information");
    expect(question.schema.required).toEqual(["method_id"]);
    expect(question.schema.properties.method_id.enum).toEqual(["api-key"]);
    // Every advertised candidate is echoed, including unsupported ones.
    expect(snapshot.candidates).toEqual([{ id: "api-key", name: "API Key", type: "agent", supported: true }]);
  });

  it("rejects a method that is not advertised or not supported", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    session.candidates = [
      { id: "api-key", name: "API Key", type: "agent", supported: true },
      { id: "client-code", name: "Client", type: "client", supported: false, description: "Not supported in harness_acp_bridge" },
    ];
    const snapshot = auth.start(session);
    const question = selection(snapshot);
    await expect(auth.answer("s1", question.request_id, "accept", null, { method_id: "nope" })).rejects.toMatchObject({ code: "invalid_option" });
    await expect(auth.answer("s1", question.request_id, "accept", null, { method_id: "client-code" })).rejects.toMatchObject({ code: "unsupported_authentication" });
    expect(session.authCalls).toEqual([]);
  });

  it("fails when no advertised method is supported", () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    session.candidates = [{ id: "client-code", name: "Client", type: "client", supported: false }];
    const snapshot = auth.start(session);
    expect(snapshot.state).toBe("failed");
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.error.code).toBe("unsupported_authentication");
  });

  it("serializes authentication for one target across sessions", async () => {
    const auth = coordinator();
    const gate = deferred();
    const first = new FakeSession("s1", "same-target");
    first.gate = gate.promise;
    const second = new FakeSession("s2", "same-target");

    await choose(auth, first, "api-key");
    await waitUntil(() => first.authCalls.length === 1);

    const refused = await choose(auth, second, "api-key");
    await waitUntil(() => refused.state === "failed" || auth.status(second)?.state === "failed");
    const failed = auth.status(second)!;
    expect(failed.error.code).toBe("authentication_in_progress");
    expect(second.authCalls).toEqual([]);

    gate.resolve();
    await waitUntil(() => auth.status(first)?.state === "ready");
    // Once the target is free, the second session may authenticate.
    const retry = await choose(auth, second, "api-key");
    expect(retry.state).toBe("authenticating");
    await waitUntil(() => auth.status(second)?.state === "ready");
    expect(second.authCalls).toEqual(["api-key"]);
  });

  it("coalesces repeated authenticate calls for one session into a single flow", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    const gate = deferred();
    session.gate = gate.promise;

    const first = auth.start(session);
    const second = auth.start(session);
    expect(second.questions).toEqual(first.questions);
    expect(auth.isAuthenticating("s1")).toBe(true);

    await auth.answer("s1", selection(first).request_id, "accept", null, { method_id: "api-key" });
    await waitUntil(() => session.authCalls.length === 1);
    gate.resolve();
    await waitUntil(() => auth.status(session)?.state === "ready");
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

    await choose(auth, a, "api-key");
    await choose(auth, b, "api-key");
    await waitUntil(() => a.activeWrites + b.activeWrites === 1);
    expect([a.authCalls.length, b.authCalls.length].sort()).toEqual([0, 1]);

    gateA.resolve();
    await waitUntil(() => b.authCalls.length === 1);
    gateB.resolve();
    await waitUntil(() => a.maxActiveWrites + b.maxActiveWrites > 0 && auth.status(a)?.state === "ready" && auth.status(b)?.state === "ready");
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

    await choose(auth, first, "api-key");
    await waitUntil(() => auth.status(first)?.state === "ready");
    const limited = await choose(auth, second, "api-key");
    await waitUntil(() => auth.status(second)?.state === "authentication_rate_limited");
    const snapshot = auth.status(second)!;
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.error.code).toBe("authentication_rate_limited");
    expect(snapshot.error.detail.remaining_attempts).toBe(0);
    expect(second.authCalls).toEqual([]);
  });

  it("closes and cleans up a session when authentication times out", async () => {
    const closed: string[] = [];
    const auth = coordinator({ timeoutSeconds: 0.05, closed });
    const session = new FakeSession("s1", "target");
    session.gate = new Promise<void>(() => undefined); // never resolves

    await choose(auth, session, "api-key");
    await waitUntil(() => auth.status(session)?.state === "failed");
    const snapshot = auth.status(session)!;
    expect(snapshot.error.code).toBe("authentication_timeout");
    expect(closed).toEqual(["s1"]);
    expect(auth.isAuthenticating("s1")).toBe(false);
  });

  it("fails an unanswered method-selection question on the input deadline without closing", async () => {
    const closed: string[] = [];
    const auth = coordinator({ inputTimeoutSeconds: 0.05, closed });
    const session = new FakeSession("s1", "target");
    auth.start(session);
    await waitUntil(() => auth.status(session)?.state === "failed");
    expect(auth.status(session)!.error.code).toBe("input_timeout");
    expect(closed).toEqual([]);
  });

  it("cancels a flow at method selection without closing the session, and restarts fresh", async () => {
    const closed: string[] = [];
    const auth = coordinator({ closed });
    const session = new FakeSession("s1", "target");
    const first = auth.start(session);
    const cancelled = await auth.answer("s1", selection(first).request_id, "cancel", null, null);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.terminal).toBe(true);
    expect(closed).toEqual([]);
    // A finished flow is replaced, not replayed.
    const second = auth.start(session);
    expect(second.state).toBe("waiting_input");
    expect(selection(second).request_id).not.toBe(selection(first).request_id);
  });

  it("closes the session when a started login is cancelled, so a late success cannot revive it", async () => {
    const closed: string[] = [];
    const auth = coordinator({ closed });
    const session = new FakeSession("s1", "target");
    const release = deferred();
    session.onAuthenticate = async () => { await release.promise; };
    await choose(auth, session, "api-key");
    await waitUntil(() => session.authCalls.length === 1);

    await auth.cancel("s1");
    expect(closed).toEqual(["s1"]);
    expect(auth.status(session)!.state).toBe("cancelled");
    // The still-running login resolves later; the terminal state must not flip to ready.
    release.resolve();
    await waitUntil(() => auth.isAuthenticating("s1") === false);
    expect(auth.status(session)!.state).toBe("cancelled");
  });

  it("treats a browser acknowledgement as an acknowledgement, not success", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    const release = deferred();
    session.onAuthenticate = async (self) => {
      const answered = deferred();
      const accepted = self.sink!(BROWSER_PROMPT(async () => answered.resolve()));
      expect(accepted).toBe(true);
      await answered.promise;
      await release.promise;
    };
    await choose(auth, session, "api-key");
    const view = await waitForQuestion(auth, session);
    const question = (view.questions as any[])[0];
    expect(question.message).toBe("https://example.test/login");

    await auth.answer("s1", question.request_id, "accept", null, { opened: true });
    // Confirming the browser step does not complete the login.
    expect(auth.status(session)!.state).toBe("authenticating");
    expect(auth.status(session)!.terminal).toBe(false);

    release.resolve();
    await waitUntil(() => auth.status(session)?.state === "ready");
    expect(auth.status(session)!.authenticated).toBe(true);
  });

  it("validates a reverse question answer against its schema", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    session.onAuthenticate = async (self) => {
      await new Promise<void>(() => { self.sink!(BROWSER_PROMPT(async () => undefined)); });
    };
    await choose(auth, session, "api-key");
    const view = await waitForQuestion(auth, session);
    const question = (view.questions as any[])[0];
    await expect(auth.answer("s1", question.request_id, "accept", null, {})).rejects.toMatchObject({ code: "invalid_answer" });
    await expect(auth.answer("s1", question.request_id, "accept", null, { opened: false })).rejects.toMatchObject({ code: "invalid_option" });
    await expect(auth.answer("s1", "stale-id", "accept", null, { opened: true })).rejects.toMatchObject({ code: "question_not_found" });
  });

  it("withdraws a stale question on the harness completion signal", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    let prompt: AuthPrompt | null = null;
    session.onAuthenticate = async (self) => {
      await new Promise<void>(() => { prompt = BROWSER_PROMPT(async () => undefined); self.sink!(prompt); });
    };
    await choose(auth, session, "api-key");
    await waitForQuestion(auth, session);
    expect(prompt).not.toBeNull();
    prompt!.cancel!();
    const view = auth.status(session)!;
    expect(view.questions).toEqual([]);
    expect(view.terminal).toBe(false);
  });

  it("re-arms the input deadline for a sibling question when one is withdrawn", async () => {
    const closed: string[] = [];
    const auth = coordinator({ inputTimeoutSeconds: 0.15, closed });
    const session = new FakeSession("s1", "target");
    const prompts: AuthPrompt[] = [];
    session.onAuthenticate = async (self) => {
      await new Promise<void>(() => {
        const first = BROWSER_PROMPT(async () => undefined);
        const second = BROWSER_PROMPT(async () => undefined);
        self.sink!(first);
        self.sink!(second);
        prompts.push(first, second);
      });
    };
    await choose(auth, session, "api-key");
    await waitUntil(() => (auth.status(session)?.questions as any[]).length === 2);
    // Withdraw A (a harness elicitation/complete). B must remain waiting with a live deadline.
    prompts[0]!.cancel!();
    const after = auth.status(session)!;
    expect(after.terminal).toBe(false);
    expect(after.state).toBe("waiting_input");
    expect((after.questions as any[]).length).toBe(1);
    // The sibling's input deadline still fires (impossible if the shared timer stayed cleared).
    await waitUntil(() => auth.status(session)?.state === "failed");
    expect(auth.status(session)!.error.code).toBe("input_timeout");
    expect(closed).toEqual(["s1"]);
  });

  it("fails the flow and closes a started login when the answer write fails, without a second response", async () => {
    const closed: string[] = [];
    const auth = coordinator({ closed });
    const session = new FakeSession("s1", "target");
    let writes = 0;
    session.onAuthenticate = async (self) => {
      await new Promise<void>(() => {
        const prompt: AuthPrompt = { kind: "information", title: "t", message: "m", options: [],
          schema: { type: "object", properties: { v: { type: "string" } }, required: ["v"], additionalProperties: false },
          respond: async () => { writes += 1; throw new Error("transport closed"); } };
        self.sink!(prompt);
      });
    };
    await choose(auth, session, "api-key");
    const question = (await waitForQuestion(auth, session)).questions[0] as any;
    await expect(auth.answer("s1", question.request_id, "accept", null, { v: "x" })).rejects.toThrowError("transport closed");
    // The original error is preserved, the flow is terminal, and no question lingers.
    const snapshot = auth.status(session)!;
    expect(snapshot.state).toBe("failed");
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.error).toBeDefined();
    expect(snapshot.questions).toEqual([]);
    expect(closed).toEqual(["s1"]);
    // A retry cannot emit a second response.
    await expect(auth.answer("s1", question.request_id, "accept", null, { v: "x" })).rejects.toMatchObject({ code: "no_pending_question" });
    expect(writes).toBe(1);
  });

  it("accepts a permission question answered with an offered option and no content", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    let received: { answer: string; optionId: string | null } | null = null;
    session.onAuthenticate = async (self) => {
      await new Promise<void>((resolve) => {
        const prompt: AuthPrompt = { kind: "permission", title: "Allow?", message: "Allow this?",
          options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }], schema: null,
          respond: async (answer, optionId) => { received = { answer, optionId }; resolve(); } };
        expect(self.sink!(prompt)).toBe(true);
      });
    };
    await choose(auth, session, "api-key");
    const question = (await waitForQuestion(auth, session)).questions[0] as any;
    // Synchronous validation leaves an invalid option pending.
    await expect(auth.answer("s1", question.request_id, "accept", "not-offered", null)).rejects.toMatchObject({ code: "invalid_option" });
    expect((auth.status(session)!.questions as any[]).length).toBe(1);
    // No content object is required for a permission answer.
    const answered = await auth.answer("s1", question.request_id, "accept", "allow_once", null);
    expect(answered.state).toBe("authenticating");
    expect(received).toEqual({ answer: "accept", optionId: "allow_once" });
  });

  it("claims a question before the async write so a concurrent answer cannot double-send", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    let writes = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    session.onAuthenticate = async (self) => {
      await new Promise<void>((resolve) => {
        const prompt: AuthPrompt = { kind: "information", title: "Token", message: "Enter token",
          options: [], schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
          respond: async () => { writes += 1; await gate; resolve(); } };
        self.sink!(prompt);
      });
    };
    await choose(auth, session, "api-key");
    const question = (await waitForQuestion(auth, session)).questions[0] as any;
    const first = auth.answer("s1", question.request_id, "accept", null, { token: "value-123" });
    await waitUntil(() => writes === 1);
    await expect(auth.answer("s1", question.request_id, "accept", null, { token: "value-123" })).rejects.toMatchObject({ code: "question_not_found" });
    release!();
    await first;
    expect(writes).toBe(1);
  });

  it("does not overwrite a terminal state reached while an answer write is in flight", async () => {
    const auth = coordinator();
    const session = new FakeSession("s1", "target");
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    session.onAuthenticate = async (self) => {
      await new Promise<void>(() => {
        const prompt: AuthPrompt = { kind: "information", title: "x", message: "x", options: [], schema: { type: "object" },
          respond: async () => { await gate; } };
        self.sink!(prompt);
      });
    };
    await choose(auth, session, "api-key");
    const question = (await waitForQuestion(auth, session)).questions[0] as any;
    const inFlight = auth.answer("s1", question.request_id, "accept", null, { x: 1 });
    await auth.cancel("s1"); // terminal while the write is in flight
    release!();
    const snapshot = await inFlight;
    expect(snapshot.state).toBe("cancelled");
    expect(snapshot.terminal).toBe(true);
  });

  it("does not write credentials when a queued flow is cancelled before its slot opens", async () => {
    const auth = coordinator({ maxConcurrentTargets: 1 });
    const gateA = deferred();
    const a = new FakeSession("s1", "target-a");
    a.gate = gateA.promise;
    const b = new FakeSession("s2", "target-b");
    await choose(auth, a, "api-key");
    await waitUntil(() => a.authCalls.length === 1);
    await choose(auth, b, "api-key"); // queued behind the single slot
    await waitUntil(() => auth.status(b)?.state === "authenticating");
    await auth.cancel("s2"); // terminal before the slot opens
    gateA.resolve();
    await waitUntil(() => auth.status(a)?.state === "ready");
    await waitUntil(() => auth.isAuthenticating("s2") === false);
    expect(b.authCalls).toEqual([]); // no credential-writing side effect after the terminal check
  });

  it("fails the flow (never an unhandled rejection) when the ledger throws", async () => {
    const ledger = new AuthLedger({ path: join(tmpDir("hab-ledger-fail-"), "auth-rate.json"), rateLimit: rateLimit() });
    vi.spyOn(ledger, "checkAndRecord").mockRejectedValue(new Error("disk full"));
    const auth = coordinator({ ledger });
    const session = new FakeSession("s1", "target");
    await choose(auth, session, "api-key");
    await waitUntil(() => auth.status(session)?.state === "failed");
    expect(auth.status(session)!.terminal).toBe(true);
    expect(auth.status(session)!.error).toBeDefined();
    expect(session.authCalls).toEqual([]);
    vi.restoreAllMocks();
    // Target ownership was released: a fresh flow on the same target can proceed.
    await choose(auth, session, "api-key");
    await waitUntil(() => auth.status(session)?.state === "ready");
    expect(session.authCalls).toEqual(["api-key"]);
  });
});
