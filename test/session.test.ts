import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AcpTurnEvent, InteractionAnswer } from "../src/acp";
import { authTargetKey } from "../src/auth";
import {
  defaultStateDirectory,
  loadConfig,
  type BridgeConfig,
  type HarnessConfig,
} from "../src/config";
import {
  IDEMPOTENCY_FILE,
  QUEUE_FILE,
  RESULTS_DIR,
  SessionRecorder,
  idempotencyKeyHash,
  idempotencyRequestHash,
  newSessionId,
  readPersistedMeta,
  readPersistedPreview,
  readPersistedQueue,
  readPersistedResult,
  readPersistedState,
} from "../src/persistence";
import { PersistedSession } from "../src/recovery";
import {
  BridgeSession,
  buildHarnessArgv,
  isTerminalMessageState,
  type AcpTransport,
  type MessageStatus,
  type SessionStatus,
} from "../src/session";

// --- mock ACP transport ------------------------------------------------------

interface MockInteractionPlan {
  requestId: string;
  permission: boolean;
  options?: Array<Record<string, unknown>>;
  schema?: Record<string, unknown>;
}

interface MockTurnPlan {
  chunks?: string[];
  interaction?: MockInteractionPlan;
  stopReason?: string;
  toolCalls?: Array<Record<string, unknown>>;
  /** When true the turn stays in flight until `finishTurn()` or `cancelTurn()`. */
  hold?: boolean;
  /**
   * When true `cancelTurn()` leaves the turn in flight, simulating a harness that ignores
   * `session/cancel` and never settles the `session/prompt` request.
   */
  ignoreCancel?: boolean;
}

class MockTransport extends EventEmitter implements AcpTransport {
  plans: MockTurnPlan[] = [];
  prompts: string[] = [];
  respondCalls: Array<{ requestId: string; response: unknown; answer?: InteractionAnswer }> = [];
  authenticateCalls: string[] = [];
  cancelCount = 0;
  closeCount = 0;
  authMethodList: Array<Record<string, unknown>> = [];
  /** Account object returned by the CodeBuddy auth-status probe. */
  authUserInfo: Record<string, unknown> | null = null;
  configuredModelList = [{ id: "fake-model", name: "Fake Model" }];
  /** Model-specific ACP options advertised by the harness; `null` means none advertised. */
  configOptionsList: Array<Record<string, unknown>> | null = null;
  /** Raw ACP requests the adapters issued (mode selection, auth probes). */
  requestCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Optional supervisor metadata (pids, container id) for docker-launch tests. */
  supervisorInfo: (() => Record<string, unknown>) | undefined = undefined;

  private active = false;
  private currentSessionId: string | null = null;
  private turn = false;
  private preview = "";
  private currentModel: string | null = null;
  private currentModelName: string | null = null;
  /** Mirrors the harness login state: true once `authenticate` has been called. */
  private loggedIn = false;
  private pending: {
    requestId: string;
    permission: boolean;
    options: Array<Record<string, unknown>>;
    schema: Record<string, unknown> | null;
  } | null = null;
  private queuedEvent: AcpTurnEvent | null = null;
  private waiter: { resolve: (event: AcpTurnEvent) => void; timer?: ReturnType<typeof setTimeout> } | null =
    null;
  private currentPlan: MockTurnPlan | null = null;

  get running(): boolean {
    return this.active;
  }
  get sessionId(): string | null {
    return this.currentSessionId;
  }
  get modelId(): string | null {
    return this.currentModel;
  }
  get modelName(): string | null {
    return this.currentModelName;
  }
  get turnActive(): boolean {
    return this.turn;
  }
  get previewText(): string {
    return this.preview;
  }

