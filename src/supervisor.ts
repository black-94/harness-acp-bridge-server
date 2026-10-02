#!/usr/bin/env node
/**
 * Per-session supervisor (port of `harness_acp_mcp/supervisor.py`).
 *
 * One supervisor process per session. The daemon spawns this process instead of the harness,
 * and speaks ACP to it: the supervisor is a byte-transparent stdio proxy for the harness, but
 * it — not the daemon — owns the harness process group and the container/remote resources.
 *
 *   prepare   `docker run` / `docker start`, then `docker exec … mkdir -p` (best effort)
 *   proxy     daemon stdin -> harness stdin, harness stdout/stderr -> daemon stdout/stderr,
 *             with backpressure and no parsing or rewriting
 *   supervise terminate the harness process group (TERM -> grace -> KILL) and release the
 *             container/remote per policy when the daemon goes away or asks for a close:
 *               - explicit close: the daemon closes our stdin (EOF) or signals us
 *               - daemon death: our stdin reaches EOF, our parent pid changes/is gone, or the
 *                 daemon pid is no longer alive (a SIGKILLed daemon closes its pipe, so EOF
 *                 normally fires first; the pid watchdog is the backstop)
 *             A container this supervisor may have half-created is force-removed; a reused
 *             container that was never entered is left exactly as the caller supplied it
 *   report    write supervisor/transport pids and the container id to a private metadata
 *             file the daemon reads for `launch_info`
 *
 * Because it lives in its own session, a SIGKILLed daemon cannot orphan the harness: the
 * supervisor notices and cleans up on its own.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeAtomicFileSync } from "./persistence.js";
import {
  SUPERVISOR_SPEC_ENV,
  buildTransportTarget,
  cleanupContainer,
  cleanupRemote,
  containerAction,
  ensureContainerWorkdir,
  prepareContainer,
  type CleanupAction,
  type SupervisorMetadata,
  type SupervisorSpec,
} from "./runtime.js";

/** How often the watchdog confirms the daemon is still alive. */
const WATCHDOG_INTERVAL_MS = 1000;
const TERMINATE_POLL_MS = 50;
const FLUSH_GRACE_MS = 2000;

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Delay used only while shutting down.
 *
 * Deliberately **referenced**: at cleanup time the harness child has already exited and our
 * stdin has ended, so an unref'd timer would let Node exit before the container/remote
 * cleanup runs.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group leader was already reaped; there is nothing left to signal.
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** TERM the group, wait up to `graceMs`, then KILL whatever survives. */
async function terminateGroup(pgid: number | null, graceMs: number): Promise<void> {
  if (pgid === null || !groupAlive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return;
    await delay(TERMINATE_POLL_MS);
  }
  signalGroup(pgid, "SIGKILL");
}

function readSpec(): SupervisorSpec {
  const raw = process.env[SUPERVISOR_SPEC_ENV];
  if (!raw) throw new Error("missing supervisor specification");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid supervisor specification: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid supervisor specification");
  }
  return parsed as SupervisorSpec;
}

interface SupervisorContext {
  spec: SupervisorSpec;
  /** Aborts an in-flight docker prepare so a slow pull/start can be reaped. */
  prepareAbort: AbortController;
  preparedOk: boolean;
  dockerId: string | null;
  harnessPgid: number | null;
  terminatedSignal: NodeJS.Signals | null;
  cleanupDone: Promise<void> | null;
  finishing: boolean;
}

function writeMetadata(spec: SupervisorSpec, child: ChildProcess, dockerId: string | null): void {
  const payload: SupervisorMetadata = {
    supervisor_pid: process.pid,
    transport_pid: typeof child.pid === "number" ? child.pid : null,
    transport_pgid: typeof child.pid === "number" ? child.pid : null,
    remote_pid_file: spec.remotePidFile,
    docker_id: dockerId,
    started_at: new Date().toISOString(),
  };
  try {
    writeAtomicFileSync(spec.metadataPath, `${JSON.stringify(payload)}\n`);
  } catch {
    // Metadata is advisory (used for launch_info); never fail the session over it.
  }
}

