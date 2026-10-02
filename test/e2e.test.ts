/**
 * End-to-end tests: a real daemon process on a real Unix socket driving a real (fake) ACP
 * harness over stdio, plus a real MCP stdio client talking to `dist/cli.js`.
 *
 * These tests exercise the compiled `dist/` output because the daemon and the MCP server
 * are spawned as separate processes. `ensureBuilt()` compiles on demand when `dist/` is
 * missing, so `npx vitest run` works without a manual build step.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { DaemonClient } from "../src/ipc";
import { readPersistedPreview, readPersistedResult, readPersistedState } from "../src/persistence";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DAEMON = join(REPO_ROOT, "dist", "daemon", "main.js");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "fake-acp-harness.mjs");
const MOCK_DOCKER = join(REPO_ROOT, "test", "fixtures", "mock-docker.mjs");
const MOCK_SSH = join(REPO_ROOT, "test", "fixtures", "mock-ssh.mjs");

const TOOL_NAMES = [
  "answer_question",
  "auth_info",
  "authenticate",
  "cancel_message",
  "close_session",
  "create_session",
  "harness_info",
  "live_output",
  "message_result",
  "ping",
  "send_message",
  "set_model",
];

let built = false;
function ensureBuilt(): void {
  if (built) return;
  if (!existsSync(DIST_DAEMON) || !existsSync(DIST_CLI)) {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  // The mock docker/ssh CLIs are executed directly, so they need the executable bit.
  for (const fixture of [MOCK_DOCKER, MOCK_SSH]) chmodSync(fixture, 0o755);
  built = true;
}

const cleanups: Array<() => void | Promise<void>> = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

interface DaemonConfigOptions {
  dir: string;
  socketPath: string;
  lockPath: string;
  sessionDir: string;
  previewBytes: number;
  idleSeconds: number;
  dockerCommand?: string;
  sshCommand?: string;
  /** Point codex at a command that cannot be spawned, for create-failure tests. */
  brokenCodex?: boolean;
  /** Make codebuddy advertise login and report an unauthenticated status. */
  authRequired?: boolean;
  /** Make codebuddy advertise login but never answer `authenticate` (timeout tests). */
  authHang?: boolean;
  /** Authentication budget; kept short so a timeout test does not wait. */
  authTimeoutSeconds?: number;
  /** Override the ledger-backed rate limit for the authentication tests. */
  rateLimit?: { enabled: boolean; minIntervalSeconds: number; maxAttempts: number; windowSeconds: number };
  /** Make the harness emit a malformed stdout line at startup (creation must fail). */
  emitGarbage?: boolean;
  /** Override `buffers.max_read_bytes` for the oversized-line tests. */
  maxReadBytes?: number;
  /** Override `transport.turn_timeout_seconds` for the HANG timeout test. */
  turnTimeoutSeconds?: number;
}

function daemonConfigText(options: DaemonConfigOptions): string {
  const harness = (name: string, extraArgs: string[] = []): string[] => [
    `  ${name}:`,
    `    command: ${JSON.stringify(options.brokenCodex && name === "codex" ? join(options.dir, "does-not-exist-harness") : process.execPath)}`,
    "    args:",
    `      - ${JSON.stringify(FIXTURE)}`,
    ...extraArgs.map((value) => `      - ${JSON.stringify(value)}`),
    "    models:",
    "      - id: fake-model",
    "        name: Fake Model",
    "        thinking_levels: [low, high]",
    "      - id: fake-model-2",
    "        name: Fake Model 2",
    "        thinking_levels: [low]",
  ];
  const rate = options.rateLimit ?? {
    enabled: true,
    minIntervalSeconds: 0,
    maxAttempts: 50,
    windowSeconds: 3600,
  };
  return [
    "schema_version: 1",
    "default_harness: codebuddy",
    "paths:",
    `  state_dir: ${JSON.stringify(options.dir)}`,
    `  session_dir: ${JSON.stringify(options.sessionDir)}`,
    "server:",
    `  socket_path: ${JSON.stringify(options.socketPath)}`,
    `  lock_path: ${JSON.stringify(options.lockPath)}`,
    "  start_timeout_seconds: 10",
    "sessions:",
    "  max_concurrency: 6",
    `  idle_timeout_seconds: ${options.idleSeconds}`,
    "  reap_interval_seconds: 30",
    "transport:",
    "  startup_timeout_seconds: 10",
    `  turn_timeout_seconds: ${options.turnTimeoutSeconds ?? 15}`,
    "  turn_cancel_timeout_seconds: 2",
    "  terminate_grace_seconds: 2",
    "  remote_cleanup_timeout_seconds: 5",
    "buffers:",
    `  preview_bytes: ${options.previewBytes}`,
    ...(options.maxReadBytes ? [`  max_read_bytes: ${options.maxReadBytes}`] : []),
    "launch:",
    `  ssh_command: ${JSON.stringify(options.sshCommand ?? "ssh")}`,
    `  docker_command: ${JSON.stringify(options.dockerCommand ?? "docker")}`,
    "  codebuddy_command: codebuddy",
    "  codex_command: codex-acp",
    "  agy_command: agy_acp_server",
    // Configured so agy mode routing has a mode id to send for permission_mode=edit.
    '  agy_edit_mode_id: "agy-edit-mode"',
    "authentication:",
    `  timeout_seconds: ${options.authTimeoutSeconds ?? 10}`,
    // Keep the attempt ledger inside the fixture directory, never the real home dir.
    `  ledger_path: ${JSON.stringify(join(options.dir, "auth-rate.json"))}`,
    "  max_concurrent_targets: 2",
    "  rate_limit:",
    `    enabled: ${rate.enabled}`,
    `    min_interval_seconds: ${rate.minIntervalSeconds}`,
    `    max_attempts: ${rate.maxAttempts}`,
    `    window_seconds: ${rate.windowSeconds}`,
    "harnesses:",
    ...harness(
      "codebuddy",
      options.emitGarbage
        ? ["--emit-garbage"]
        : options.authRequired
          ? [options.authHang ? "--auth-hang" : "--auth-required"]
          : [],
    ),
    ...harness("codex"),
    ...harness("agy"),
    "",
  ].join("\n");
}

interface DaemonFixture {
  dir: string;
  configPath: string;
  socketPath: string;
  lockPath: string;
  sessionDir: string;
  dockerLog: string;
  sshLog: string;
  proc: ChildProcess;
  client: DaemonClient;
  stderr: string[];
}

async function startDaemon(
  options: {
    previewBytes?: number;
    idleSeconds?: number;
    reuse?: DaemonFixture;
    mockDocker?: boolean;
    mockSsh?: boolean;
    brokenCodex?: boolean;
    authRequired?: boolean;
    authHang?: boolean;
    authTimeoutSeconds?: number;
    rateLimit?: { enabled: boolean; minIntervalSeconds: number; maxAttempts: number; windowSeconds: number };
    emitGarbage?: boolean;
    maxReadBytes?: number;
    turnTimeoutSeconds?: number;
    /** Extra environment for the daemon (and therefore its supervisors and harnesses). */
    extraEnv?: Record<string, string>;
  } = {},
): Promise<DaemonFixture> {
  ensureBuilt();
  let dir: string;
  let configPath: string;
  let socketPath: string;
  let lockPath: string;
  let sessionDir: string;
  let dockerLog: string;
  let sshLog: string;
  if (options.reuse) {
    ({ dir, configPath, socketPath, lockPath, sessionDir, dockerLog, sshLog } = options.reuse);
  } else {
    dir = tmpDir("hab-daemon-");
    socketPath = join(dir, "runtime", "bridge.sock");
    lockPath = join(dir, "runtime", "bridge.lock");
    sessionDir = join(dir, "sessions");
    dockerLog = join(dir, "docker-calls.jsonl");
    sshLog = join(dir, "ssh-calls.jsonl");
    configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      daemonConfigText({
        dir,
        socketPath,
        lockPath,
        sessionDir,
        previewBytes: options.previewBytes ?? 4096,
        idleSeconds: options.idleSeconds ?? 0,
        dockerCommand: options.mockDocker ? MOCK_DOCKER : undefined,
        sshCommand: options.mockSsh ? MOCK_SSH : undefined,
        brokenCodex: options.brokenCodex,
        authRequired: options.authRequired,
        authHang: options.authHang,
        authTimeoutSeconds: options.authTimeoutSeconds,
        rateLimit: options.rateLimit,
        emitGarbage: options.emitGarbage,
        maxReadBytes: options.maxReadBytes,
        turnTimeoutSeconds: options.turnTimeoutSeconds,
      }),
    );
  }
  const proc = spawn(process.execPath, [DIST_DAEMON, "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MOCK_DOCKER_LOG: dockerLog,
      MOCK_SSH_LOG: sshLog,
      ...(options.extraEnv ?? {}),
    },
  });
  processes.push(proc);
  const stderr: string[] = [];
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => stderr.push(chunk));

  const client = new DaemonClient({
    socketPath,
    lockPath,
    configPath,
    startTimeoutMs: 10_000,
    daemonEntry: DIST_DAEMON,
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await client.ping()) break;
    await sleep(50);
  }
  if (!(await client.ping())) {
    throw new Error(`daemon did not start: ${stderr.join("")}`);
  }
  return { dir, configPath, socketPath, lockPath, sessionDir, dockerLog, sshLog, proc, client, stderr };
}

/** Recorded mock-CLI invocations (`argv` per line). */
function dockerCalls(fixture: DaemonFixture): Array<{ argv: string[] }> {
  if (!existsSync(fixture.dockerLog)) return [];
  return readFileSync(fixture.dockerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[] });
}

function sshCalls(fixture: DaemonFixture): Array<{ host: string; command: string }> {
  if (!existsSync(fixture.sshLog)) return [];
  return readFileSync(fixture.sshLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { host: string; command: string });
}

/** Raw ACP client requests the daemon recorded for a session. */
function clientRequests(directory: string): Array<{ method: string; params: Record<string, unknown> }> {
  return clientMessages(directory)
    .filter((value) => typeof value.method === "string")
    .map((value) => ({
      method: value.method as string,
      params: (value.params ?? {}) as Record<string, unknown>,
    }));
}

/** Every recorded client-side ACP message (requests, notifications, and responses). */
function clientMessages(directory: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(directory, "raw.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { stream: string; value: Record<string, unknown> })
    .filter((entry) => entry.stream === "client")
    .map((entry) => entry.value);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await sleep(25);
  }
}

