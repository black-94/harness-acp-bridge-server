import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/ipc";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync("/tmp/hab-start-");
  dirs.push(dir);
  return dir;
}
function client(dir: string, extra: Partial<ConstructorParameters<typeof DaemonClient>[0]> = {}) {
  return new DaemonClient({
    socketPath: join(dir, "bridge.sock"), lockPath: join(dir, "bridge.lock"),
    startTimeoutMs: 3000, ...extra,
  });
}
function fixture(dir: string, script: string) {
  const path = join(dir, "daemon.mjs");
  writeFileSync(path, script);
  return path;
}
function trackedSpawn(...args: Parameters<typeof spawn>) {
  const child = spawn(...args);
  children.push(child);
  return child;
}

describe("daemon startup diagnostics", () => {
  it("reports a missing daemon entry promptly with paths and Node's error", async () => {
    const dir = directory();
    const entry = join(dir, "missing-daemon.js");
    const start = Date.now();
    const error = await client(dir, { daemonEntry: entry }).ensureDaemon().catch(error => error);
    expect(error.code).toBe("daemon_start_failed");
    expect(error.message).toContain(entry);
    expect(error.message).toContain("Cannot find module");
    expect(error.message).toContain(join(dir, "bridge.sock"));
    expect(error.message).toContain(join(dir, "bridge.lock"));
    expect(error.message).toContain("exited with code 1");
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it("reports config-path failures from stderr without waiting for the deadline", async () => {
    const dir = directory();
    const configPath = join(dir, "missing-config.yaml");
    const entry = fixture(dir, "process.stderr.write('configured YAML file does not exist: ' + process.argv.at(-1)); process.exit(1);");
    await expect(client(dir, { daemonEntry: entry, configPath }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining(`configured YAML file does not exist: ${configPath}`),
    });
  });

  it("includes filesystem errors when the socket parent cannot be created", async () => {
    const dir = directory();
    const file = fixture(dir, "");
    await expect(client(dir, { socketPath: join(file, "bridge.sock") }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining(file),
    });
  });

  it("handles asynchronous spawn errors instead of emitting an unhandled error", async () => {
    const dir = directory();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), stderr: null });
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn node ENOENT")));
      return child;
    }) as unknown as typeof spawn;
    await expect(client(dir, { spawnImpl }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining("spawn node ENOENT"),
    });
  });

  it("handles synchronous spawn errors", async () => {
    const dir = directory();
    const spawnImpl = vi.fn(() => { throw new Error("spawn EACCES"); }) as unknown as typeof spawn;
    await expect(client(dir, { spawnImpl }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining("spawn EACCES"),
    });
  });

  it.each([
    ["process.exit(0);", "exited with code 0"],
    ["process.kill(process.pid, 'SIGTERM');", "terminated by signal SIGTERM"],
  ])("reports an early process exit: %s", async (script, reason) => {
    const dir = directory();
    await expect(client(dir, { daemonEntry: fixture(dir, script) }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining(reason),
    });
  });

  it("keeps timeouts typed but adds launch context and stderr", async () => {
    const dir = directory();
    const entry = fixture(dir, "process.stderr.write('still starting'); setInterval(() => {}, 1000);");
    await expect(client(dir, { daemonEntry: entry, startTimeoutMs: 500, spawnImpl: trackedSpawn }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_timeout", message: expect.stringContaining("still starting"),
    });
  });

  it("bounds diagnostics and redacts credentials even when stderr splits a key", async () => {
    const dir = directory();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), stderr });
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        stderr.write("api_");
        stderr.write("key=super-secret-value\n" + "x".repeat(20000));
        stderr.end();
        child.emit("close", 1, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const error = await client(dir, { spawnImpl }).ensureDaemon().catch(error => error);
    expect(error.message).toContain("api_key=[redacted]");
    expect(error.message).not.toContain("super-secret-value");
    expect(error.message.length).toBeLessThan(9000);
  });

  it("accepts an already running daemon without spawning", async () => {
    const dir = directory();
    const spawnImpl = vi.fn() as unknown as typeof spawn;
    const bridge = client(dir, { spawnImpl });
    vi.spyOn(bridge, "ping").mockResolvedValue({ status: "ok" });
    await bridge.ensureDaemon();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("waits for the singleton winner to bind after this child reports a live lock", async () => {
    const dir = directory();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), stderr });
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        stderr.write("a harness-acp-bridge daemon is already running (pid 123)");
        stderr.end();
        child.emit("close", 1, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const bridge = client(dir, { spawnImpl });
    vi.spyOn(bridge, "ping").mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ status: "ok" });
    await expect(bridge.ensureDaemon()).resolves.toBeUndefined();
  });

  it("accepts another launcher's live daemon after this child exits", async () => {
    const dir = directory();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), stderr: null });
    const spawnImpl = vi.fn(() => { queueMicrotask(() => child.emit("close", 1, null)); return child; }) as unknown as typeof spawn;
    const bridge = client(dir, { spawnImpl });
    vi.spyOn(bridge, "ping").mockResolvedValueOnce(null).mockResolvedValue({ status: "ok" });
    await expect(bridge.ensureDaemon()).resolves.toBeUndefined();
  });
});