  async start(): Promise<unknown> {
    this.active = true;
    return { result: { protocolVersion: 1 } };
  }
  authMethods(): Array<Record<string, unknown>> {
    return this.authMethodList;
  }
  async authenticate(methodId: string): Promise<unknown> {
    this.authenticateCalls.push(methodId);
    this.loggedIn = true;
    return { result: {} };
  }
  async openSession(): Promise<string> {
    this.currentSessionId = "harness-session-1";
    return "harness-session-1";
  }
  async setModel(modelId: string): Promise<void> {
    this.currentModel = modelId;
    this.currentModelName = modelId;
  }
  listModels() {
    return this.configuredModelList;
  }
  toolCallSummaries(): Array<Record<string, unknown>> {
    return [];
  }
  initializeResponseMessage(): Record<string, unknown> {
    return { result: { protocolVersion: 1, authMethods: this.authMethodList } };
  }
  configOptions(): Array<Record<string, unknown>> | null {
    return this.configOptionsList;
  }
  /** Mirrors the ACP transport: adapters use this for mode selection and auth probing. */
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requestCalls.push({ method, params });
    if (method === "authenticate") {
      this.loggedIn = true;
      return { result: {} };
    }
    if (method === "session/set_config_option" || method === "session/set_mode") {
      return { result: {} };
    }
    if (method === "_codebuddy.ai/getUserInfo") {
      const user =
        this.authUserInfo ??
        (this.loggedIn ? { userId: "u1", email: "user@example.com", name: "Mock User" } : {});
      return { result: { userInfo: user } };
    }
    const error = new Error(`unknown method ${method}`) as Error & { code: number };
    error.code = -32601;
    throw error;
  }

  async beginTurn(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    this.preview = "";
    this.turn = true;
    const plan = this.plans.shift() ?? {};
    this.currentPlan = plan;
    for (const chunk of plan.chunks ?? []) {
      this.preview += chunk;
      this.emit("sessionUpdate", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
    }
    if (plan.interaction) {
      const options =
        plan.interaction.options ?? [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
      this.pending = {
        requestId: plan.interaction.requestId,
        permission: plan.interaction.permission,
        options,
        schema: plan.interaction.schema ?? null,
      };
      this.deliver({
        kind: "interaction",
        interaction: {
          rpcId: 1,
          requestId: plan.interaction.requestId,
          permission: plan.interaction.permission,
          sessionId: this.currentSessionId ?? "",
          title: "Request",
          message: "Please confirm",
          options,
          schema: plan.interaction.schema ?? null,
          defaults: null,
          responseStyle: "content",
          rawInput: {},
          meta: {},
        },
      });
    } else if (!plan.hold) {
      this.deliver(this.completeEvent(plan));
    }
  }

  waitForTurnEvent(timeoutMs: number): Promise<AcpTurnEvent> {
    if (this.queuedEvent) {
      const event = this.queuedEvent;
      this.queuedEvent = null;
      return Promise.resolve(event);
    }
    return new Promise<AcpTurnEvent>((resolve, reject) => {
      const entry = { resolve, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      entry.timer = setTimeout(() => {
        if (this.waiter === entry) {
          this.waiter = null;
          reject(new Error("mock turn timeout"));
        }
      }, timeoutMs);
      if (typeof entry.timer.unref === "function") entry.timer.unref();
      this.waiter = entry;
    });
  }

  async respondInteraction(
    requestId: string,
    response: unknown,
    answer: InteractionAnswer = "accept",
  ): Promise<boolean> {
    const pending = this.pending;
    if (!pending) throw new Error("no pending interaction");
    if (pending.requestId !== requestId) throw new Error("request id mismatch");
    let harnessCancelled = false;
    if (answer === "accept") {
      if (pending.permission) {
        const option = (response as { option_id?: unknown }).option_id;
        const valid = pending.options
          .map((entry) => entry.optionId)
          .filter((value): value is string => typeof value === "string");
        if (typeof option !== "string" || !valid.includes(option)) throw new Error("unknown option");
      }
      this.respondCalls.push({ requestId, response });
    } else if (pending.permission) {
      // Mirrors AcpClient.respondInteraction: reject prefers a reject/deny option, otherwise
      // (and always for timeout/cancel) the harness sees the cancelled outcome.
      const rejectOption =
        answer === "reject"
          ? pending.options.find((entry) => {
              const kind = String(entry.kind ?? "").toLowerCase();
              const name = String(entry.name ?? "").toLowerCase();
              return (
                typeof entry.optionId === "string" &&
                (kind.startsWith("reject") || name.includes("deny") || entry.optionId.toLowerCase().includes("reject"))
              );
            })?.optionId
          : undefined;
      harnessCancelled = typeof rejectOption !== "string";
      this.respondCalls.push({ requestId, response, answer });
    } else {
      // A plain information request has no protocol decline/cancel; the caller cancels the turn.
      return false;
    }
    this.pending = null;
    this.deliver(
      this.completeEvent(
        harnessCancelled ? { ...(this.currentPlan ?? {}), stopReason: "cancelled" } : (this.currentPlan ?? {}),
      ),
    );
    return true;
  }

  async cancelTurn(): Promise<void> {
    this.cancelCount += 1;
    this.pending = null;
    if (this.currentPlan?.ignoreCancel) return;
    if (this.turn) {
      this.turn = false;
      this.deliver({
        kind: "complete",
        result: {
          status: "cancelled",
          text: this.preview,
          stopReason: "cancelled",
          toolCalls: [],
          harnessSessionId: this.currentSessionId,
        },
      });
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.active = false;
    this.turn = false;
    this.waiter = null;
    this.queuedEvent = null;
  }

  /** Test helper: complete a held turn. */
  finishTurn(stopReason = "end_turn"): void {
    if (!this.turn) return;
    this.turn = false;
    this.deliver(this.completeEvent({ ...(this.currentPlan ?? {}), stopReason }));
  }

  /** Test helper: simulate the harness process dying outside a normal close. */
  simulateTransportGone(): void {
    this.active = false;
    this.emit("exit");
  }

  private completeEvent(plan: MockTurnPlan): AcpTurnEvent {
    return {
      kind: "complete",
      result: {
        status: plan.stopReason === "cancelled" ? "cancelled" : "completed",
        text: this.preview,
        stopReason: plan.stopReason ?? "end_turn",
        toolCalls: plan.toolCalls ?? [],
        harnessSessionId: this.currentSessionId,
      },
    };
  }

  private deliver(event: AcpTurnEvent): void {
    if (event.kind === "complete") this.turn = false;
    const entry = this.waiter;
    if (entry) {
      this.waiter = null;
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(event);
      return;
    }
    this.queuedEvent = event;
  }
}

// --- helpers -----------------------------------------------------------------

const cleanups: Array<() => void> = [];
const openSessions: BridgeSession[] = [];

afterEach(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close().catch(() => undefined);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configText(previewBytes = 64): string {
  return `schema_version: 1
default_harness: codebuddy
buffers:
  preview_bytes: ${previewBytes}
harnesses:
  codebuddy:
    command: fake-acp
    args: []
    models:
      - id: fake-model
        name: Fake Model
        thinking_levels: [low, high]
      - id: fake-model-2
        name: Fake Model 2
        thinking_levels: [low]
`;
}

function writeConfig(dir: string, text = configText()): BridgeConfig {
  const path = join(dir, "config.yaml");
  writeFileSync(path, text);
  return loadConfig(path);
}

async function newSession(
  options: {
    previewBytes?: number;
    plans?: MockTurnPlan[];
    baseDir?: string;
    authMethodList?: Array<Record<string, unknown>>;
  } = {},
): Promise<{ dir: string; config: BridgeConfig; transport: MockTransport; session: BridgeSession }> {
  const dir = tmpDir("hab-session-");
  const config = writeConfig(dir, configText(options.previewBytes ?? 64));
  const transport = new MockTransport();
  transport.plans = options.plans ?? [];
  if (options.authMethodList) transport.authMethodList = options.authMethodList;
  const session = await BridgeSession.create({
    config,
    harness: "codebuddy",
    cwd: dir,
    modelId: "fake-model",
    baseDir: options.baseDir ?? join(dir, "sessions"),
    transport,
  });
  openSessions.push(session);
  return { dir, config, transport, session };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function statusOf(session: BridgeSession, messageId: string): MessageStatus {
  return session.messageResult(messageId) as MessageStatus;
}

function sessionState(session: BridgeSession): SessionStatus {
  return session.status() as SessionStatus;
}

// --- session directory defaults ----------------------------------------------

describe("session directory defaults", () => {
  it("defaults agy yolo to its native ACP mode and accepts an explicit override", () => {
    const dir = tmpDir("hab-agy-mode-");
    expect(writeConfig(dir).launch.agyModeIds.yolo).toBe("yolo");
    expect(writeConfig(dir, `${configText()}\nlaunch:\n  agy_yolo_mode_id: custom-yolo\n`)
      .launch.agyModeIds.yolo).toBe("custom-yolo");
  });

  it("defaults the base dir to ~/.harness-acp-bridge (not an XDG sessions/ subtree)", () => {
    const dir = tmpDir("hab-defaults-");
    const config = writeConfig(dir);
    expect(config.paths.stateDir).toBe(defaultStateDirectory());
    expect(config.paths.sessionDir).toBe(defaultStateDirectory());
    expect(config.paths.stateDir).not.toContain("/.local/state");
  });

  it("names session directories <date>-<random>", async () => {
    const { session, dir } = await newSession();
    expect(basename(session.directory)).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(basename(session.directory)).toBe(session.sessionId);
    expect(dirname(session.directory)).toBe(join(dir, "sessions"));
  });

  it("creates the session under ~/.harness-acp-bridge when no base dir is given", async () => {
    const dir = tmpDir("hab-default-home-");
    const config = writeConfig(dir);
    const session = await BridgeSession.create({
      config,
      harness: "codebuddy",
      cwd: dir,
      modelId: "fake-model",
      transport: new MockTransport(),
    });
    openSessions.push(session);
    cleanups.push(() => rmSync(session.directory, { recursive: true, force: true }));
    expect(dirname(session.directory)).toBe(defaultStateDirectory());
  });
});

// --- persistence -------------------------------------------------------------

describe("persistence", () => {
  it("writes meta, state, queue and a human-readable log", async () => {
    const { session } = await newSession();
    const meta = readPersistedMeta(session.directory)!;
    expect(meta.params).toMatchObject({
      harness: "codebuddy",
      model_id: "fake-model",
      runtime: "direct",
      target: "local",
    });
    expect((meta.echo as Record<string, unknown>).command).toBe("fake-acp");
    expect((meta.echo as Record<string, unknown>).harness_session_id).toBe("harness-session-1");

    expect(readPersistedState(session.directory)).toMatchObject({ state: "ready", authenticated: true });
    expect(readPersistedQueue(session.directory)!.messages).toEqual({});

    const log = readFileSync(join(session.directory, "log.txt"), "utf8");
    expect(log).toContain("session created");
    expect(log).toContain("session ready");
  });

  it("reports a persisted steering message's mode as steering, not queue", async () => {
    const { session, dir } = await newSession();
    const persistedId = "msg-steered-persisted";
    const resultId = "msg-steered-result";
    writeFileSync(
      join(session.directory, QUEUE_FILE),
      JSON.stringify({
        messages: {
          [persistedId]: {
            message_id: persistedId,
            mode: "steering",
            state: "completed",
            seq: 1,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    writeFileSync(
      join(session.directory, RESULTS_DIR, `${resultId}.json`),
      JSON.stringify({
        message_id: resultId,
        mode: "steering",
        state: "completed",
        seq: 2,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    // A message the live session no longer holds in memory falls back to its result snapshot;
    // a `steering` message must never be reported back as `queue`.
    expect(session.messageResult(resultId).mode).toBe("steering");

    // The read-only recovery reader reconciles a persisted entry the same way.
    const view = PersistedSession.open(join(dir, "sessions"), session.sessionId);
    expect(view).not.toBeNull();
    expect(view!.messageResult(persistedId)!.mode).toBe("steering");
  });

  it("redacts creation params and the echo before they hit disk", async () => {
    const dir = tmpDir("hab-redact-");
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `schema_version: 1
default_harness: codebuddy
harnesses:
  codebuddy:
    command: fake-acp
    env:
      SERVICE_TOKEN: super-secret-value
    models:
      - id: fake-model
`,
    );
    const session = await BridgeSession.create({
      config: loadConfig(path),
      harness: "codebuddy",
      cwd: dir,
      modelId: "fake-model",
      baseDir: join(dir, "sessions"),
      transport: new MockTransport(),
    });
    openSessions.push(session);

    const raw = readFileSync(join(session.directory, "meta.json"), "utf8");
    expect(raw).not.toContain("super-secret-value");
    expect(raw).toContain("[redacted]");
    expect((JSON.parse(raw).echo as Record<string, unknown>).env).toEqual({
      SERVICE_TOKEN: "[redacted]",
    });
  });

  it("keeps the raw stream append-only and the snapshots atomic", async () => {
    const dir = tmpDir("hab-raw-");
    const recorder = new SessionRecorder({ rootDir: dir, sessionId: newSessionId(), previewBytes: 32 });
    recorder.appendRaw("stdout", { accessToken: "secret-token", ok: true });
    recorder.appendRaw("client", { prompt: "hi" });
    recorder.appendLog("hello log");
    recorder.writeState({ state: "ready", token: "abc" });
    recorder.writeResult("msg-1", { message_id: "msg-1", state: "completed", text: "done", token: "xyz" });
    await recorder.flush();
    await recorder.close();

    const lines = readFileSync(recorder.rawPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[redacted]");
    expect(lines[0]).not.toContain("secret-token");
    expect(JSON.parse(lines[0]).stream).toBe("stdout");
    expect(lines[1]).toContain('"prompt":"hi"');

    expect(readFileSync(recorder.logPath, "utf8")).toContain("hello log");
    expect(JSON.parse(readFileSync(recorder.statePath, "utf8")).token).toBe("[redacted]");
    const result = JSON.parse(readFileSync(join(recorder.resultsDir, "msg-1.json"), "utf8"));
    expect(result.token).toBe("[redacted]");
    expect(result.text).toBe("done");
    expect(readdirSync(recorder.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("caps preview.txt size while appending incrementally", async () => {
    const dir = tmpDir("hab-preview-");
    const recorder = new SessionRecorder({ rootDir: dir, sessionId: newSessionId(), previewBytes: 24 });
    for (let index = 0; index < 6; index += 1) {
      recorder.appendPreview(`chunk${index}-`);
      // Visible on disk immediately so a live_output follower can tail it.
      expect(statSync(recorder.previewPath).size).toBeGreaterThan(0);
    }
    await recorder.close();
    expect(statSync(recorder.previewPath).size).toBeLessThanOrEqual(24);
    expect(recorder.previewText().endsWith("chunk5-")).toBe(true);
  });
});

// --- queue -------------------------------------------------------------------

describe("BridgeSession one message at a time", () => {
  it("returns only a message_id and accepts a new message once the previous is terminal", async () => {
    const { session, transport } = await newSession({
      plans: [{ chunks: ["one-done"] }, { chunks: ["two-done"] }],
    });

    const first = session.sendMessage("one");
    expect(Object.keys(first)).toEqual(["message_id"]);
    // A second submit while the first is non-terminal is refused.
    expect(() => session.sendMessage("two", { mode: "queue" })).toThrow(/busy/);

    await waitUntil(() => statusOf(session, first.message_id).terminal);
    expect(statusOf(session, first.message_id).state).toBe("completed");
    expect(statusOf(session, first.message_id).result_available).toBe(true);
    expect(session.messageResult(first.message_id).text).toBe("one-done");

    const second = session.sendMessage("two", { mode: "queue" });
    await waitUntil(() => statusOf(session, second.message_id).terminal);
    expect(session.messageResult(second.message_id).text).toBe("two-done");
    expect(transport.prompts).toEqual(["one", "two"]);
  });

  it("rejects a concurrent submit with busy and persists no extra record", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true, chunks: ["partial"] }] });

    const first = session.sendMessage("first");
    await waitUntil(() => statusOf(session, first.message_id).state === "running");

    let code = "";
    try {
      session.sendMessage("second");
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    expect(code).toBe("busy");
    // No steering, no queued record, and no interruption of the running message.
    expect(transport.cancelCount).toBe(0);
    expect(transport.prompts).toEqual(["first"]);
    expect(sessionState(session).messages_total).toBe(1);
    expect(sessionState(session).queued_message_ids).toEqual([]);
    const queue = JSON.parse(readFileSync(join(session.directory, QUEUE_FILE), "utf8"));
    expect(Object.keys(queue.messages)).toEqual([first.message_id]);
    session.cancelMessage(first.message_id);
  });

  it("accepts 'steer' as a documented alias for the steering mode", async () => {
    const { session, transport } = await newSession({ plans: [{ chunks: ["done"] }] });
    const first = session.sendMessage("a", { mode: "steer" });
    await waitUntil(() => statusOf(session, first.message_id).terminal);
    expect(statusOf(session, first.message_id).mode).toBe("steering");
    expect(transport.prompts).toEqual(["a"]);
  });

  it("rejects an unknown mode", async () => {
    const { session } = await newSession();
    expect(() => session.sendMessage("x", { mode: "later" as never })).toThrow(/steering/);
  });
});

// --- idempotency -------------------------------------------------------------

describe("BridgeSession idempotency", () => {
  it("replays the original message_id while it is still non-terminal", async () => {
    const { session, transport } = await newSession({
      plans: [{ hold: true, chunks: ["first-partial"] }],
    });

    const first = session.sendMessage("first", { mode: "queue", idempotencyKey: "k-first" });
    await waitUntil(() => statusOf(session, first.message_id).state === "running");

    // The same key + same text/mode resolves before the busy guard, so it is a safe retry even
    // while the message runs: no new message, no extra prompt, no interruption.
    const replay = session.sendMessage("first", { mode: "queue", idempotencyKey: "k-first" });
    expect(replay).toEqual(first);
    expect(transport.prompts).toEqual(["first"]);
    expect(statusOf(session, first.message_id).state).toBe("running");
    expect(statusOf(session, first.message_id).cancellable).toBe(true);
    expect(sessionState(session).messages_total).toBe(1);
    expect(sessionState(session).queued_message_ids).toEqual([]);
    session.cancelMessage(first.message_id);
  });

  it("conflicts when the same key is reused with different text or mode", async () => {
    const { session } = await newSession({ plans: [{ chunks: ["one"] }] });
    const original = session.sendMessage("one", { mode: "queue", idempotencyKey: "k" });
    await waitUntil(() => statusOf(session, original.message_id).terminal);
    expect(session.sendMessage("one", { mode: "queue", idempotencyKey: "k" })).toEqual(original);

    let code = "";
    try {
      session.sendMessage("two", { mode: "queue", idempotencyKey: "k" });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    expect(code).toBe("idempotency_conflict");
    expect(() => session.sendMessage("one", { mode: "steering", idempotencyKey: "k" })).toThrow(
      /idempotency/,
    );
    expect(() => session.sendMessage("one", { mode: "steer", idempotencyKey: "k" })).toThrow(
      /idempotency/,
    );
    // A conflicting send is never enqueued.
    expect(sessionState(session).messages_total).toBe(1);
  });

  it("normalizes the mode alias before comparing keyed requests", async () => {
    const { session } = await newSession({ plans: [{ hold: true, chunks: ["x"] }] });
    const first = session.sendMessage("x", { mode: "steer", idempotencyKey: "k" });
    expect(session.sendMessage("x", { mode: "steering", idempotencyKey: "k" })).toEqual(first);
    expect(() => session.sendMessage("x", { mode: "queue", idempotencyKey: "k" })).toThrow(
      /idempotency/,
    );
    session.cancelMessage(first.message_id);
  });

  it("keeps unkeyed sends independent and validates the key", async () => {
    const { session, transport } = await newSession({ plans: [{ chunks: ["a"] }, { chunks: ["b"] }] });
    const one = session.sendMessage("same");
    await waitUntil(() => statusOf(session, one.message_id).terminal);
    const two = session.sendMessage("same");
    expect(one.message_id).not.toBe(two.message_id);
    await waitUntil(() => statusOf(session, two.message_id).terminal);
    expect(transport.prompts).toEqual(["same", "same"]);

    expect(() => session.sendMessage("x", { idempotencyKey: "" })).toThrow(/idempotency_key/);
    expect(() => session.sendMessage("x", { idempotencyKey: "a".repeat(513) })).toThrow(
      /idempotency_key/,
    );
    expect(() => session.sendMessage("x", { idempotencyKey: 42 as never })).toThrow(
      /idempotency_key/,
    );
  });

  it("scopes the index to one session and commits message + mapping in the queue snapshot", async () => {
    const { session, dir } = await newSession({ plans: [{ chunks: ["one"] }] });
    const other = await newSession({ plans: [{ chunks: ["one"] }] });
    const key = "shared-key";
    const text = "top-secret-prompt";

    const mine = session.sendMessage(text, { mode: "queue", idempotencyKey: key });
    const theirs = other.session.sendMessage(text, { mode: "queue", idempotencyKey: key });
    // The same key in a different session is a different identity.
    expect(mine.message_id).not.toBe(theirs.message_id);

    await waitUntil(
      () => statusOf(session, mine.message_id).terminal && statusOf(other.session, theirs.message_id).terminal,
    );
    await session.close();

    // The mapping lives in the queue snapshot, not a separate file, and is opaque: neither
    // the raw key nor the prompt text is stored.
    expect(existsSync(join(session.directory, IDEMPOTENCY_FILE))).toBe(false);
    const raw = readFileSync(join(session.directory, QUEUE_FILE), "utf8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(text);
    expect(raw).toContain(mine.message_id);
    expect(
      Object.keys((readPersistedQueue(session.directory)?.idempotency as Record<string, unknown>) ?? {}),
    ).toHaveLength(1);

    // The read-only recovery reader resolves the key from the queue snapshot alone.
    const view = PersistedSession.open(join(dir, "sessions"), session.sessionId);
    expect(view).not.toBeNull();
    const record = view!.idempotencyEntry(idempotencyKeyHash(key));
    expect(record?.message_id).toBe(mine.message_id);
    expect(record?.request_hash).toBe(idempotencyRequestHash("queue", text));
    expect(view!.idempotencyEntry(idempotencyKeyHash("other"))).toBeNull();
  });

  it("reads a legacy standalone index for a session written by the earlier layout", () => {
    const dir = tmpDir("hab-legacy-");
    const sessionDir = join(dir, "sessions", "legacy-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({ state: "closed" }));
    writeFileSync(join(sessionDir, "queue.json"), JSON.stringify({ messages: {} }));
    const token = idempotencyKeyHash("old-key");
    writeFileSync(
      join(sessionDir, IDEMPOTENCY_FILE),
      JSON.stringify({
        [token]: { message_id: "m-legacy", request_hash: idempotencyRequestHash("queue", "t"), created_at: "" },
      }),
    );
    const view = PersistedSession.open(join(dir, "sessions"), "legacy-1");
    expect(view).not.toBeNull();
    expect(view!.idempotencyEntry(token)?.message_id).toBe("m-legacy");
  });

  it("rolls back a submission whose atomic commit fails, so a retry is a fresh submit", async () => {
    const { session, transport } = await newSession({ plans: [{ chunks: ["ok"] }] });
    // Fault injection: make the queue snapshot (the atomic commit) unwritable by planting a
    // directory at its path — the temp-file rename onto a directory always fails.
    const queuePath = join(session.directory, QUEUE_FILE);
    rmSync(queuePath, { force: true });
    mkdirSync(queuePath);

    expect(() => session.sendMessage("first", { mode: "queue", idempotencyKey: "k" })).toThrow();
    // Nothing was committed: no message, no turn, no mapping.
    expect(sessionState(session).messages_total).toBe(0);
    expect(sessionState(session).queued_message_ids).toEqual([]);
    expect(transport.prompts).toEqual([]);

    // Clear the fault: the retry is treated as new (never a false replay) and commits once.
    rmSync(queuePath, { recursive: true, force: true });
    const sent = session.sendMessage("first", { mode: "queue", idempotencyKey: "k" });
    await waitUntil(() => statusOf(session, sent.message_id).terminal);
    expect(transport.prompts).toEqual(["first"]);
    expect(sessionState(session).messages_total).toBe(1);
  });

  it("rejects a submit while a message is running before any persistence side effect", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true, chunks: ["partial"] }] });
    const running = session.sendMessage("HOLD base", { mode: "queue" });
    await waitUntil(() => statusOf(session, running.message_id).state === "running");

    // The busy guard fires before the atomic commit, so even an unwritable queue snapshot
    // changes nothing: the running turn is never interrupted and no record is written.
    const queuePath = join(session.directory, QUEUE_FILE);
    rmSync(queuePath, { force: true });
    mkdirSync(queuePath);
    expect(() => session.sendMessage("new work", { idempotencyKey: "k" })).toThrow(/busy/);
    rmSync(queuePath, { recursive: true, force: true });

    expect(statusOf(session, running.message_id).state).toBe("running");
    expect(transport.cancelCount).toBe(0);
    expect(transport.prompts).toEqual(["HOLD base"]);
    expect(sessionState(session).messages_total).toBe(1);
    session.cancelMessage(running.message_id);
  });
});

// --- interactions ------------------------------------------------------------

describe("BridgeSession interactions", () => {
  it("exposes waiting_input and validates request_id and option", async () => {
    const { session, transport } = await newSession({
      plans: [
        {
          chunks: ["thinking"],
          interaction: {
            requestId: "req-1",
            permission: true,
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        },
      ],
    });

    const message = session.sendMessage("go");
    await waitUntil(() => statusOf(session, message.message_id).state === "waiting_input");
    const waiting = statusOf(session, message.message_id);
    expect(waiting.terminal).toBe(false);
    expect(waiting.cancellable).toBe(true);
    expect(waiting.interaction?.request_id).toBe("req-1");
    expect(waiting.interaction?.permission).toBe(true);
    expect(session.messageResult(message.message_id).terminal).toBe(false);
    expect(session.messageResult(message.message_id)).not.toHaveProperty("text");

    await expect(
      session.answerQuestion(message.message_id, "wrong-id", { option_id: "allow" }),
    ).rejects.toThrow(/request_id/);
    await expect(
      session.answerQuestion(message.message_id, "req-1", { option_id: "nope" }),
    ).rejects.toThrow(/option_id/);
    await expect(session.answerQuestion(message.message_id, "req-1", {})).rejects.toThrow(/option_id/);

    const answered = await session.answerQuestion(message.message_id, "req-1", { option_id: "allow" });
    expect(answered).toEqual({ message_id: message.message_id, request_id: "req-1", accepted: true });
    expect(transport.respondCalls).toEqual([{ requestId: "req-1", response: { option_id: "allow" } }]);

    await waitUntil(() => statusOf(session, message.message_id).terminal);
    expect(statusOf(session, message.message_id).state).toBe("completed");
    expect(session.messageResult(message.message_id).text).toBe("thinking");
  });

  it("unifies information requests into interactions without the permission flag", async () => {
    const { session, transport } = await newSession({
      plans: [
        {
          chunks: ["thinking"],
          interaction: { requestId: "info-1", permission: false, schema: { type: "object" } },
        },
      ],
    });

    const message = session.sendMessage("go");
    await waitUntil(() => statusOf(session, message.message_id).state === "waiting_input");
    const waiting = statusOf(session, message.message_id);
    expect(waiting.interaction?.request_id).toBe("info-1");
    expect(waiting.interaction?.permission).toBe(false);

    // An information response is a plain object; a non-object is rejected.
    await expect(
      session.answerQuestion(message.message_id, "info-1", "not-an-object"),
    ).rejects.toThrow(/object/);

    const answered = await session.answerQuestion(message.message_id, "info-1", { value: "42" });
    expect(answered).toEqual({ message_id: message.message_id, request_id: "info-1", accepted: true });
    expect(transport.respondCalls).toEqual([{ requestId: "info-1", response: { value: "42" } }]);

    await waitUntil(() => statusOf(session, message.message_id).terminal);
    expect(statusOf(session, message.message_id).state).toBe("completed");
  });

  it("routes a reject answer for a permission request to an offered deny option", async () => {
    const { session, transport } = await newSession({
      plans: [
        {
          chunks: ["thinking"],
          interaction: {
            requestId: "req-1",
            permission: true,
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        },
      ],
    });

    const message = session.sendMessage("go");
    await waitUntil(() => statusOf(session, message.message_id).state === "waiting_input");

    await expect(
      session.answerQuestion(message.message_id, "req-1", {}, { answer: "later" as never }),
    ).rejects.toThrow(/answer/);

    const answered = await session.answerQuestion(message.message_id, "req-1", {}, { answer: "reject" });
    expect(answered).toEqual({ message_id: message.message_id, request_id: "req-1", accepted: true });
    // reject/timeout carry no payload; the ACP layer derives the outcome from the interaction.
    expect(transport.respondCalls).toEqual([{ requestId: "req-1", response: {}, answer: "reject" }]);

    await waitUntil(() => statusOf(session, message.message_id).terminal);
    expect(statusOf(session, message.message_id).state).toBe("completed");
  });

  it("routes timeout and cancel answers for a permission request to the cancelled outcome", async () => {
    for (const answer of ["timeout", "cancel"] as const) {
      const { session, transport } = await newSession({
        plans: [
          {
            chunks: ["thinking"],
            interaction: {
              requestId: "req-1",
              permission: true,
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            },
          },
        ],
      });

      const message = session.sendMessage("go");
      await waitUntil(() => statusOf(session, message.message_id).state === "waiting_input");
      const answered = await session.answerQuestion(message.message_id, "req-1", undefined, { answer });
      expect(answered).toEqual({ message_id: message.message_id, request_id: "req-1", accepted: true });
      // cancel/timeout carry no payload and never select the offered deny option.
      expect(transport.respondCalls).toEqual([{ requestId: "req-1", response: {}, answer }]);

      await waitUntil(() => statusOf(session, message.message_id).terminal);
      expect(statusOf(session, message.message_id).state).toBe("cancelled");
    }
  });

  it("cancels the turn when an information request is rejected, times out, or is cancelled", async () => {
    const reasons: Record<string, string> = {
      reject: "rejected",
      timeout: "interaction_timeout",
      cancel: "user_cancel",
    };
    for (const answer of ["reject", "timeout", "cancel"] as const) {
      const { session } = await newSession({
        plans: [
          {
            chunks: ["thinking"],
            interaction: { requestId: "info-1", permission: false, schema: { type: "object" } },
          },
        ],
      });

      const message = session.sendMessage("go");
      await waitUntil(() => statusOf(session, message.message_id).state === "waiting_input");
      const answered = await session.answerQuestion(message.message_id, "info-1", undefined, { answer });
      expect(answered).toEqual({ message_id: message.message_id, request_id: "info-1", accepted: true });

      await waitUntil(() => statusOf(session, message.message_id).terminal);
      const status = statusOf(session, message.message_id);
      expect(status.state).toBe("cancelled");
      expect(status.cancel_reason).toBe(reasons[answer]);
    }
  });
});

// --- cancellation ------------------------------------------------------------

describe("BridgeSession cancellation", () => {
  it("cancels a running message", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true, chunks: ["running"] }] });

    const running = session.sendMessage("running");
    await waitUntil(() => statusOf(session, running.message_id).state === "running");

    const cancelled = session.cancelMessage(running.message_id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.cancel_reason).toBe("user_cancel");
    expect(cancelled.terminal).toBe(true);
    await waitUntil(() => sessionState(session).running_message_id === null);
    expect(statusOf(session, running.message_id).state).toBe("cancelled");
    // Cancelling a terminal message is a no-op.
    expect(session.cancelMessage(running.message_id).state).toBe("cancelled");
    expect(transport.cancelCount).toBeGreaterThanOrEqual(1);
  });

  it("cancels a message that is waiting for an answer", async () => {
    const { session } = await newSession({
      plans: [{ chunks: ["thinking"], interaction: { requestId: "req-1", permission: true } }],
    });
    const message = session.sendMessage("go");
    await waitUntil(() => statusOf(session, message.message_id).state === "waiting_input");

    const cancelled = session.cancelMessage(message.message_id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.cancel_reason).toBe("user_cancel");
    await waitUntil(() => sessionState(session).running_message_id === null);
  });
});

// --- results after close / restart ------------------------------------------

describe("BridgeSession results after close and restart", () => {
  it("distinguishes terminal states and keeps results readable after close", async () => {
    const { session } = await newSession({ plans: [{ chunks: ["answer"] }] });
    const message = session.sendMessage("hello");
    await waitUntil(() => statusOf(session, message.message_id).terminal);

    const dir = session.directory;
    await session.close();
    expect(session.isClosed).toBe(true);

    // In-memory reads still work after close.
    expect(session.messageResult(message.message_id).text).toBe("answer");

    // Persisted reads work as if from a restarted process.
    expect(readPersistedState(dir)!.state).toBe("closed");
    const result = readPersistedResult(dir, message.message_id)!;
    expect(result.state).toBe("completed");
    expect(result.text).toBe("answer");
    const queue = readPersistedQueue(dir)!;
    expect((queue.messages as Record<string, Record<string, unknown>>)[message.message_id].state).toBe(
      "completed",
    );
    expect((readPersistedMeta(dir)!.params as Record<string, unknown>).model_id).toBe("fake-model");
  });

  it("cancels an in-flight message on close and persists its result", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true, chunks: ["busy"] }] });
    const running = session.sendMessage("running");
    await waitUntil(() => statusOf(session, running.message_id).state === "running");

    const dir = session.directory;
    await session.close();

    expect(statusOf(session, running.message_id).state).toBe("cancelled");
    expect(statusOf(session, running.message_id).cancel_reason).toBe("session_closed");
    expect(readPersistedResult(dir, running.message_id)!.state).toBe("cancelled");
    expect(transport.closeCount).toBe(1);
    expect(readPersistedState(dir)!.state).toBe("closed");
    expect(() => session.sendMessage("too late")).toThrow(/closed/);
  });

  it("marks non-terminal messages clearly before they finish", async () => {
    const { session } = await newSession({ plans: [{ hold: true, chunks: ["slow"] }] });
    const message = session.sendMessage("slow");
    await waitUntil(() => statusOf(session, message.message_id).state === "running");
    const running = statusOf(session, message.message_id);
    expect(running.terminal).toBe(false);
    expect(isTerminalMessageState(running.state)).toBe(false);
    expect(running.result_available).toBe(false);
    expect(session.messageResult(message.message_id).terminal).toBe(false);
  });
});

// --- live output -------------------------------------------------------------

describe("BridgeSession live output", () => {
  it("streams preview chunks by offset and reports completion", async () => {
    const { session, transport } = await newSession({
      plans: [{ hold: true, chunks: ["hello ", "world"] }],
    });
    const message = session.sendMessage("go", { mode: "queue" });
    await waitUntil(() => statusOf(session, message.message_id).state === "running");

    const first = session.readOutput({ messageId: message.message_id });
    expect(first.chunk).toBe("hello world");
    expect(first.offset).toBe(0);
    expect(first.next_offset).toBe(11);
    expect(first.stopped).toBe(false);
    expect(first.terminal).toBe(false);

    // Nothing new has arrived yet.
    const empty = session.readOutput({ messageId: message.message_id, offset: first.next_offset });
    expect(empty.chunk).toBe("");
    expect(empty.stopped).toBe(false);

    transport.finishTurn();
    await waitUntil(() => statusOf(session, message.message_id).terminal);
    const final = session.readOutput({ messageId: message.message_id, offset: first.next_offset });
    expect(final.chunk).toBe("");
    expect(final.stopped).toBe(true);
    expect(final.terminal).toBe(true);
  });

  it("reports truncation when the offset falls behind the rolling window", async () => {
    const { session } = await newSession({
      previewBytes: 8,
      plans: [{ chunks: ["0123456789abcdef"] }],
    });
    const message = session.sendMessage("x", { mode: "queue" });
    await waitUntil(() => statusOf(session, message.message_id).terminal);

    const stale = session.readOutput({ messageId: message.message_id, offset: 0 });
    expect(stale.truncated).toBe(true);
    expect(stale.dropped_bytes).toBeGreaterThan(0);
    expect(stale.window_start).toBeGreaterThan(0);
    expect(stale.chunk).toBe("89abcdef");
    expect(stale.next_offset).toBeGreaterThan(stale.offset);

    const resumed = session.readOutput({ messageId: message.message_id, offset: stale.next_offset });
    expect(resumed.truncated).toBe(false);
    expect(resumed.chunk).toBe("");
    expect(resumed.stopped).toBe(true);
  });

  it("stops listening explicitly", async () => {
    const { session } = await newSession({ plans: [{ hold: true, chunks: ["abc"] }] });
    const message = session.sendMessage("x", { mode: "queue" });
    await waitUntil(() => statusOf(session, message.message_id).state === "running");
    const stopped = session.readOutput({ messageId: message.message_id, stop: true });
    expect(stopped.stopped).toBe(true);
    expect(stopped.chunk).toBe("");
  });

  it("rejects an unknown message id", async () => {
    const { session } = await newSession();
    expect(() => session.readOutput({ messageId: "msg-missing" })).toThrow(/unknown message/);
  });

  it("long-polls until output arrives", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true, chunks: [] }] });
    const message = session.sendMessage("x", { mode: "queue" });
    await waitUntil(() => statusOf(session, message.message_id).state === "running");

    const pending = session.listenOutput({ messageId: message.message_id, offset: 0, waitMs: 5000 });
    await sleep(60);
    transport.emit("sessionUpdate", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "late output" },
    });
    const output = await pending;
    expect(output.chunk).toBe("late output");
    expect(output.waited_ms).toBeGreaterThan(0);
    expect(output.waited_ms).toBeLessThan(5000);
    expect(output.stopped).toBe(false);
    session.cancelMessage(message.message_id);
  });

  it("returns after wait_ms when nothing new arrives", async () => {
    const { session } = await newSession({ plans: [{ hold: true, chunks: ["first"] }] });
    const message = session.sendMessage("x", { mode: "queue" });
    await waitUntil(() => statusOf(session, message.message_id).state === "running");

    const started = Date.now();
    const output = await session.listenOutput({ messageId: message.message_id, offset: 5, waitMs: 400 });
    expect(output.chunk).toBe("");
    expect(output.stopped).toBe(false);
    expect(output.waited_ms).toBeGreaterThanOrEqual(350);
    expect(Date.now() - started).toBeLessThan(3000);
    session.cancelMessage(message.message_id);
  });

  it("aborts a long-poll when the caller disconnects", async () => {
    const { session } = await newSession({ plans: [{ hold: true, chunks: [] }] });
    const message = session.sendMessage("x", { mode: "queue" });
    await waitUntil(() => statusOf(session, message.message_id).state === "running");

    const controller = new AbortController();
    const pending = session.listenOutput({
      messageId: message.message_id,
      offset: 0,
      waitMs: 10_000,
      signal: controller.signal,
    });
    await sleep(40);
    controller.abort();
    const output = await pending;
    expect(output.waited_ms).toBeLessThan(10_000);
    session.cancelMessage(message.message_id);
  });
});