/** Whether a pid is still alive (EPERM still means "exists"). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stopDaemon(fixture: DaemonFixture): Promise<void> {
  try {
    await fixture.client.call("shutdown", {}, { autoStart: false, timeoutMs: 3000 });
  } catch {
    fixture.proc.kill("SIGTERM");
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && fixture.proc.exitCode === null && fixture.proc.signalCode === null) {
    await sleep(25);
  }
}

async function createSession(
  client: DaemonClient,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<{ sessionId: string; directory: string; created: Record<string, unknown> }> {
  const created = await client.call("create_session", {
    harness: "codebuddy",
    cwd,
    model_id: "fake-model",
    ...extra,
  });
  expect(created.state).toBe("ready");
  return { sessionId: created.session_id as string, directory: created.directory as string, created };
}

async function waitForTerminal(
  client: DaemonClient,
  sessionId: string,
  messageId: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await client.call("message_result", { session_id: sessionId, message_id: messageId });
    if (last.terminal === true) return last;
    await sleep(25);
  }
  throw new Error(`message ${messageId} never reached a terminal state: ${JSON.stringify(last)}`);
}

function parseToolResult(result: { content?: unknown; isError?: boolean }): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: string; text?: string } | undefined;
  const text = first?.type === "text" && typeof first.text === "string" ? first.text : "{}";
  const parsed: unknown = JSON.parse(text);
  expect(result.isError ?? false).toBe(false);
  return parsed as Record<string, unknown>;
}

interface McpFixture {
  dir: string;
  configPath: string;
  lockPath: string;
  sessionDir: string;
  socketPath: string;
  client: Client;
  transport: StdioClientTransport;
  notifications: Array<Record<string, unknown>>;
}

async function startMcp(): Promise<McpFixture> {
  ensureBuilt();
  const dir = tmpDir("hab-mcp-");
  const socketPath = join(dir, "runtime", "bridge.sock");
  const lockPath = join(dir, "runtime", "bridge.lock");
  const sessionDir = join(dir, "sessions");
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    daemonConfigText({ dir, socketPath, lockPath, sessionDir, previewBytes: 4096, idleSeconds: 0 }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, "--config", configPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "bridge-e2e", version: "1.0.0" }, { capabilities: {} });
  const notifications: Array<Record<string, unknown>> = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    notifications.push(notification.params as unknown as Record<string, unknown>);
  });
  await client.connect(transport);
  // Keep stderr drained so the CLI can never block on a full pipe.
  transport.stderr?.on("data", () => undefined);

  const shutdownDaemon = async (): Promise<void> => {
    const daemon = new DaemonClient({ socketPath, lockPath, configPath });
    await daemon.call("shutdown", {}, { autoStart: false, timeoutMs: 3000 }).catch(() => undefined);
  };
  cleanups.push(async () => {
    // Safety net for the detached daemon the CLI auto-started: TERM, then KILL if needed.
    try {
      const pid = existsSync(lockPath) ? Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10) : NaN;
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, "SIGTERM");
        await sleep(500);
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    } catch {
      // Already gone.
    }
    await transport.close().catch(() => undefined);
  });
  return { dir, configPath, lockPath, sessionDir, socketPath, client, transport, notifications };
}

async function stopMcp(fixture: McpFixture): Promise<void> {
  const daemon = new DaemonClient({
    socketPath: fixture.socketPath,
    lockPath: fixture.lockPath,
    configPath: fixture.configPath,
  });
  await daemon.call("shutdown", {}, { autoStart: false, timeoutMs: 3000 }).catch(() => undefined);
  await fixture.transport.close().catch(() => undefined);
}

// --- daemon over IPC ---------------------------------------------------------

describe("daemon over IPC", () => {
  it("answers ping with its identity and config fingerprint", async () => {
    const fixture = await startDaemon();
    const pong = await fixture.client.ping();
    expect(pong?.status).toBe("ok");
    expect(typeof pong?.pid).toBe("number");
    expect(typeof pong?.config_fingerprint).toBe("string");
    expect(pong?.session_dir).toBe(fixture.sessionDir);
    await stopDaemon(fixture);
  });

  it("creates the socket owner-only inside a private directory", async () => {
    if (process.platform === "win32") return;
    const fixture = await startDaemon();
    expect(statSync(dirname(fixture.socketPath)).mode & 0o777).toBe(0o700);
    expect(statSync(fixture.socketPath).mode & 0o777).toBe(0o600);
    await stopDaemon(fixture);
  });

  it("creates a local direct session, sets the model, and reports auth state", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory, created } = await createSession(fixture.client, fixture.dir);

    expect(basename(directory)).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(dirname(directory)).toBe(fixture.sessionDir);
    for (const name of ["raw.jsonl", "log.txt", "preview.txt", "meta.json", "state.json", "queue.json", "results"]) {
      expect(existsSync(join(directory, name))).toBe(true);
    }
    const raw = readFileSync(join(directory, "raw.jsonl"), "utf8");
    expect(raw).toContain('"stream":"client"');
    expect(raw).toContain('"stream":"stdout"');
    expect(readFileSync(join(directory, "log.txt"), "utf8")).toContain("session created");
    const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
    expect(meta.params).toMatchObject({
      harness: "codebuddy",
      runtime: "direct",
      target: "local",
      remote_host: null,
      docker: null,
    });

    // launch_info echoes the effective runtime facts.
    const launch = created.launch_info as Record<string, unknown>;
    expect(launch).toMatchObject({ target: "local", runtime: "direct", permission_mode: "auto" });
    expect(typeof launch.transport_pid).toBe("number");
    expect(launch.transport_pgid).toBe(launch.transport_pid);

    const info = await fixture.client.call("auth_info", { session_id: sessionId });
    expect(info.authenticated).toBe(true);
    expect(info.user).toBeNull();
    expect(info.harness_session_id).toBe("fake-1");
    expect(info.model_id).toBe("fake-model");

    const set = await fixture.client.call("set_model", { session_id: sessionId, model_id: "fake-model-2" });
    expect(set).toMatchObject({ status: "model_set", model_id: "fake-model-2" });

    const status = await fixture.client.call("message_result", { session_id: sessionId });
    expect(status.harness_models).toEqual([
      { id: "fake-model", name: "Fake Model" },
      { id: "fake-model-2", name: "Fake Model 2" },
    ]);
    await stopDaemon(fixture);
  });

  it("returns only a message_id from send_message and yields a polled result", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "hello" });
    expect(Object.keys(sent)).toEqual(["message_id"]);
    const messageId = sent.message_id as string;

    const status = await waitForTerminal(fixture.client, sessionId, messageId);
    expect(status.state).toBe("completed");
    expect(status.terminal).toBe(true);

    const result = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    expect(result.text).toBe("echo:hello");
    expect(result.terminal).toBe(true);
    await stopDaemon(fixture);
  });

  it("allows only one non-terminal message and rejects a second submit with busy", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);

    const first = await fixture.client.call("send_message", { session_id: sessionId, text: "HOLD first" });
    const firstId = first.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: firstId });
      return status.state === "running";
    });

    // A second submit is refused while the first is still non-terminal, whatever the mode or
    // key, and creates no persistent record.
    await expect(
      fixture.client.call("send_message", { session_id: sessionId, text: "second", mode: "queue" }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(
      fixture.client.call("send_message", {
        session_id: sessionId,
        text: "third",
        idempotency_key: "fresh-key",
      }),
    ).rejects.toMatchObject({ code: "busy" });

    const sessionStatus = await fixture.client.call("message_result", { session_id: sessionId });
    expect(sessionStatus.messages_total).toBe(1);
    expect(sessionStatus.queued_message_ids).toEqual([]);
    const queue = JSON.parse(readFileSync(join(directory, "queue.json"), "utf8"));
    expect(Object.keys(queue.messages)).toEqual([firstId]);

    // After the message is terminal a new one is accepted and runs.
    await fixture.client.call("cancel_message", { session_id: sessionId, message_id: firstId });
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: firstId });
      return status.terminal === true;
    });
    const second = await fixture.client.call("send_message", { session_id: sessionId, text: "second" });
    await waitForTerminal(fixture.client, sessionId, second.message_id as string);
    const secondResult = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: second.message_id,
    });
    expect(secondResult.text).toBe("echo:second");
    await stopDaemon(fixture);
  });

  it("reports status only while non-terminal, then status plus result", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "HOLD shape" });
    const messageId = sent.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
      return status.state === "running";
    });

    // A non-terminal poll carries the full status but NO result fields, so the partial
    // preview can never be mistaken for a final answer.
    const running = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    expect(running.terminal).toBe(false);
    expect(running.state).toBe("running");
    expect(running.cancellable).toBe(true);
    expect(running).not.toHaveProperty("text");
    expect(running).not.toHaveProperty("tool_calls");
    expect(running).not.toHaveProperty("harness_session_id");

    // The partial preview is still readable through live_output.
    const live = await fixture.client.call("live_output", { session_id: sessionId, message_id: messageId });
    expect(String(live.chunk)).toContain("echo:HOLD shape");

    await fixture.client.call("cancel_message", { session_id: sessionId, message_id: messageId });
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
      return status.terminal === true;
    });
    const terminal = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    expect(terminal.state).toBe("cancelled");
    expect(terminal).toHaveProperty("text");
    expect(terminal).toHaveProperty("tool_calls");
    expect(terminal).toHaveProperty("harness_session_id");
    await stopDaemon(fixture);
  });

  it("replays a repeated idempotency_key and rejects a conflict", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    const first = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "hello keyed",
      idempotency_key: "key-1",
    });
    const firstId = first.message_id as string;

    // Same key + same text/mode -> the original id, and no second message is created.
    const replay = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "hello keyed",
      idempotency_key: "key-1",
    });
    expect(replay.message_id).toBe(firstId);

    // Same key + different text or mode -> a clear conflict.
    await expect(
      fixture.client.call("send_message", {
        session_id: sessionId,
        text: "different",
        idempotency_key: "key-1",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      fixture.client.call("send_message", {
        session_id: sessionId,
        text: "hello keyed",
        mode: "queue",
        idempotency_key: "key-1",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    // An invalid key is rejected before anything is submitted.
    await expect(
      fixture.client.call("send_message", {
        session_id: sessionId,
        text: "hello keyed",
        idempotency_key: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_idempotency_key" });

    const status = await waitForTerminal(fixture.client, sessionId, firstId);
    expect(status.state).toBe("completed");
    const result = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: firstId,
    });
    expect(result.text).toBe("echo:hello keyed");
    const sessionStatus = await fixture.client.call("message_result", { session_id: sessionId });
    expect(sessionStatus.messages_total).toBe(1);
    await stopDaemon(fixture);
  });

  it("replays a keyed submission while it is still non-terminal without creating a second message", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);

    const first = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "HOLD one",
      idempotency_key: "k1",
    });
    const firstId = first.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: firstId });
      return status.state === "running";
    });

    // A replay of the accepted request resolves to the original id even though it is still
    // running, and does not create a second message or trip the busy guard.
    const replay = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "HOLD one",
      idempotency_key: "k1",
    });
    expect(replay.message_id).toBe(firstId);

    // A conflict is detected before the busy guard, so a key can never silently alias.
    await expect(
      fixture.client.call("send_message", {
        session_id: sessionId,
        text: "HOLD other",
        idempotency_key: "k1",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: firstId });
    expect(status.state).toBe("running");
    expect(status.terminal).toBe(false);
    const sessionStatus = await fixture.client.call("message_result", { session_id: sessionId });
    expect(sessionStatus.messages_total).toBe(1);
    const queue = JSON.parse(readFileSync(join(directory, "queue.json"), "utf8"));
    expect(Object.keys(queue.messages)).toEqual([firstId]);
    await fixture.client.call("cancel_message", { session_id: sessionId, message_id: firstId });
    await stopDaemon(fixture);
  });

  it("replays an idempotency_key for a closed session and rejects a conflict", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);
    const sent = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "bye keyed",
      idempotency_key: "close-key",
    });
    const messageId = sent.message_id as string;
    await waitForTerminal(fixture.client, sessionId, messageId);
    await fixture.client.call("close_session", { session_id: sessionId });

    // A brand-new key on a closed session is still rejected...
    await expect(
      fixture.client.call("send_message", { session_id: sessionId, text: "new", idempotency_key: "new-key" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
    // ...but the original key resolves to the original message id.
    const replay = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "bye keyed",
      idempotency_key: "close-key",
    });
    expect(replay.message_id).toBe(messageId);
    await expect(
      fixture.client.call("send_message", { session_id: sessionId, text: "other", idempotency_key: "close-key" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await stopDaemon(fixture);
  });

  it("replays an idempotency_key after a hard daemon restart", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);
    const sent = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "survive keyed",
      idempotency_key: "restart-key",
    });
    const messageId = sent.message_id as string;
    await waitForTerminal(fixture.client, sessionId, messageId);

    // Hard restart: the new daemon starts with an empty live registry.
    fixture.proc.kill("SIGKILL");
    await waitForExit(fixture.proc, 5000);
    const restarted = await startDaemon({ reuse: fixture });
    expect((await restarted.client.call("list_sessions")).sessions).toEqual([]);
    await expect(
      restarted.client.call("send_message", { session_id: sessionId, text: "survive keyed" }),
    ).rejects.toMatchObject({ code: "unknown_session" });

    // The persisted idempotency index resolves the retry to the original message id.
    const replay = await restarted.client.call("send_message", {
      session_id: sessionId,
      text: "survive keyed",
      idempotency_key: "restart-key",
    });
    expect(replay.message_id).toBe(messageId);
    await expect(
      restarted.client.call("send_message", {
        session_id: sessionId,
        text: "changed",
        idempotency_key: "restart-key",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    // The replayed id is still fully readable through the persisted path.
    const result = await restarted.client.call("message_result", {
      session_id: sessionId,
      message_id: messageId,
    });
    expect(result.text).toBe("echo:survive keyed");
    await stopDaemon(restarted);
  });

  it("exposes interactions and validates request_id and option on answer_request", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    const sent = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "please permission",
    });
    const messageId = sent.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
      return status.state === "waiting_input";
    });
    const waiting = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    const interaction = waiting.interaction as Record<string, unknown>;
    expect(interaction.request_id).toBe("9000");
    expect(interaction.permission).toBe(true);
    expect((interaction.options as Array<{ optionId: string }>).map((option) => option.optionId)).toEqual([
      "allow_once",
      "deny_once",
    ]);
    expect(waiting.terminal).toBe(false);

    await expect(
      fixture.client.call("answer_question", {
        session_id: sessionId,
        message_id: messageId,
        request_id: "wrong",
        response: { option_id: "allow_once" },
      }),
    ).rejects.toMatchObject({ code: "request_id_mismatch" });
    await expect(
      fixture.client.call("answer_question", {
        session_id: sessionId,
        message_id: messageId,
        request_id: "9000",
        response: { option_id: "not_an_option" },
      }),
    ).rejects.toMatchObject({ code: "invalid_option" });

    const answered = await fixture.client.call("answer_question", {
      session_id: sessionId,
      message_id: messageId,
      request_id: "9000",
      response: { option_id: "allow_once" },
    });
    expect(answered).toMatchObject({ status: "accepted", accepted: true, request_id: "9000" });

    await waitForTerminal(fixture.client, sessionId, messageId);
    const result = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    expect(String(result.text)).toContain("[allowed:allow_once]");
    await stopDaemon(fixture);
  });

  it("unifies information requests into interactions without the permission flag", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "please info" });
    const messageId = sent.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
      return status.state === "waiting_input";
    });
    const waiting = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    const interaction = waiting.interaction as Record<string, unknown>;
    expect(interaction.request_id).toBe("9100");
    expect(interaction.permission).toBe(false);
    expect(waiting.terminal).toBe(false);

    const answered = await fixture.client.call("answer_question", {
      session_id: sessionId,
      message_id: messageId,
      request_id: "9100",
      response: { value: "42" },
    });
    expect(answered).toMatchObject({ status: "accepted", accepted: true, request_id: "9100" });

    await waitForTerminal(fixture.client, sessionId, messageId);
    const result = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
    expect(String(result.text)).toContain('[info:{"value":"42"}]');
    await stopDaemon(fixture);
  });

  it("answers a permission request with reject, timeout, or cancel", async () => {
    const fixture = await startDaemon();

    // reject -> the harness's deny option is selected and the turn completes normally.
    const rejecting = await createSession(fixture.client, fixture.dir);
    const rejected = await fixture.client.call("send_message", {
      session_id: rejecting.sessionId,
      text: "please permission",
    });
    const rejectedId = rejected.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: rejecting.sessionId,
        message_id: rejectedId,
      });
      return status.state === "waiting_input";
    });
    await expect(
      fixture.client.call("answer_question", {
        session_id: rejecting.sessionId,
        message_id: rejectedId,
        request_id: "9000",
        answer: "nonsense",
      }),
    ).rejects.toMatchObject({ code: "invalid_param" });
    await expect(
      fixture.client.call("answer_question", {
        session_id: rejecting.sessionId,
        message_id: rejectedId,
        request_id: "9000",
        answer: "reject",
      }),
    ).resolves.toMatchObject({ status: "accepted", accepted: true, request_id: "9000" });
    await waitForTerminal(fixture.client, rejecting.sessionId, rejectedId);
    const rejectedResult = await fixture.client.call("message_result", {
      session_id: rejecting.sessionId,
      message_id: rejectedId,
    });
    expect(rejectedResult.state).toBe("completed");
    expect(String(rejectedResult.text)).toContain("[denied:deny_once]");

    // timeout -> the harness receives the cancelled outcome and the turn ends cancelled.
    const timingOut = await createSession(fixture.client, fixture.dir);
    const timedOut = await fixture.client.call("send_message", {
      session_id: timingOut.sessionId,
      text: "please permission",
    });
    const timedOutId = timedOut.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: timingOut.sessionId,
        message_id: timedOutId,
      });
      return status.state === "waiting_input";
    });
    await fixture.client.call("answer_question", {
      session_id: timingOut.sessionId,
      message_id: timedOutId,
      request_id: "9000",
      answer: "timeout",
    });
    await waitForTerminal(fixture.client, timingOut.sessionId, timedOutId);
    const timedOutResult = await fixture.client.call("message_result", {
      session_id: timingOut.sessionId,
      message_id: timedOutId,
    });
    expect(timedOutResult.state).toBe("cancelled");
    expect(String(timedOutResult.text)).toContain("[permission-cancelled]");

    // cancel -> the harness receives the cancelled outcome (never the deny option) and the
    // turn ends cancelled.
    const cancelling = await createSession(fixture.client, fixture.dir);
    const cancelled = await fixture.client.call("send_message", {
      session_id: cancelling.sessionId,
      text: "please permission",
    });
    const cancelledId = cancelled.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: cancelling.sessionId,
        message_id: cancelledId,
      });
      return status.state === "waiting_input";
    });
    await expect(
      fixture.client.call("answer_question", {
        session_id: cancelling.sessionId,
        message_id: cancelledId,
        request_id: "9000",
        answer: "cancel",
      }),
    ).resolves.toMatchObject({ status: "accepted", accepted: true, request_id: "9000" });
    await waitForTerminal(fixture.client, cancelling.sessionId, cancelledId);
    const cancelledResult = await fixture.client.call("message_result", {
      session_id: cancelling.sessionId,
      message_id: cancelledId,
    });
    expect(cancelledResult.state).toBe("cancelled");
    expect(String(cancelledResult.text)).toContain("[permission-cancelled]");
    // `cancel` is distinct from `reject`: it never selects the offered deny option.
    expect(String(cancelledResult.text)).not.toContain("[denied:deny_once]");

    // accept still requires the concrete response object.
    const accepting = await createSession(fixture.client, fixture.dir);
    const accepted = await fixture.client.call("send_message", {
      session_id: accepting.sessionId,
      text: "please permission",
    });
    const acceptedId = accepted.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: accepting.sessionId,
        message_id: acceptedId,
      });
      return status.state === "waiting_input";
    });
    await expect(
      fixture.client.call("answer_question", {
        session_id: accepting.sessionId,
        message_id: acceptedId,
        request_id: "9000",
      }),
    ).rejects.toMatchObject({ code: "invalid_param" });
    await fixture.client.call("answer_question", {
      session_id: accepting.sessionId,
      message_id: acceptedId,
      request_id: "9000",
      answer: "accept",
      response: { option_id: "allow_once" },
    });
    await waitForTerminal(fixture.client, accepting.sessionId, acceptedId);
    await stopDaemon(fixture);
  });

  it("cancels the turn when an information request is rejected, times out, or is cancelled", async () => {
    const fixture = await startDaemon();
    const reasons: Record<string, string> = {
      reject: "rejected",
      timeout: "interaction_timeout",
      cancel: "user_cancel",
    };
    for (const answer of ["reject", "timeout", "cancel"] as const) {
      const { sessionId } = await createSession(fixture.client, fixture.dir);
      const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "please info" });
      const messageId = sent.message_id as string;
      await waitUntilAsync(async () => {
        const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
        return status.state === "waiting_input";
      });
      const answered = await fixture.client.call("answer_question", {
        session_id: sessionId,
        message_id: messageId,
        request_id: "9100",
        answer,
      });
      expect(answered).toMatchObject({ status: "accepted", accepted: true });
      const status = await waitForTerminal(fixture.client, sessionId, messageId);
      expect(status.state).toBe("cancelled");
      expect(status.cancel_reason).toBe(reasons[answer]);
    }
    await stopDaemon(fixture);
  });

  it("routes elicitation answers to accept, decline, or cancel", async () => {
    const fixture = await startDaemon();
    // accept -> the harness receives the content and the turn completes normally.
    const accepting = await createSession(fixture.client, fixture.dir);
    const accepted = await fixture.client.call("send_message", { session_id: accepting.sessionId, text: "please elicit" });
    const acceptedId = accepted.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: accepting.sessionId,
        message_id: acceptedId,
      });
      return status.state === "waiting_input";
    });
    const acceptedWaiting = await fixture.client.call("message_result", {
      session_id: accepting.sessionId,
      message_id: acceptedId,
    });
    expect((acceptedWaiting.interaction as Record<string, unknown>).permission).toBe(false);
    await expect(
      fixture.client.call("answer_question", {
        session_id: accepting.sessionId,
        message_id: acceptedId,
        request_id: "9200",
        answer: "accept",
        response: { value: "hello" },
      }),
    ).resolves.toMatchObject({ status: "accepted", accepted: true, request_id: "9200" });
    await waitForTerminal(fixture.client, accepting.sessionId, acceptedId);
    const acceptedResult = await fixture.client.call("message_result", {
      session_id: accepting.sessionId,
      message_id: acceptedId,
    });
    expect(acceptedResult.state).toBe("completed");
    expect(String(acceptedResult.text)).toContain('[elicited:{"value":"hello"}]');

    // reject -> the harness sees a decline and finishes normally.
    const declining = await createSession(fixture.client, fixture.dir);
    const declined = await fixture.client.call("send_message", { session_id: declining.sessionId, text: "please elicit" });
    const declinedId = declined.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: declining.sessionId,
        message_id: declinedId,
      });
      return status.state === "waiting_input";
    });
    await fixture.client.call("answer_question", {
      session_id: declining.sessionId,
      message_id: declinedId,
      request_id: "9200",
      answer: "reject",
    });
    await waitForTerminal(fixture.client, declining.sessionId, declinedId);
    const declinedResult = await fixture.client.call("message_result", {
      session_id: declining.sessionId,
      message_id: declinedId,
    });
    expect(declinedResult.state).toBe("completed");
    expect(String(declinedResult.text)).toContain("[elicit-declined]");

    // cancel -> the harness sees a cancel and ends the turn cancelled.
    const cancelling = await createSession(fixture.client, fixture.dir);
    const cancelled = await fixture.client.call("send_message", { session_id: cancelling.sessionId, text: "please elicit" });
    const cancelledId = cancelled.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", {
        session_id: cancelling.sessionId,
        message_id: cancelledId,
      });
      return status.state === "waiting_input";
    });
    await fixture.client.call("answer_question", {
      session_id: cancelling.sessionId,
      message_id: cancelledId,
      request_id: "9200",
      answer: "cancel",
    });
    await waitForTerminal(fixture.client, cancelling.sessionId, cancelledId);
    const cancelledResult = await fixture.client.call("message_result", {
      session_id: cancelling.sessionId,
      message_id: cancelledId,
    });
    expect(cancelledResult.state).toBe("cancelled");
    expect(String(cancelledResult.text)).toContain("[elicit-cancelled]");
    await stopDaemon(fixture);
  });

  it("advertises form-only elicitation, accepts form mode, and rejects url mode with -32602", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);

    // The initialize handshake advertises form support only; `url` is never claimed.
    const initialize = clientMessages(directory).find((value) => value.method === "initialize");
    const capabilities = (initialize?.params as Record<string, unknown> | undefined)
      ?.clientCapabilities as Record<string, unknown>;
    expect(capabilities.elicitation).toEqual({ form: {} });

    // An explicit form-mode request is surfaced as an interaction and answered normally.
    const form = await fixture.client.call("send_message", { session_id: sessionId, text: "please elicit-form" });
    const formId = form.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: formId });
      return status.state === "waiting_input";
    });
    await fixture.client.call("answer_question", {
      session_id: sessionId,
      message_id: formId,
      request_id: "9200",
      answer: "accept",
      response: { value: "ok" },
    });
    await waitForTerminal(fixture.client, sessionId, formId);
    const formResult = await fixture.client.call("message_result", { session_id: sessionId, message_id: formId });
    expect(formResult.state).toBe("completed");
    expect(String(formResult.text)).toContain('[elicited:{"value":"ok"}]');

    // A url-mode request is not advertised: it is rejected with -32602 and never becomes an
    // interaction the caller could answer.
    const url = await fixture.client.call("send_message", { session_id: sessionId, text: "please elicit-url" });
    const urlId = url.message_id as string;
    await waitForTerminal(fixture.client, sessionId, urlId);
    const rejection = clientMessages(directory).find(
      (value) => (value.error as Record<string, unknown> | undefined)?.code === -32602,
    );
    expect(rejection).toBeDefined();
    expect(String((rejection?.error as Record<string, unknown>).message)).toContain("url");
    const urlStatus = await fixture.client.call("message_result", { session_id: sessionId, message_id: urlId });
    expect(urlStatus.state).toBe("cancelled");
    await stopDaemon(fixture);
  });

  it("streams live_output by offset and reports truncation and stop", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    const sent = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "HOLD streaming",
      mode: "queue",
    });
    const messageId = sent.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
      return status.state === "running";
    });

    const live = await fixture.client.call("live_output", { session_id: sessionId, message_id: messageId });
    expect(String(live.chunk)).toContain("echo:HOLD streaming");
    expect(live.offset).toBe(0);
    expect(live.truncated).toBe(false);
    expect(live.stopped).toBe(false);

    const noNew = await fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: messageId,
      offset: live.next_offset,
    });
    expect(noNew.chunk).toBe("");
    expect(noNew.truncated).toBe(false);

    const stopped = await fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: messageId,
      stop: true,
    });
    expect(stopped.stopped).toBe(true);
    expect(stopped.chunk).toBe("");

    await fixture.client.call("cancel_message", { session_id: sessionId, message_id: messageId });

    // A tiny preview window forces truncation on a stale offset.
    const small = await startDaemon({ previewBytes: 16 });
    const smallSession = await createSession(small.client, small.dir);
    const long = await small.client.call("send_message", {
      session_id: smallSession.sessionId,
      text: "0123456789ABCDEFGHIJ",
      mode: "queue",
    });
    const longId = long.message_id as string;
    await waitForTerminal(small.client, smallSession.sessionId, longId);
    const stale = await small.client.call("live_output", {
      session_id: smallSession.sessionId,
      message_id: longId,
      offset: 0,
    });
    expect(stale.truncated).toBe(true);
    expect(stale.dropped_bytes as number).toBeGreaterThan(0);
    expect(stale.window_start as number).toBeGreaterThan(0);
    expect(stale.stopped).toBe(true);
    await stopDaemon(small);
    await stopDaemon(fixture);
  });

  it("closes a session and then serves its status, result and preview over IPC", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);
    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "bye" });
    const messageId = sent.message_id as string;
    await waitForTerminal(fixture.client, sessionId, messageId);

    const closed = await fixture.client.call("close_session", { session_id: sessionId });
    expect(closed.status).toBe("closed");
    // The live registry no longer holds it...
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    await expect(
      fixture.client.call("send_message", { session_id: sessionId, text: "too late" }),
    ).rejects.toMatchObject({ code: "unknown_session" });

    // ...but the same queries still work through the persisted (read-only) path.
    const sessionStatus = await fixture.client.call("message_result", { session_id: sessionId });
    expect(sessionStatus.state).toBe("closed");
    expect(sessionStatus.persisted).toBe(true);
    expect(sessionStatus.orphaned).toBe(false);
    expect(sessionStatus.messages_total).toBe(1);
    expect(sessionStatus.running_message_id).toBeNull();

    const status = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: messageId,
    });
    expect(status.state).toBe("completed");
    expect(status.terminal).toBe(true);
    expect(status.result_available).toBe(true);
    // The default mode is steering, and the persisted snapshot must say so after close.
    expect(status.mode).toBe("steering");

    const result = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: messageId,
    });
    expect(result.terminal).toBe(true);
    expect(result.text).toBe("echo:bye");
    expect(result.mode).toBe("steering");

    const live = await fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: messageId,
      offset: 0,
    });
    expect(String(live.chunk)).toContain("echo:bye");
    expect(live.stopped).toBe(true);
    expect(live.persisted).toBe(true);

    // Direct snapshot reads agree with the IPC answers.
    expect(readPersistedState(directory)?.state).toBe("closed");
    expect(readPersistedResult(directory, messageId)?.text).toBe("echo:bye");
    await stopDaemon(fixture);
  });

  it("recovers an interrupted session over IPC after a hard daemon restart", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);
    const sent = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "HOLD mid-flight",
      mode: "queue",
    });
    const messageId = sent.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId });
      return status.state === "running";
    });
    // Wait for the partial output to be flushed to disk, not just for the running state:
    // "running" is recorded before the prompt round trip, so the chunks may still be in
    // flight. Waiting here makes the assertion on the recovered partial output deterministic.
    await waitUntilAsync(async () => String(readPersistedPreview(directory) ?? "").includes("echo:HOLD"));

    // Hard restart: SIGKILL leaves the in-flight message non-terminal on disk and leaves a
    // stale lock + socket behind for the next daemon to take over.
    fixture.proc.kill("SIGKILL");
    await waitForExit(fixture.proc, 5000);

    const restarted = await startDaemon({ reuse: fixture });
    expect((await restarted.client.call("list_sessions")).sessions).toEqual([]);

    const sessionStatus = await restarted.client.call("message_result", { session_id: sessionId });
    expect(sessionStatus.state).toBe("interrupted");
    expect(sessionStatus.orphaned).toBe(true);
    expect(sessionStatus.persisted).toBe(true);

    const status = await restarted.client.call("message_result", {
      session_id: sessionId,
      message_id: messageId,
    });
    expect(status.terminal).toBe(true);
    expect(status.state).toBe("failed");
    expect(status.orphaned).toBe(true);
    expect((status.error as { code: string }).code).toBe("interrupted");
    // The recovered mode matches how the message was sent, not a hard-coded default.
    expect(status.mode).toBe("queue");

    const result = await restarted.client.call("message_result", {
      session_id: sessionId,
      message_id: messageId,
    });
    expect(result.terminal).toBe(true);
    expect(result.state).toBe("failed");
    expect(result.orphaned).toBe(true);
    expect(result.mode).toBe("queue");

    // The partial output the turn had produced before the crash is still readable.
    const live = await restarted.client.call("live_output", {
      session_id: sessionId,
      message_id: messageId,
      offset: 0,
    });
    expect(String(live.chunk)).toContain("echo:HOLD mid-flight");
    expect(live.stopped).toBe(true);

    // The reconciliation was written back, not just reported.
    expect(readPersistedState(directory)?.state).toBe("interrupted");
    expect(readPersistedResult(directory, messageId)?.state).toBe("failed");
    // A second read stays terminal: nothing can be resurrected.
    const again = await restarted.client.call("message_result", {
      session_id: sessionId,
      message_id: messageId,
    });
    expect(again.state).toBe("failed");
    expect(again.terminal).toBe(true);
    await stopDaemon(restarted);
  });

  it("fails a message on a malformed stdout stream with no partial result", async () => {
    const fixture = await startDaemon();
    const cases: Array<[string, string]> = [
      ["bad-json", "invalid_json"],
      ["bad-object", "malformed_message"],
      ["bad-rpc", "malformed_message"],
      ["bad-response", "malformed_message"],
    ];
    for (const [text, code] of cases) {
      const { sessionId } = await createSession(fixture.client, fixture.dir);
      const sent = await fixture.client.call("send_message", { session_id: sessionId, text });
      const messageId = sent.message_id as string;
      const status = await waitForTerminal(fixture.client, sessionId, messageId);
      expect(status.state, text).toBe("failed");
      expect((status.error as { code: string }).code, text).toBe(code);

      // No partial success: the final text/tool_calls are gone, the error is machine-readable,
      // and the already-streamed output is available only as a diagnostic preview.
      const result = await fixture.client.call("message_result", {
        session_id: sessionId,
        message_id: messageId,
      });
      expect(result.terminal).toBe(true);
      expect(result.text).toBeNull();
      expect(result.tool_calls).toEqual([]);
      const live = await fixture.client.call("live_output", {
        session_id: sessionId,
        message_id: messageId,
        offset: 0,
      });
      expect(String(live.chunk)).toContain(`echo:${text}`);

      // The transport was closed, so a later submit fails fast (code `transport`) instead of
      // leaving a dangling turn.
      const after = await fixture.client.call("send_message", { session_id: sessionId, text: "after" });
      const afterStatus = await waitForTerminal(fixture.client, sessionId, after.message_id as string);
      expect(afterStatus.state).toBe("failed");
      expect((afterStatus.error as { code: string }).code).toBe("transport");
      await fixture.client.call("close_session", { session_id: sessionId });
    }
    await stopDaemon(fixture);
  });

  it("fails a message on an oversized stdout line with a limit code", async () => {
    const fixture = await startDaemon({ maxReadBytes: 8 * 1024 });
    const soft = await createSession(fixture.client, fixture.dir);
    const softSent = await fixture.client.call("send_message", { session_id: soft.sessionId, text: "oversize-soft" });
    const softStatus = await waitForTerminal(fixture.client, soft.sessionId, softSent.message_id as string);
    expect(softStatus.state).toBe("failed");
    expect((softStatus.error as { code: string }).code).toBe("line_too_large");

    const hard = await createSession(fixture.client, fixture.dir);
    const hardSent = await fixture.client.call("send_message", { session_id: hard.sessionId, text: "oversize-hard" });
    const hardStatus = await waitForTerminal(fixture.client, hard.sessionId, hardSent.message_id as string);
    expect(hardStatus.state).toBe("failed");
    expect((hardStatus.error as { code: string }).code).toBe("output_limit");
    await stopDaemon(fixture);
  });

  it("fails a message when the harness never responds (output_timeout)", async () => {
    const fixture = await startDaemon({ turnTimeoutSeconds: 1 });
    const { sessionId } = await createSession(fixture.client, fixture.dir);
    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "HANG forever" });
    const status = await waitForTerminal(fixture.client, sessionId, sent.message_id as string);
    expect(status.state).toBe("failed");
    expect((status.error as { code: string }).code).toBe("output_timeout");
    await stopDaemon(fixture);
  });

  it("fails session creation on malformed harness output and leaves nothing behind", async () => {
    const fixture = await startDaemon({ emitGarbage: true });
    await expect(
      fixture.client.call("create_session", { harness: "codebuddy", cwd: fixture.dir, model_id: "fake-model" }),
    ).rejects.toMatchObject({ code: "invalid_json" });
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    expect(existsSync(fixture.sessionDir)).toBe(true);
    expect(readdirSync(fixture.sessionDir)).toEqual([]);
    await stopDaemon(fixture);
  });

  it("reaps the harness process group when the daemon is SIGKILLed", async () => {
    const childPidFile = join(tmpDir("hab-child-"), "harness-child.pid");
    const fixture = await startDaemon({ extraEnv: { FAKE_HARNESS_CHILD_PID_FILE: childPidFile } });
    const { sessionId, created } = await createSession(fixture.client, fixture.dir);
    const harnessPid = (created.launch_info as Record<string, unknown>).transport_pid as number;
    expect(typeof harnessPid).toBe("number");

    // The harness spawns a long-lived child in its own process group.
    await waitUntilAsync(async () => existsSync(childPidFile));
    const childPid = Number.parseInt(readFileSync(childPidFile, "utf8").trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isAlive(harnessPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    // The daemon dies without any chance to clean up; the supervisor must notice on its own.
    fixture.proc.kill("SIGKILL");
    await waitForExit(fixture.proc, 5000);

    await waitUntilAsync(async () => !isAlive(harnessPid) && !isAlive(childPid), 20_000);
    expect(isAlive(harnessPid)).toBe(false);
    // The whole group is gone, not just the harness process.
    expect(isAlive(childPid)).toBe(false);
    // The daemon itself is gone, so a restart is the only way to reach the session again.
    expect(await fixture.client.ping()).toBeNull();
    void sessionId;
  });

  it("runs remote cleanup when the daemon is SIGKILLed", async () => {
    const fixture = await startDaemon({ mockSsh: true });
    const { created } = await createSession(fixture.client, fixture.dir, {
      target: "remote",
      remote_host: "build-host",
    });
    const pidFile = String((created.launch_info as Record<string, unknown>).remote_pid_file);
    expect(existsSync(join(tmpdir(), pidFile))).toBe(true);

    fixture.proc.kill("SIGKILL");
    await waitForExit(fixture.proc, 5000);

    // The supervisor kills the local ssh and then issues the explicit remote cleanup, which
    // removes the remote pid file. `read harness_pid harness_pgid` only appears in the
    // explicit cleanup command, so this proves supervision (not just the wrapper's own trap).
    await waitUntilAsync(
      async () => sshCalls(fixture).some((call) => call.command.includes("read harness_pid harness_pgid")),
      20_000,
    );
    await waitUntilAsync(async () => !existsSync(join(tmpdir(), pidFile)), 20_000);
    expect(existsSync(join(tmpdir(), pidFile))).toBe(false);
  });

  it("runs container cleanup when the daemon is SIGKILLed", async () => {
    const fixture = await startDaemon({ mockDocker: true });
    const { created } = await createSession(fixture.client, fixture.dir, {
      runtime: "docker",
      docker_image: "mock/image:1",
      cwd: "/work",
    });
    const containerName = (created.launch_info as Record<string, unknown>)
      .docker_container_name as string;
    expect(dockerCalls(fixture).some((call) => call.argv[0] === "rm")).toBe(false);

    fixture.proc.kill("SIGKILL");
    await waitForExit(fixture.proc, 5000);

    await waitUntilAsync(
      async () => dockerCalls(fixture).some((call) => call.argv[0] === "rm" && call.argv.includes(containerName)),
      20_000,
    );
  });

  it("never removes a reused container when the daemon is SIGKILLed", async () => {
    const fixture = await startDaemon({ mockDocker: true });
    const dockerId = "d".repeat(64);
    await createSession(fixture.client, fixture.dir, {
      runtime: "docker",
      cwd: "/work",
      docker_id: dockerId,
      container_policy: "keep",
    });

    fixture.proc.kill("SIGKILL");
    await waitForExit(fixture.proc, 5000);

    // The supervisor still applies the keep policy after the daemon dies, and the
    // caller-owned container is stopped, never removed.
    await waitUntilAsync(
      async () => dockerCalls(fixture).some((call) => call.argv[0] === "stop" && call.argv.includes(dockerId)),
      20_000,
    );
    expect(dockerCalls(fixture).some((call) => call.argv[0] === "rm")).toBe(false);
  });

  it("refuses a concurrent create_session racing for the same session id", async () => {
    const fixture = await startDaemon();
    const sessionId = "2026-01-01-race0001";
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        fixture.client.call("create_session", {
          harness: "codebuddy",
          cwd: fixture.dir,
          model_id: "fake-model",
          session_id: sessionId,
        }),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "session_exists" });

    // The winner is the only live session, and its directory still holds its own files.
    const sessions = await fixture.client.call("list_sessions");
    expect((sessions.sessions as Array<{ session_id: string }>).map((s) => s.session_id)).toEqual([sessionId]);
    const files = readdirSync(join(fixture.sessionDir, sessionId));
    expect(files).toContain("meta.json");
    expect(files).toContain("state.json");
    // The winner still works.
    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "still mine" });
    await waitForTerminal(fixture.client, sessionId, sent.message_id as string);
    const result = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: sent.message_id,
    });
    expect(result.text).toBe("echo:still mine");
    await stopDaemon(fixture);
  });

  it("refuses an explicit session_id that already exists and does not touch the old session", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);
    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "history" });
    const messageId = sent.message_id as string;
    await waitForTerminal(fixture.client, sessionId, messageId);
    await fixture.client.call("close_session", { session_id: sessionId });
    const before = readFileSync(join(directory, "queue.json"), "utf8");

    await expect(
      fixture.client.call("create_session", {
        cwd: fixture.dir,
        model_id: "fake-model",
        session_id: sessionId,
      }),
    ).rejects.toMatchObject({ code: "session_exists" });

    // The historical session is untouched.
    expect(readFileSync(join(directory, "queue.json"), "utf8")).toBe(before);
    expect(readPersistedResult(directory, messageId)?.text).toBe("echo:history");
    expect(
      (await fixture.client.call("message_result", { session_id: sessionId, message_id: messageId })).text,
    ).toBe("echo:history");
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    await stopDaemon(fixture);
  });

  it("removes only the directory it created when session creation fails", async () => {
    const fixture = await startDaemon({ brokenCodex: true });
    await expect(
      fixture.client.call("create_session", {
        harness: "codex",
        cwd: fixture.dir,
        model_id: "fake-model",
      }),
    ).rejects.toBeTruthy();

    // No half-initialized session directory is left behind...
    expect(existsSync(fixture.sessionDir)).toBe(true);
    expect(readdirSync(fixture.sessionDir)).toEqual([]);
    // ...and no session was registered.
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    // The daemon is still healthy enough to create a real session afterwards.
    const { sessionId } = await createSession(fixture.client, fixture.dir);
    expect(sessionId).toBeTruthy();
    await stopDaemon(fixture);
  });

  it("routes thinking_level for each harness after model selection", async () => {
    const fixture = await startDaemon();
    for (const [harness, configId] of [
      ["codebuddy", "thought_level"],
      ["codex", "reasoning_effort"],
      ["agy", "thinking_level"],
    ]) {
      const { directory } = await createSession(fixture.client, fixture.dir, {
        harness,
        thinking_level: "high",
      });
      const commands = clientRequests(directory);
      const index = commands.findIndex((call) => call.method === "session/set_config_option" &&
        (call.params as Record<string, unknown>).configId === configId);
      expect(index).toBeGreaterThan(-1);
      expect(commands[index]?.params).toEqual({ sessionId: "fake-1", configId, value: "high" });
      if (harness !== "codebuddy") {
        expect(commands.findIndex((call) => call.method === "session/set_model")).toBeLessThan(index);
      }
    }
    await stopDaemon(fixture);
  });

  it("applies a thinking_level on set_model to the new model and rejects undeclared levels", async () => {
    const fixture = await startDaemon();
    const { sessionId, directory } = await createSession(fixture.client, fixture.dir);

    // fake-model-2 declares [low]; an undeclared level is rejected before the switch.
    await expect(
      fixture.client.call("set_model", {
        session_id: sessionId,
        model_id: "fake-model-2",
        thinking_level: "high",
      }),
    ).rejects.toMatchObject({ code: "invalid_thinking_level" });
    expect((await fixture.client.call("message_result", { session_id: sessionId })).model_id).toBe("fake-model");
    expect(clientRequests(directory).some((call) => call.method === "session/set_config_option")).toBe(false);

    // A declared level is routed to the NEW model, after the model switch.
    const set = await fixture.client.call("set_model", {
      session_id: sessionId,
      model_id: "fake-model-2",
      thinking_level: "low",
    });
    expect(set).toMatchObject({ status: "model_set", model_id: "fake-model-2", thinking_level: "low" });
    const commands = clientRequests(directory);
    const switchIndex = commands.findIndex((call) => call.method === "session/set_model");
    const levelIndex = commands.findIndex(
      (call) =>
        call.method === "session/set_config_option" &&
        (call.params as Record<string, unknown>).configId === "thought_level",
    );
    expect(switchIndex).toBeGreaterThan(-1);
    expect(levelIndex).toBeGreaterThan(switchIndex);
    expect(commands[levelIndex]?.params).toEqual({ sessionId: "fake-1", configId: "thought_level", value: "low" });

    // Omitting thinking_level keeps the previous behaviour: only the model changes.
    const before = commands.length;
    const plain = await fixture.client.call("set_model", { session_id: sessionId, model_id: "fake-model" });
    expect(plain).toMatchObject({ status: "model_set", model_id: "fake-model" });
    expect(plain.thinking_level).toBeUndefined();
    const after = clientRequests(directory);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.method).toBe("session/set_model");
    await stopDaemon(fixture);
  });

  it("routes permission modes per harness (argv, ACP config option, ACP mode)", async () => {
    const fixture = await startDaemon();

    // CodeBuddy: mode travels on argv (no ACP round trip).
    const codebuddy = await createSession(fixture.client, fixture.dir, { permission_mode: "read" });
    const codebuddyCommands = clientRequests(codebuddy.directory);
    expect(codebuddyCommands.some((call) => call.method === "session/set_config_option")).toBe(false);
    expect(codebuddyCommands.some((call) => call.method === "session/set_mode")).toBe(false);
    const codebuddyMeta = JSON.parse(readFileSync(join(codebuddy.directory, "meta.json"), "utf8"));
    expect(codebuddyMeta.echo.args).toContain("--permission-mode");
    expect(codebuddyMeta.echo.args).toContain("plan");
    const buddyYolo = await createSession(fixture.client, fixture.dir, {
      harness: "codebuddy", permission_mode: "yolo",
    });
    const buddyArgs = JSON.parse(readFileSync(join(buddyYolo.directory, "meta.json"), "utf8")).echo.args;
    expect(buddyArgs).toContain("bypassPermissions");
    expect(buddyYolo.created.permission_mode).toBe("yolo");

    // Codex: `session/set_config_option` maps the permission mode.
    const codex = await createSession(fixture.client, fixture.dir, {
      harness: "codex",
      permission_mode: "yolo",
    });
    const codexCommands = clientRequests(codex.directory);
    expect(codexCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session/set_config_option",
          params: { sessionId: "fake-1", configId: "mode", value: "agent-full-access" },
        }),
      ]),
    );

    // Agy: `session/set_mode` uses the configured agy_<mode>_mode_id.
    const agy = await createSession(fixture.client, fixture.dir, {
      harness: "agy",
      permission_mode: "edit",
    });
    const agyCommands = clientRequests(agy.directory);
    expect(agyCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session/set_mode",
          params: { sessionId: "fake-1", modeId: "agy-edit-mode" },
        }),
      ]),
    );
    const agyYolo = await createSession(fixture.client, fixture.dir, {
      harness: "agy", permission_mode: "yolo",
    });
    expect(clientRequests(agyYolo.directory)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "session/set_mode", params: { sessionId: "fake-1", modeId: "yolo" },
      }),
    ]));
    await stopDaemon(fixture);
  });

  it("probes authentication and only accepts a harvested, whitelisted account", async () => {
    const fixture = await startDaemon({ authRequired: true });
    const created = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
    });
    expect(created.state).toBe("authentication_required");
    expect(created.authenticated).toBe(false);
    const sessionId = created.session_id as string;

    const before = await fixture.client.call("auth_info", { session_id: sessionId });
    expect(before.authenticated).toBe(false);
    expect(before.auth_methods).toEqual([{ id: "api-key", name: "API key" }]);

    await fixture.client.call("authenticate", { session_id: sessionId, method_id: "api-key" });
    const after = await fixture.client.call("auth_info", { session_id: sessionId });
    expect(after.authenticated).toBe(true);
    expect(after.state).toBe("ready");
    // The harness returned a live `token`; only whitelisted identity fields survive.
    expect(after.user).toEqual({ userId: "u-1", email: "user@example.com", name: "Test User" });
    await stopDaemon(fixture);
  });

  it("rate limits authentication per harness+target and can be disabled", async () => {
    const fixture = await startDaemon({
      authRequired: true,
      rateLimit: { enabled: true, minIntervalSeconds: 0, maxAttempts: 1, windowSeconds: 3600 },
    });
    const first = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
    });
    expect(first.state).toBe("authentication_required");
    const allowed = await fixture.client.call("authenticate", {
      session_id: first.session_id,
      method_id: "api-key",
    });
    expect(allowed.status).toBe("ready");
    expect(allowed.authenticated).toBe(true);

    // A second session on the same harness+local target spends the same budget.
    const second = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
    });
    const limited = await fixture.client.call("authenticate", {
      session_id: second.session_id,
      method_id: "api-key",
    });
    expect(limited.status).toBe("authentication_rate_limited");
    expect(limited.remaining_attempts).toBe(0);
    expect(limited.retry_after_seconds as number).toBeGreaterThan(0);

    // The ledger is a private file holding only a target hash, never the harness/host text.
    const ledgerPath = join(fixture.dir, "auth-rate.json");
    const ledger = readFileSync(ledgerPath, "utf8");
    expect(ledger).not.toContain("codebuddy");
    expect(ledger).not.toContain("build-host");
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    await stopDaemon(fixture);

    // Disabling the rate limit allows every attempt and never creates the ledger.
    const disabled = await startDaemon({
      authRequired: true,
      rateLimit: { enabled: false, minIntervalSeconds: 0, maxAttempts: 1, windowSeconds: 3600 },
    });
    for (let index = 0; index < 2; index += 1) {
      const created = await disabled.client.call("create_session", {
        harness: "codebuddy",
        cwd: disabled.dir,
        model_id: "fake-model",
      });
      const result = await disabled.client.call("authenticate", {
        session_id: created.session_id,
        method_id: "api-key",
      });
      expect(result.status).toBe("ready");
    }
    expect(existsSync(join(disabled.dir, "auth-rate.json"))).toBe(false);
    await stopDaemon(disabled);
  });

  it("closes and cleans up a session when interactive authentication times out", async () => {
    const fixture = await startDaemon({ authRequired: true, authHang: true, authTimeoutSeconds: 0.5 });
    const created = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
    });
    expect(created.state).toBe("authentication_required");
    const sessionId = created.session_id as string;
    const directory = created.directory as string;

    const timedOut = await fixture.client.call("authenticate", { session_id: sessionId, method_id: "api-key" });
    expect(timedOut.status).toBe("authentication_timed_out");

    // The session was closed and unregistered, so it can no longer be driven.
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    await expect(
      fixture.client.call("send_message", { session_id: sessionId, text: "too late" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
    // Its on-disk record is closed, not left mid-authentication.
    expect(readPersistedState(directory)?.state).toBe("closed");
    await stopDaemon(fixture);
  });

  it("applies create_session's authenticate parameter through the same limits", async () => {
    const fixture = await startDaemon({
      authRequired: true,
      rateLimit: { enabled: true, minIntervalSeconds: 0, maxAttempts: 1, windowSeconds: 3600 },
    });
    const first = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
      authenticate: "api-key",
    });
    expect(first.status).toBe("ready");
    expect(first.authenticated).toBe(true);

    // The convenience parameter cannot bypass the ledger.
    const second = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
      authenticate: "api-key",
    });
    expect(second.status).toBe("authentication_rate_limited");
    await stopDaemon(fixture);
  });

  it("shows the latest whitelisted account and never persists credentials", async () => {
    const fixture = await startDaemon({ authRequired: true });
    const created = await fixture.client.call("create_session", {
      harness: "codebuddy",
      cwd: fixture.dir,
      model_id: "fake-model",
    });
    const sessionId = created.session_id as string;
    const directory = created.directory as string;
    await fixture.client.call("authenticate", { session_id: sessionId, method_id: "api-key" });

    const info = await fixture.client.call("auth_info", { session_id: sessionId });
    expect(info.authenticated).toBe(true);
    expect(info.user).toEqual({ userId: "u-1", email: "user@example.com", name: "Test User" });
    expect(info.user).not.toHaveProperty("token");

    // The harness token never reaches the session directory.
    const files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile());
    for (const file of files) {
      expect(readFileSync(join(directory, file.name), "utf8")).not.toContain("live-secret-token");
    }
    await stopDaemon(fixture);
  });

  it("never wipes a caller-owned container when a reused Docker launch fails", async () => {
    const fixture = await startDaemon({ mockDocker: true, brokenCodex: true });
    const dockerId = "c".repeat(64);
    await expect(
      fixture.client.call("create_session", {
        harness: "codex",
        cwd: "/work",
        model_id: "fake-model",
        runtime: "docker",
        docker_id: dockerId,
      }),
    ).rejects.toBeTruthy();

    const calls = dockerCalls(fixture);
    expect(calls.some((call) => call.argv[0] === "start" && call.argv[1] === dockerId)).toBe(true);
    // The kept policy stops (never removes) the container the caller supplied.
    expect(calls.some((call) => call.argv[0] === "stop" && call.argv.includes(dockerId))).toBe(true);
    expect(calls.some((call) => call.argv[0] === "rm")).toBe(false);
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    await stopDaemon(fixture);
  });

  it("cleans up a Docker container exactly once when the session closes", async () => {
    const fixture = await startDaemon({ mockDocker: true });
    const { sessionId, created } = await createSession(fixture.client, fixture.dir, {
      runtime: "docker",
      docker_image: "mock/image:1",
      cwd: "/work",
    });
    const containerName = (created.launch_info as Record<string, unknown>).docker_container_name as string;

    await fixture.client.call("close_session", { session_id: sessionId });
    const removals = dockerCalls(fixture).filter((call) => call.argv[0] === "rm");
    expect(removals).toEqual([{ argv: ["rm", "-f", containerName] }]);
    await stopDaemon(fixture);
  });

  it("long-polls live_output for new output and for the wait timeout", async () => {
    const fixture = await startDaemon();
    const { sessionId } = await createSession(fixture.client, fixture.dir);

    // Case 1: nothing new arrives -> returns after wait_ms instead of hanging.
    const held = await fixture.client.call("send_message", {
      session_id: sessionId,
      text: "HOLD waiting",
      mode: "queue",
    });
    const heldId = held.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: heldId });
      return status.state === "running";
    });
    const consumed = await fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: heldId,
      offset: 0,
    });
    const startedAt = Date.now();
    const idle = await fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: heldId,
      offset: consumed.next_offset,
      wait_ms: 500,
    });
    expect(idle.chunk).toBe("");
    expect(idle.waited_ms as number).toBeGreaterThanOrEqual(400);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    await fixture.client.call("cancel_message", { session_id: sessionId, message_id: heldId });

    // Case 2: output arrives while the long-poll is in flight -> returns promptly with it.
    const asking = await fixture.client.call("send_message", { session_id: sessionId, text: "please permission" });
    const askingId = asking.message_id as string;
    await waitUntilAsync(async () => {
      const status = await fixture.client.call("message_result", { session_id: sessionId, message_id: askingId });
      return status.state === "waiting_input";
    });
    const readSoFar = await fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: askingId,
      offset: 0,
    });
    const pending = fixture.client.call("live_output", {
      session_id: sessionId,
      message_id: askingId,
      offset: readSoFar.next_offset,
      wait_ms: 8000,
    });
    await sleep(150);
    await fixture.client.call("answer_question", {
      session_id: sessionId,
      message_id: askingId,
      request_id: "9000",
      response: { option_id: "allow_once" },
    });
    const arrived = await pending;
    expect(String(arrived.chunk)).toContain("[allowed:allow_once]");
    expect(arrived.waited_ms as number).toBeLessThan(8000);
    await stopDaemon(fixture);
  });

  it("rejects launch internals and unknown sessions", async () => {
    const fixture = await startDaemon();
    await expect(
      fixture.client.call("create_session", { cwd: fixture.dir, model_id: "fake-model", env: { A: "1" } }),
    ).rejects.toMatchObject({ code: "launch_internal" });
    await expect(
      fixture.client.call("create_session", { cwd: fixture.dir, model_id: "fake-model", base_dir: "/tmp" }),
    ).rejects.toMatchObject({ code: "launch_internal" });
    await expect(
      fixture.client.call("create_session", { cwd: fixture.dir, model_id: "fake-model", nope: 1 }),
    ).rejects.toMatchObject({ code: "unknown_param" });
    await expect(
      fixture.client.call("send_message", { session_id: "does-not-exist", text: "x" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
    await expect(
      fixture.client.call("message_result", { session_id: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
    await expect(
      fixture.client.call("message_result", { session_id: "does-not-exist", message_id: "msg-1" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
    // Path-like or otherwise unsafe ids are never resolved to a directory.
    for (const unsafe of ["../etc", "a/b", "..", "."]) {
      await expect(
        fixture.client.call("message_result", { session_id: unsafe }),
      ).rejects.toMatchObject({ code: "unknown_session" });
    }
    await stopDaemon(fixture);
  });

  it("rejects invalid launch combinations before starting anything", async () => {
    const fixture = await startDaemon();
    const base = { cwd: fixture.dir, model_id: "fake-model" };
    const rejects = async (params: Record<string, unknown>, code = "invalid_param"): Promise<void> => {
      await expect(fixture.client.call("create_session", params)).rejects.toMatchObject({ code });
    };

    // Caller-supplied launch internals are refused outright.
    await rejects({ ...base, env: { A: "1" } }, "launch_internal");
    await rejects({ ...base, command: "/bin/sh" }, "launch_internal");
    await rejects({ ...base, ssh_host: "host" }, "launch_internal");
    await rejects({ ...base, args: ["--x"] }, "launch_internal");
    await rejects({ ...base, base_dir: "/tmp" }, "launch_internal");
    await rejects({ ...base, entrypoint: "/bin/sh" }, "launch_internal");
    // Unknown parameters are not silently ignored.
    await rejects({ ...base, nope: 1 }, "unknown_param");

    const dockerId = "d".repeat(64);
    await rejects({ ...base, runtime: "direct", docker_image: "img" });
    await rejects({ ...base, runtime: "direct", mounts: [{ source: "/a", target: "/b" }] });
    await rejects({ ...base, runtime: "direct", host_network: true });
    await rejects({ ...base, runtime: "direct", docker_id: dockerId });
    // runtime=docker requires an image (or a reused container), an absolute container cwd,
    // and a well-formed container id.
    await rejects({ ...base, runtime: "docker", cwd: "/work" });
    await rejects({ ...base, runtime: "docker", cwd: "relative", docker_image: "img" });
    await rejects({ ...base, runtime: "docker", cwd: "/work", docker_id: "not-an-id" });
    // A reused container fixes its own image/mounts/ports/network.
    await rejects({ ...base, runtime: "docker", cwd: "/work", docker_id: dockerId, docker_image: "img" });
    await rejects({
      ...base,
      runtime: "docker",
      cwd: "/work",
      docker_id: dockerId,
      mounts: [{ source: "/a", target: "/b" }],
    });
    // host_network cannot be combined with published ports.
    await rejects({
      ...base,
      runtime: "docker",
      cwd: "/work",
      docker_image: "img",
      host_network: true,
      ports: [{ host_port: 1, container_port: 2 }],
    });
    // Mount and port validation.
    await rejects({ ...base, runtime: "docker", cwd: "/work", docker_image: "img", mounts: [{ source: "rel", target: "/b" }] });
    await rejects({
      ...base,
      runtime: "docker",
      cwd: "/work",
      docker_image: "img",
      mounts: [
        { source: "/a", target: "/same" },
        { source: "/b", target: "/same" },
      ],
    });
    await rejects({
      ...base,
      runtime: "docker",
      cwd: "/work",
      docker_image: "img",
      ports: [{ host_port: 0, container_port: 2 }],
    });
    await rejects({
      ...base,
      runtime: "docker",
      cwd: "/work",
      docker_image: "img",
      ports: [{ host_port: 1, container_port: 2, protocol: "sctp" }],
    });
    await rejects({
      ...base,
      runtime: "docker",
      cwd: "/work",
      docker_image: "img",
      ports: [{ host_port: 1, container_port: 2, host_ip: "999.1.1.1" }],
    });
    // Target/remote_host pairing and harness name.
    await rejects({ ...base, target: "remote" });
    await rejects({ ...base, target: "local", remote_host: "host" });
    await rejects({ ...base, harness: "not-a-harness" });
    await rejects({ ...base, permission_mode: "sudo" });
    await rejects({ ...base, docker_image: "-oops" }, "invalid_param");

    // Nothing was started by any of the rejected calls.
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    await stopDaemon(fixture);
  });

  it("creates a new Docker container, runs a turn through it, and removes it on close", async () => {
    const fixture = await startDaemon({ mockDocker: true });
    const { sessionId, directory, created } = await createSession(fixture.client, fixture.dir, {
      runtime: "docker",
      docker_image: "mock/image:1",
      cwd: "/work",
      permission_mode: "read",
      mounts: [{ source: fixture.dir, target: "/data", read_only: true }],
      ports: [{ host_port: 18080, container_port: 8080, protocol: "tcp", host_ip: "127.0.0.1" }],
    });

    const calls = dockerCalls(fixture);
    const runCall = calls.find((call) => call.argv[0] === "run");
    expect(runCall).toBeTruthy();
    const runArgv = runCall!.argv;
    const nameIndex = runArgv.indexOf("--name");
    const containerName = runArgv[nameIndex + 1];
    expect(containerName).toMatch(/^harness-acp-[0-9a-f]+$/);
    expect(runArgv).toEqual(
      expect.arrayContaining([
        "--detach",
        "--init",
        "--mount",
        `type=bind,src=${fixture.dir},dst=/data,readonly`,
        "-p",
        "127.0.0.1:18080:8080/tcp",
        "--entrypoint",
        "/bin/sh",
        "mock/image:1",
      ]),
    );
    expect(runArgv.includes("--network")).toBe(false);
    // The container working directory is created inside the container.
    const workdirCall = calls.find(
      (call) => call.argv[0] === "exec" && call.argv.includes("mkdir") && call.argv.includes("/work"),
    );
    expect(workdirCall).toBeTruthy();
    // The harness is executed inside the container via `docker exec --workdir`.
    const transportCall = calls.find(
      (call) => call.argv[0] === "exec" && call.argv.includes("--workdir") && call.argv.includes(FIXTURE),
    );
    expect(transportCall).toBeTruthy();

    const launch = created.launch_info as Record<string, unknown>;
    expect(launch).toMatchObject({
      runtime: "docker",
      container_policy: "remove",
      reused_container: false,
      docker_image: "mock/image:1",
      host_network: false,
      docker_container_name: containerName,
    });
    // A container that will be removed reports no top-level id: there is nothing to reuse.
    expect(created).not.toHaveProperty("docker_id");
    expect(launch.mounts).toEqual([{ source: fixture.dir, target: "/data", read_only: true }]);
    expect(launch.ports).toEqual([
      { host_port: 18080, container_port: 8080, protocol: "tcp", host_ip: "127.0.0.1" },
    ]);
    const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
    expect(meta.params.docker).toMatchObject({ docker_image: "mock/image:1", reused_container: false });

    // A real turn flows through the mock container.
    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "docker hi" });
    await waitForTerminal(fixture.client, sessionId, sent.message_id as string);
    const result = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: sent.message_id,
    });
    expect(result.text).toBe("echo:docker hi");

    await fixture.client.call("close_session", { session_id: sessionId });
    const rmCall = dockerCalls(fixture).find((call) => call.argv[0] === "rm");
    expect(rmCall?.argv).toEqual(["rm", "-f", containerName]);
    await stopDaemon(fixture);
  });

  it("reuses a Docker container, echoes docker inspect, and leaves it running", async () => {
    const fixture = await startDaemon({ mockDocker: true });
    const dockerId = "c".repeat(64);
    const { sessionId, created } = await createSession(fixture.client, fixture.dir, {
      runtime: "docker",
      cwd: "/work",
      docker_id: dockerId,
      container_policy: "keep",
    });

    const calls = dockerCalls(fixture);
    expect(calls.some((call) => call.argv[0] === "start" && call.argv[1] === dockerId)).toBe(true);
    expect(calls.some((call) => call.argv[0] === "run")).toBe(false);
    const inspectCall = calls.find((call) => call.argv[0] === "inspect");
    expect(inspectCall).toBeTruthy();
    expect(inspectCall!.argv).toContain("--format");
    expect(inspectCall!.argv[inspectCall!.argv.length - 1]).toBe(dockerId);

    // A reused container reports what it actually holds, not request defaults.
    const launch = created.launch_info as Record<string, unknown>;
    expect(launch).toMatchObject({
      runtime: "docker",
      reused_container: true,
      container_policy: "keep",
      docker_image: "mock/image:1",
      host_network: true,
      docker_container_name: dockerId,
    });
    expect(launch.mounts).toEqual([{ source: "/host/data", target: "/data", read_only: true }]);
    expect(launch.ports).toEqual([
      { host_port: 18080, container_port: 8080, protocol: "tcp", host_ip: "127.0.0.1" },
    ]);
    // The reused container's real id is handed back for the next reuse.
    expect(created.docker_id).toBe(dockerId);

    await fixture.client.call("close_session", { session_id: sessionId });
    const after = dockerCalls(fixture);
    expect(after.some((call) => call.argv[0] === "stop" && call.argv.includes(dockerId))).toBe(true);
    // A caller-owned container is never removed.
    expect(after.some((call) => call.argv[0] === "rm")).toBe(false);
    await stopDaemon(fixture);
  });

  it("returns the new kept container's id and stops (never removes) it on close", async () => {
    const fixture = await startDaemon({ mockDocker: true });
    const session = await createSession(fixture.client, fixture.dir, {
      runtime: "docker",
      docker_image: "mock/image:1",
      cwd: "/work",
      container_policy: "keep",
    });

    // The mock `docker run` prints a full 64-hex id; the top-level result must surface it so
    // the caller can reuse the kept container in a later session.
    const containerId = "a".repeat(64);
    expect(session.created.docker_id).toBe(containerId);
    const launch = session.created.launch_info as Record<string, unknown>;
    expect(launch).toMatchObject({
      runtime: "docker",
      container_policy: "keep",
      reused_container: false,
    });
    // The generated container *name* is not the id the caller reuses.
    expect(launch.docker_container_name).toMatch(/^harness-acp-[0-9a-f]+$/);

    await fixture.client.call("close_session", { session_id: session.sessionId });
    const after = dockerCalls(fixture);
    // The keep policy stops the container the session created; it is left for reuse.
    expect(after.some((call) => call.argv[0] === "stop" && call.argv.includes(launch.docker_container_name as string))).toBe(true);
    expect(after.some((call) => call.argv[0] === "rm")).toBe(false);
    await stopDaemon(fixture);
  });

  it("launches over a remote SSH wrapper, tracks the pid file, and cleans up", async () => {
    const fixture = await startDaemon({ mockSsh: true });
    const { sessionId, created } = await createSession(fixture.client, fixture.dir, {
      target: "remote",
      remote_host: "build-host",
    });

    const launch = created.launch_info as Record<string, unknown>;
    expect(launch).toMatchObject({ target: "remote", runtime: "direct", remote_host: "build-host" });
    const pidFile = String(launch.remote_pid_file);
    expect(pidFile).toMatch(/^harness-acp-[0-9a-f]+\.pid$/);

    const calls = sshCalls(fixture);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].host).toBe("build-host");
    // The generated remote wrapper is a real supervised shell program.
    expect(calls[0].command).toContain("umask 077");
    expect(calls[0].command).toContain("set -m");
    expect(calls[0].command).toContain(`cd ${fixture.dir}`);
    expect(calls[0].command).toContain("harness_pgid=");
    expect(calls[0].command).toContain("trap ");

    const sent = await fixture.client.call("send_message", { session_id: sessionId, text: "remote hi" });
    await waitForTerminal(fixture.client, sessionId, sent.message_id as string);
    const result = await fixture.client.call("message_result", {
      session_id: sessionId,
      message_id: sent.message_id,
    });
    expect(result.text).toBe("echo:remote hi");
    // The remote wrapper recorded its pid file.
    expect(existsSync(join(tmpdir(), pidFile))).toBe(true);

    await fixture.client.call("close_session", { session_id: sessionId });
    const cleanup = sshCalls(fixture).at(-1);
    expect(cleanup?.command).toContain("kill -TERM");
    expect(existsSync(join(tmpdir(), pidFile))).toBe(false);

    // An unreachable host fails the launch and leaves no session behind.
    const before = readdirSync(fixture.sessionDir).sort();
    await expect(
      fixture.client.call("create_session", {
        cwd: fixture.dir,
        model_id: "fake-model",
        target: "remote",
        remote_host: "missing-host",
      }),
    ).rejects.toBeTruthy();
    expect((await fixture.client.call("list_sessions")).sessions).toEqual([]);
    expect(readdirSync(fixture.sessionDir).sort()).toEqual(before);
    await stopDaemon(fixture);
  });

  it("refuses a second daemon on the same lock", async () => {
    const fixture = await startDaemon();
    const second = spawn(process.execPath, [DIST_DAEMON, "--config", fixture.configPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    processes.push(second);
    const stderrChunks: string[] = [];
    second.stderr?.setEncoding("utf8");
    second.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => second.on("exit", (value) => resolve(value)));
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("already running");
    // The original daemon is unaffected.
    expect((await fixture.client.ping())?.status).toBe("ok");
    await stopDaemon(fixture);
  });
});

// --- MCP stdio client --------------------------------------------------------

describe("MCP stdio client", () => {
  it("exposes the full tool set and answers harness_info without a harness or daemon", async () => {
    const fixture = await startMcp();
    const listed = await fixture.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    const create = listed.tools.find((tool) => tool.name === "create_session");
    expect(create?.inputSchema.properties).toHaveProperty("thinking_level");
    expect(create?.inputSchema.properties?.permission_mode).toMatchObject({
      enum: ["read", "edit", "auto", "yolo"],
    });
    const setModel = listed.tools.find((tool) => tool.name === "set_model");
    expect(setModel?.inputSchema.properties).toHaveProperty("thinking_level");
    expect(setModel?.inputSchema.required).not.toContain("thinking_level");
    const answer = listed.tools.find((tool) => tool.name === "answer_question");
    expect(answer?.inputSchema.properties?.answer).toMatchObject({
      enum: ["accept", "reject", "timeout", "cancel"],
    });
    expect(answer?.inputSchema.required).not.toContain("response");
    const send = listed.tools.find((tool) => tool.name === "send_message");
    expect(send?.inputSchema.properties).toHaveProperty("idempotency_key");
    expect(send?.inputSchema.required).not.toContain("idempotency_key");

    const info = parseToolResult(
      await fixture.client.callTool({ name: "harness_info", arguments: { harness: "codebuddy" } }),
    );
    expect(info.source).toBe("config_file");
    const harnesses = info.harnesses as Record<string, Record<string, unknown>>;
    expect(Object.keys(harnesses)).toEqual(["codebuddy"]);
    expect(harnesses.codebuddy.permission_modes).toEqual(["read", "edit", "auto", "yolo"]);
    expect(harnesses.codebuddy.models).toEqual([
      { id: "fake-model", name: "Fake Model", thinking_levels: ["low", "high"] },
      { id: "fake-model-2", name: "Fake Model 2", thinking_levels: ["low"] },
    ]);

    // Listing all harnesses reports agy's config-dependent modes (edit configured, read not).
    const all = parseToolResult(await fixture.client.callTool({ name: "harness_info", arguments: {} }));
    const allHarnesses = all.harnesses as Record<string, Record<string, unknown>>;
    expect(Object.keys(allHarnesses)).toEqual(["agy", "codebuddy", "codex"]);
    expect(allHarnesses.agy.permission_modes).toEqual(["edit", "auto", "yolo"]);

    // Nothing was started: no socket and no session directory.
    expect(existsSync(fixture.socketPath)).toBe(false);
    expect(existsSync(fixture.sessionDir)).toBe(false);
    await stopMcp(fixture);
  });

  it("runs the async send_message -> poll -> result flow and notifies completion", async () => {
    const fixture = await startMcp();
    const created = parseToolResult(
      await fixture.client.callTool({ name: "create_session", arguments: { cwd: fixture.dir, model_id: "fake-model", thinking_level: "high" } }),
    );
    const sessionId = created.session_id as string;
    expect(created.state).toBe("ready");
    expect(clientRequests(created.directory as string)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "session/set_config_option", params: {
        sessionId: "fake-1", configId: "thought_level", value: "high",
      } }),
    ]));

    const sent = parseToolResult(
      await fixture.client.callTool({ name: "send_message", arguments: { session_id: sessionId, text: "hello mcp" } }),
    );
    expect(Object.keys(sent)).toEqual(["message_id"]);
    const messageId = sent.message_id as string;

    await waitUntilAsync(async () => {
      const status = parseToolResult(
        await fixture.client.callTool({
          name: "message_result",
          arguments: { session_id: sessionId, message_id: messageId },
        }),
      );
      return status.terminal === true;
    });
    const result = parseToolResult(
      await fixture.client.callTool({ name: "message_result", arguments: { session_id: sessionId, message_id: messageId } }),
    );
    expect(result.text).toBe("echo:hello mcp");

    const live = parseToolResult(
      await fixture.client.callTool({ name: "live_output", arguments: { session_id: sessionId, message_id: messageId } }),
    );
    expect(String(live.chunk)).toContain("echo:hello mcp");
    expect(live.stopped).toBe(true);

    // Best-effort completion notification over the negotiated logging capability.
    await waitUntilAsync(async () => fixture.notifications.length > 0, 10_000);
    expect((fixture.notifications[0].data as Record<string, unknown>).event).toBe("message_complete");

    const closed = parseToolResult(
      await fixture.client.callTool({ name: "close_session", arguments: { session_id: sessionId } }),
    );
    expect(closed.status).toBe("closed");
    await stopMcp(fixture);
  });

  it("replays an idempotency_key over MCP", async () => {
    const fixture = await startMcp();
    const created = parseToolResult(
      await fixture.client.callTool({ name: "create_session", arguments: { cwd: fixture.dir, model_id: "fake-model" } }),
    );
    const sessionId = created.session_id as string;

    const first = parseToolResult(
      await fixture.client.callTool({
        name: "send_message",
        arguments: { session_id: sessionId, text: "idem mcp", idempotency_key: "mcp-key" },
      }),
    );
    const second = parseToolResult(
      await fixture.client.callTool({
        name: "send_message",
        arguments: { session_id: sessionId, text: "idem mcp", idempotency_key: "mcp-key" },
      }),
    );
    expect(second.message_id).toBe(first.message_id);

    await waitUntilAsync(async () => {
      const status = parseToolResult(
        await fixture.client.callTool({
          name: "message_result",
          arguments: { session_id: sessionId, message_id: first.message_id },
        }),
      );
      return status.terminal === true;
    });
    const result = parseToolResult(
      await fixture.client.callTool({
        name: "message_result",
        arguments: { session_id: sessionId, message_id: first.message_id },
      }),
    );
    expect(result.text).toBe("echo:idem mcp");
    await stopMcp(fixture);
  });

  it("serves a closed session's status, result and preview through MCP", async () => {
    const fixture = await startMcp();
    const created = parseToolResult(
      await fixture.client.callTool({ name: "create_session", arguments: { cwd: fixture.dir, model_id: "fake-model" } }),
    );
    const sessionId = created.session_id as string;
    const sent = parseToolResult(
      await fixture.client.callTool({ name: "send_message", arguments: { session_id: sessionId, text: "goodbye mcp" } }),
    );
    const messageId = sent.message_id as string;
    await waitUntilAsync(async () => {
      const status = parseToolResult(
        await fixture.client.callTool({
          name: "message_result",
          arguments: { session_id: sessionId, message_id: messageId },
        }),
      );
      return status.terminal === true;
    });
    parseToolResult(await fixture.client.callTool({ name: "close_session", arguments: { session_id: sessionId } }));

    const sessionStatus = parseToolResult(
      await fixture.client.callTool({ name: "message_result", arguments: { session_id: sessionId } }),
    );
    expect(sessionStatus.state).toBe("closed");
    expect(sessionStatus.persisted).toBe(true);

    const status = parseToolResult(
      await fixture.client.callTool({ name: "message_result", arguments: { session_id: sessionId, message_id: messageId } }),
    );
    expect(status.terminal).toBe(true);
    expect(status.state).toBe("completed");

    const result = parseToolResult(
      await fixture.client.callTool({ name: "message_result", arguments: { session_id: sessionId, message_id: messageId } }),
    );
    expect(result.text).toBe("echo:goodbye mcp");

    const live = parseToolResult(
      await fixture.client.callTool({
        name: "live_output",
        arguments: { session_id: sessionId, message_id: messageId, offset: 0 },
      }),
    );
    expect(String(live.chunk)).toContain("echo:goodbye mcp");
    expect(live.stopped).toBe(true);
    await stopMcp(fixture);
  });
});
