import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/ipc";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const daemon = join(root, "dist", "daemon", "main.js");
const dirs: string[] = [];
beforeAll(() => {
  if (!existsSync(cli) || !existsSync(daemon)) execFileSync("npm", ["run", "build"], { cwd: root });
});
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function directory() {
  const dir = mkdtempSync("/tmp/hab-cli-start-");
  dirs.push(dir);
  return dir;
}

describe("real startup path errors", () => {
  it.each([cli, daemon])("prints a missing config path on stderr and exits nonzero: %s", entry => {
    const path = join(directory(), "missing.yaml");
    const result = spawnSync(process.execPath, [entry, "--config", path], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`configured YAML file does not exist: ${path}`);
  });
  it.each([cli, daemon])("rejects --config with no value instead of using defaults: %s", entry => {
    const result = spawnSync(process.execPath, [entry, "--config"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--config requires a non-empty YAML file path");
  });
  it("propagates the real daemon's config failure through auto-start", async () => {
    const dir = directory();
    const configPath = join(dir, "missing.yaml");
    await expect(new DaemonClient({
      socketPath: join(dir, "bridge.sock"), lockPath: join(dir, "bridge.lock"),
      configPath, daemonEntry: daemon, startTimeoutMs: 3000,
    }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining(`configured YAML file does not exist: ${configPath}`),
    });
  });
  it("propagates a bad socket directory with a specific filesystem error", async () => {
    const dir = directory();
    const parentFile = join(dir, "not-a-directory");
    writeFileSync(parentFile, "");
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, `server:\n  socket_path: ${parentFile}/bridge.sock\n  lock_path: ${dir}/bridge.lock\npaths:\n  state_dir: ${dir}/state\n`);
    await expect(new DaemonClient({
      socketPath: join(dir, "bridge.sock"), lockPath: join(dir, "bridge.lock"),
      configPath, daemonEntry: daemon, startTimeoutMs: 3000,
    }).ensureDaemon()).rejects.toMatchObject({
      code: "daemon_start_failed", message: expect.stringContaining(parentFile),
    });
  });
});