// --- preview -----------------------------------------------------------------

describe("BridgeSession preview", () => {
  it("grows preview.txt during a held turn and stays within the cap", async () => {
    const { session, transport } = await newSession({
      previewBytes: 24,
      plans: [{ hold: true, chunks: ["live-output-", "more-output-"] }],
    });
    const message = session.sendMessage("stream");
    await waitUntil(() => statusOf(session, message.message_id).state === "running");

    // A follower can read the preview while the turn is still in flight.
    expect(readPersistedPreview(session.directory)).toContain("live-output-");
    expect(statSync(join(session.directory, "preview.txt")).size).toBeLessThanOrEqual(24);

    transport.finishTurn();
    await waitUntil(() => statusOf(session, message.message_id).terminal);
    expect(statSync(join(session.directory, "preview.txt")).size).toBeLessThanOrEqual(24);
  });
});

// --- lifecycle ---------------------------------------------------------------

describe("BridgeSession lifecycle", () => {
  it("applies authentication, opens a session, and sets the model", async () => {
    const { session, transport } = await newSession({ authMethodList: [{ id: "api-key" }] });
    // The auth probe found no reliable status endpoint, so login must be requested.
    expect(transport.requestCalls).toEqual([{ method: "_codebuddy.ai/getUserInfo", params: {} }]);
    expect(sessionState(session).state).toBe("authentication_required");
    expect(session.authenticated).toBe(false);

    await session.authenticate("api-key");
    expect(transport.requestCalls).toEqual([
      { method: "_codebuddy.ai/getUserInfo", params: {} },
      { method: "authenticate", params: { methodId: "api-key" } },
      { method: "_codebuddy.ai/getUserInfo", params: {} },
    ]);
    expect(sessionState(session).state).toBe("ready");
    expect(sessionState(session).authenticated).toBe(true);
    expect(session.harnessSessionId).toBe("harness-session-1");
    // CodeBuddy receives --model on argv, so the model is not re-sent over ACP.
    expect(session.modelId).toBe("fake-model");
    expect(transport.requestCalls.some((call) => call.method === "session/set_model")).toBe(false);
  });

  it("refreshes the latest whitelisted account and keeps credentials out of persisted state", async () => {
    const { session, transport } = await newSession({ authMethodList: [{ id: "api-key" }] });
    expect(sessionState(session).state).toBe("authentication_required");
    expect(session.isAuthenticated()).toBe(false);

    transport.authUserInfo = { userId: "u-9", email: "x@y.z", token: "secret-token", accessToken: "also-secret" };
    const info = await session.refreshAuthInfo();
    expect(info?.authenticated).toBe(true);
    expect(session.isAuthenticated()).toBe(true);
    // Only whitelisted identity fields survive; the credentials are dropped.
    expect(session.authInfo().user).toEqual({ userId: "u-9", email: "x@y.z" });

    // A transient probe that reports no account never revokes a working session.
    transport.authUserInfo = {};
    await session.refreshAuthInfo();
    expect(session.authInfo().user).toEqual({ userId: "u-9", email: "x@y.z" });

    await session.ensureReady();
    expect(session.state).toBe("ready");
    expect(session.harnessSessionId).toBe("harness-session-1");

    for (const name of ["meta.json", "state.json", "queue.json", "log.txt"]) {
      expect(readFileSync(join(session.directory, name), "utf8")).not.toContain("secret-token");
    }
  });

  it("hashes the authentication target so the ledger never names a harness or host", async () => {
    const { session } = await newSession();
    expect(session.authTargetKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(session.authTargetKey()).toBe(authTargetKey("codebuddy", "local", null));
    // The harness is part of the identity...
    expect(session.authTargetKey()).not.toBe(authTargetKey("codex", "local", null));
    // ...as is the ssh host for a remote target, while a local target ignores it.
    expect(authTargetKey("codebuddy", "local", "some-host")).toBe(authTargetKey("codebuddy", "local", null));
    expect(authTargetKey("codebuddy", "ssh", "host-a")).not.toBe(authTargetKey("codebuddy", "ssh", "host-b"));
    expect(authTargetKey("codebuddy", "ssh", "HOST-A")).toBe(authTargetKey("codebuddy", "ssh", "host-a"));
  });

  it("changes the model between turns but rejects it during a turn", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true }] });
    const status = await session.setModel("other-model");
    expect(status.model_id).toBe("other-model");
    expect(transport.modelId).toBe("other-model");

    const message = session.sendMessage("hold");
    await waitUntil(() => statusOf(session, message.message_id).state === "running");
    await expect(session.setModel("third-model")).rejects.toMatchObject({ code: "busy" });
    session.cancelMessage(message.message_id);
  });

  it("changes only the model when set_model is given no thinking level", async () => {
    const { session, transport } = await newSession();
    const status = await session.setModel("fake-model-2");
    expect(status.model_id).toBe("fake-model-2");
    expect(transport.modelId).toBe("fake-model-2");
    expect(transport.requestCalls.some((call) => call.method === "session/set_config_option")).toBe(false);
  });

  it("applies a declared thinking level to the new model after switching", async () => {
    const { session, transport } = await newSession();
    // fake-model-2 declares [low]; codebuddy routes the level through `thought_level`.
    const status = await session.setModel("fake-model-2", "low");
    expect(status.model_id).toBe("fake-model-2");
    const switches = transport.requestCalls.filter(
      (call) => call.method === "session/set_config_option",
    );
    expect(switches).toEqual([
      { method: "session/set_config_option", params: { sessionId: "harness-session-1", configId: "thought_level", value: "low" } },
    ]);
  });

  it("rejects a thinking level the configuration does not declare, leaving the model unchanged", async () => {
    const { session, transport } = await newSession();
    await expect(session.setModel("fake-model-2", "high")).rejects.toMatchObject({
      code: "invalid_thinking_level",
    });
    // Validation happens before the switch, so the session model and the harness are unchanged.
    expect(session.modelId).toBe("fake-model");
    expect(transport.requestCalls.some((call) => call.method === "session/set_config_option")).toBe(false);
  });

  it("still checks the new model's live ACP options after switching", async () => {
    const { session, transport } = await newSession();
    // The declaration permits "high", but the harness only advertises "low".
    transport.configOptionsList = [{ id: "thought_level", options: [{ value: "low" }] }];
    await expect(session.setModel("fake-model", "high")).rejects.toThrow(/not supported/);
  });

  it("rejects a create thinking_level the configuration does not declare", async () => {
    const dir = tmpDir("hab-thinking-");
    const config = writeConfig(dir);
    const transport = new MockTransport();
    await expect(
      BridgeSession.create({
        config,
        harness: "codebuddy",
        cwd: dir,
        modelId: "fake-model",
        thinkingLevel: "bogus",
        baseDir: join(dir, "sessions"),
        transport,
      }),
    ).rejects.toMatchObject({ code: "invalid_thinking_level" });
  });

  it("builds the managed codebuddy argv for local direct launch", () => {
    const harness: HarnessConfig = {
      name: "codebuddy",
      command: "codebuddy",
      args: ["--extra"],
      env: {},
      models: [],
      description: null,
    };
    const built = buildHarnessArgv(harness, { modelId: "m1", permissionMode: "read" });
    expect(built.command).toBe("codebuddy");
    expect(built.args).toEqual([
      "--extra",
      "--model",
      "m1",
      "--permission-mode",
      "plan",
      "--acp",
      "--acp-transport",
      "stdio",
    ]);
  });
});