/** Flush buffered stdout before exiting so the final ACP message is never truncated. */
async function exitAfterFlush(code: number): Promise<never> {
  process.exitCode = code;
  if (process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => {
      // Referenced on purpose: the process must stay alive long enough to flush.
      const timer = setTimeout(resolve, FLUSH_GRACE_MS);
      process.stdout.once("drain", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return process.exit(code);
}

function exitCodeFor(context: SupervisorContext, fallback: number): number {
  return context.terminatedSignal ? (SIGNAL_EXIT_CODES[context.terminatedSignal] ?? fallback) : fallback;
}

async function cleanup(context: SupervisorContext): Promise<void> {
  if (context.cleanupDone) return context.cleanupDone;
  context.cleanupDone = performCleanup(context).catch(() => undefined);
  return context.cleanupDone;
}

async function performCleanup(context: SupervisorContext): Promise<void> {
  const { spec } = context;
  const action: CleanupAction = containerAction(context.preparedOk, spec.reuseContainer);
  // Reap an in-flight prepare first so no two Docker control commands race each other.
  context.prepareAbort.abort();
  await terminateGroup(context.harnessPgid, spec.terminateGraceSeconds * 1000);
  if (spec.launchMode === "ssh") await cleanupRemote(spec, action);
  else if (spec.dockerContainerName) await cleanupContainer(spec, action);
}

/** Clean up after the daemon disappears, then exit without waiting for the harness. */
async function shutdown(context: SupervisorContext): Promise<void> {
  if (context.finishing) return;
  context.finishing = true;
  await cleanup(context);
  await exitAfterFlush(0);
}

async function run(spec: SupervisorSpec): Promise<void> {
  const context: SupervisorContext = {
    spec,
    prepareAbort: new AbortController(),
    preparedOk: false,
    dockerId: null,
    harnessPgid: null,
    terminatedSignal: null,
    cleanupDone: null,
    finishing: false,
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (!context.terminatedSignal) context.terminatedSignal = signal;
    context.prepareAbort.abort();
    void shutdown(context);
  };
  process.on("SIGHUP", () => onSignal("SIGHUP"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Once the daemon is gone our stdout/stderr pipes are broken. A forwarded chunk that
  // arrives after that must not raise an uncaught EPIPE and abort the cleanup.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);

  // Backstop for a daemon that vanished without closing our pipe (SIGKILL already closes it,
  // so this rarely fires, but it also covers a reparented/foreign parent).
  const parentPid = process.ppid;
  const watchdog = setInterval(() => {
    if (process.ppid !== parentPid || process.ppid === 1 || !processAlive(spec.daemonPid)) {
      void shutdown(context);
    }
  }, WATCHDOG_INTERVAL_MS);
  if (typeof watchdog.unref === "function") watchdog.unref();

  let exitCode = 0;
  try {
    if (spec.dockerContainerName) {
      context.dockerId = await prepareContainer(spec, context.prepareAbort.signal);
      context.preparedOk = true;
      await ensureContainerWorkdir(spec, context.prepareAbort.signal);
    }
    if (context.terminatedSignal) {
      exitCode = exitCodeFor(context, 0);
    } else {
      const target = buildTransportTarget(spec);
      const child = spawn(target.argv[0] as string, target.argv.slice(1), {
        cwd: target.cwd ?? undefined,
        env: { ...process.env, ...target.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      context.harnessPgid = typeof child.pid === "number" ? child.pid : null;
      writeMetadata(spec, child, context.dockerId);
      wireProxy(child, context);
      exitCode = await waitForHarness(child);
    }
  } catch (error) {
    process.stderr.write(`harness supervisor: ${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = 1;
  } finally {
    await cleanup(context);
  }
  await exitAfterFlush(exitCodeFor(context, exitCode));
}

/** Byte-transparent stdio proxy with backpressure, plus daemon-loss detection on stdin. */
function wireProxy(child: ChildProcess, context: SupervisorContext): void {
  const sink = child.stdin;
  sink?.on("error", () => undefined);
  process.stdin.on("data", (chunk: Buffer) => {
    if (!sink || sink.destroyed || !sink.writable) return;
    if (!sink.write(chunk)) {
      process.stdin.pause();
      sink.once("drain", () => process.stdin.resume());
    }
  });
  // EOF on our stdin is the daemon closing the session or dying.
  process.stdin.on("end", () => {
    sink?.end();
    void shutdown(context);
  });
  process.stdin.on("error", () => void shutdown(context));

  const source = child.stdout;
  source?.on("data", (chunk: Buffer) => {
    if (!process.stdout.write(chunk)) {
      source.pause();
      process.stdout.once("drain", () => source.resume());
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
}

function waitForHarness(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (signal) resolve(SIGNAL_EXIT_CODES[signal] ?? 1);
      else resolve(code ?? 0);
    });
  });
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let spec: SupervisorSpec;
  try {
    spec = readSpec();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
    return;
  }
  await run(spec);
}

if (isEntryPoint()) void main();
