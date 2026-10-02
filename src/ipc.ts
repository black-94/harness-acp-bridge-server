/**
 * IPC between the MCP stdio client and the daemon.
 *
 * The transport is newline-delimited JSON over a Unix domain socket, one request per
 * connection. The socket is created inside a 0700 directory with mode 0600, so only the
 * owning user can reach the daemon; there is no TCP listener and no way to pass
 * credentials, commands, or paths through this surface.
 *
 * `DaemonClient` also owns auto-start: if the socket is missing or refused it spawns
 * `dist/daemon/main.js` detached and waits for `ping` to succeed.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const IPC_PROTOCOL_VERSION = 1;
/** Bound on a single IPC request or response line. */
export const MAX_IPC_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 2000;
const START_POLL_INTERVAL_MS = 50;

export class IpcError extends Error {
  override name = "IpcError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DaemonClientOptions {
  socketPath: string;
  lockPath: string;
  configPath?: string | null;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  autoStart?: boolean;
  /** Daemon entrypoint; defaults to the compiled `dist/daemon/main.js` next to ipc.js. */
  daemonEntry?: string;
  spawnImpl?: typeof spawn;
}

export function defaultDaemonEntry(): string {
  return fileURLToPath(new URL("./daemon/main.js", import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function connectionCode(error: NodeJS.ErrnoException): string {
  return typeof error.code === "string" ? error.code : "ipc_connection_failed";
}

/** Errors that mean "no daemon is listening", which auto-start may recover from. */
function isAbsentDaemon(error: unknown): boolean {
  if (!(error instanceof IpcError)) return false;
  return (
    error.code === "ENOENT" ||
    error.code === "ECONNREFUSED" ||
    error.code === "ipc_closed" ||
    error.code === "ipc_connection_failed"
  );
}

export interface DaemonCallOptions {
  timeoutMs?: number;
  autoStart?: boolean;
}

export class DaemonClient {
  private readonly options: DaemonClientOptions;
  private readonly startTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private nextId = 1;

  constructor(options: DaemonClientOptions) {
    this.options = options;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  /** Call a daemon method, auto-starting the daemon when it is not listening. */
  async call(
    method: string,
    params: Record<string, unknown> = {},
    options: DaemonCallOptions = {},
  ): Promise<Record<string, unknown>> {
    const payload = `${JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    })}\n`;
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    try {
      return await this.send(payload, timeoutMs);
    } catch (error) {
      const mayAutoStart = options.autoStart ?? this.options.autoStart ?? true;
      if (!mayAutoStart || !isAbsentDaemon(error)) throw error;
      await this.ensureDaemon();
      return await this.send(payload, timeoutMs);
    }
  }

  /** Ping the daemon, returning `null` when nothing is listening. Never auto-starts. */
  async ping(): Promise<Record<string, unknown> | null> {
    try {
      return await this.call("ping", {}, { autoStart: false, timeoutMs: PING_TIMEOUT_MS });
    } catch {
      return null;
    }
  }

  /** Spawn the daemon if needed and wait until it answers `ping`. */
  async ensureDaemon(): Promise<void> {
    if (await this.ping()) return;
    mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    const entry = this.options.daemonEntry ?? defaultDaemonEntry();
    const args = [entry];
    if (this.options.configPath) args.push("--config", this.options.configPath);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref?.();

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      await delay(START_POLL_INTERVAL_MS);
      if (await this.ping()) return;
    }
    throw new IpcError(
      "daemon_start_timeout",
      `harness-acp-bridge daemon did not become ready within ${this.startTimeoutMs}ms`,
    );
  }

  private send(payload: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const socket = connect({ path: this.options.socketPath });
      let buffer = "";
      let settled = false;
      const finish = (error: IpcError | null, value?: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolvePromise(value as Record<string, unknown>);
      };
      const timer = setTimeout(
        () => finish(new IpcError("ipc_timeout", `daemon call timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof timer.unref === "function") timer.unref();

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > MAX_IPC_LINE_BYTES) {
          finish(new IpcError("ipc_response_too_large", "daemon response exceeded the size limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffer.slice(0, newline));
        } catch {
          finish(new IpcError("ipc_invalid_response", "daemon returned malformed JSON"));
          return;
        }
        if (!isRecord(parsed)) {
          finish(new IpcError("ipc_invalid_response", "daemon returned a non-object response"));
          return;
        }
        if (isRecord(parsed.error)) {
          const info = parsed.error;
          const data = isRecord(info.data) ? info.data : {};
          const code =
            typeof data.code === "string" ? data.code : String(info.code ?? "ipc_error");
          finish(new IpcError(code, String(info.message ?? "daemon request failed")));
          return;
        }
        if (!isRecord(parsed.result)) {
          finish(new IpcError("ipc_invalid_response", "daemon response has no result object"));
          return;
        }
        finish(null, parsed.result);
      });
      socket.on("error", (error: NodeJS.ErrnoException) =>
        finish(new IpcError(connectionCode(error), `daemon connection failed: ${error.message}`)),
      );
      socket.on("close", () =>
        finish(new IpcError("ipc_closed", "daemon closed the connection before responding")),
      );
    });
  }
}