// --- docker kept container id ------------------------------------------------

describe("kept container id", () => {
  async function newDockerSession(
    options: {
      runtime?: "direct" | "docker";
      dockerImage?: string | null;
      containerPolicy?: "remove" | "keep";
      supervisorInfo?: (() => Record<string, unknown>) | undefined;
    } = {},
  ): Promise<BridgeSession> {
    const dir = tmpDir("hab-docker-");
    const config = writeConfig(dir);
    const transport = new MockTransport();
    transport.supervisorInfo = options.supervisorInfo;
    const session = await BridgeSession.create({
      config,
      harness: "codebuddy",
      cwd: "/work",
      modelId: "fake-model",
      baseDir: join(dir, "sessions"),
      transport,
      runtime: options.runtime ?? "docker",
      dockerImage: options.dockerImage ?? "mock/image:1",
      containerPolicy: options.containerPolicy ?? "keep",
    });
    openSessions.push(session);
    return session;
  }

  it("returns the full id a kept container reports in the supervisor metadata", async () => {
    const containerId = "a".repeat(64);
    const session = await newDockerSession({
      supervisorInfo: () => ({ transport_pid: 100, docker_id: containerId }),
    });
    expect(session.keptContainerId()).toBe(containerId);
  });

  it("reports no id for a container that will be removed", async () => {
    const session = await newDockerSession({
      containerPolicy: "remove",
      supervisorInfo: () => ({ transport_pid: 100, docker_id: "a".repeat(64) }),
    });
    expect(session.keptContainerId()).toBeNull();

    const direct = await newDockerSession({
      runtime: "direct",
      dockerImage: null,
      containerPolicy: "keep",
      supervisorInfo: () => ({ transport_pid: 100, docker_id: "a".repeat(64) }),
    });
    expect(direct.keptContainerId()).toBeNull();
  });

  it("fails when a kept container's id is missing or malformed", async () => {
    for (const docker_id of [undefined, "short", "z".repeat(64)]) {
      const session = await newDockerSession({
        supervisorInfo: () => ({ transport_pid: 100, docker_id }),
      });
      expect(() => session.keptContainerId()).toThrow(/container ID is unavailable/);
    }
  });
});

// --- operation slot / turn settlement window ----------------------------------

describe("session operation state", () => {
  it("reports idle and accepting around a completed message", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true }] });
    expect(sessionState(session).operation).toBe("idle");
    const { message_id } = session.sendMessage("hello");
    expect(sessionState(session).operation).toBe("running");
    transport.finishTurn();
    await waitUntil(() => statusOf(session, message_id).terminal);
    expect(sessionState(session).operation).toBe("idle");
  });

  it("stays busy while a cancel is settling: message terminal but prompt unsettled", async () => {
    const { session, transport } = await newSession({ plans: [{ hold: true, ignoreCancel: true }] });
    const { message_id } = session.sendMessage("hello");
    await waitUntil(() => statusOf(session, message_id).state === "running");

    session.cancelMessage(message_id);
    // The message is terminal bridge-side, but the harness never settles the prompt
    // (ignoreCancel): the session must report `cancelling` and reject new work.
    expect(statusOf(session, message_id).terminal).toBe(true);
    expect(sessionState(session).operation).toBe("cancelling");
    expect(() => session.sendMessage("second")).toThrow(/busy/);
    await expect(session.setModel("fake-model-2")).rejects.toMatchObject({ code: "busy" });

    // The harness finally settles the old prompt: the slot returns to idle and the pump
    // finishes before a new message can start running.
    transport.finishTurn("cancelled");
    await waitUntil(() => sessionState(session).running_message_id === null);
    const second = session.sendMessage("second");
    await waitUntil(() => statusOf(session, second.message_id).state === "running");
    expect(statusOf(session, second.message_id).state).toBe("running");
  });

  it("rejects send_message while a model switch is in flight", async () => {
    const { session, transport } = await newSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (transport as unknown as { setModel: () => Promise<void> }).setModel = () => gate;

    const switching = session.setModel("fake-model-2");
    await waitUntil(() => sessionState(session).operation === "switching_model");
    expect(() => session.sendMessage("x")).toThrow(/busy/);
    await expect(session.setModel("fake-model")).rejects.toMatchObject({ code: "busy" });

    release();
    await switching;
    expect(sessionState(session).operation).toBe("idle");
    expect(sessionState(session).model_id).toBe("fake-model-2");
  });

  it("marks the session failed when the transport dies outside a normal close", async () => {
    const { session, transport } = await newSession();
    transport.simulateTransportGone();
    expect(sessionState(session).state).toBe("failed");
    expect(sessionState(session).operation).toBe("idle");
    expect(() => session.sendMessage("x")).toThrow(/no longer usable/);
    await expect(session.setModel("fake-model-2")).rejects.toMatchObject({ code: "session_failed" });
  });
});
