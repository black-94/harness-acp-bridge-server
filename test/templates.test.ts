import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/logic/config";
import { TemplateRegistry, assertHarnessIdentity, validateTemplate } from "../src/logic/templates";
import { resolveLocalCommand, resolveTargetCommand } from "../src/io/commands";
import { shellJoin, type LaunchSpec } from "../src/io/runtime";
import { HarnessHttpServer } from "../dist/http/server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0)) await operation(); vi.unstubAllEnvs(); });
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "hab-template-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const fixture = fileURLToPath(new URL("./fixtures/fake-acp-harness.mjs", import.meta.url));
const base = { name: "buddy", harness: "codebuddy" };
const docker = { ...base, runtime: "docker", docker_image: "test/image:1" };

describe("template validation and durable registry", () => {
  it("accepts the shipped local/Docker templates and normalizes optional fields", () => {
    for (const [file, runtime] of [["local", "direct"], ["docker", "docker"]]) {
      expect(validateTemplate(JSON.parse(readFileSync(new URL(`../templates/${file}.json`, import.meta.url), "utf8"))))
        .toMatchObject({ runtime, target: "local", remote_host: null, permission_mode: "auto" });
    }
    expect(validateTemplate({ ...base, command: " " })).toMatchObject({ command: null, args: [], env: {}, cwd: null,
      runtime: "direct", target: "local", remote_host: null, permission_mode: "auto" });
    expect(validateTemplate({ ...base, target: "remote", remote_host: " user@example.test " }).remote_host).toBe("user@example.test");
  });
  it.each([
    { ...base, name: "../escape" }, { ...base, harness: "unknown" }, { ...base, extra: true },
    { ...base, target: "cloud" }, { ...base, target: "remote" },
    { ...base, target: "remote", remote_host: null }, { ...base, target: "remote", remote_host: " " },
    { ...base, target: "remote", remote_host: 123 }, { ...base, remote_host: "unexpected-host" },
    { ...base, permission_mode: "root" },
    { ...base, command: "relative/path" }, { ...base, command: "cmd --arg" }, { ...base, command: "-cmd" },
    { ...base, command: "\0" }, { ...base, args: ["\0"] }, { ...base, env: { "BAD-NAME": "x" } },
    { ...base, args: ["--acp"] }, { ...base, args: ["--bg"] }, { ...base, cwd: "relative" },
    { ...base, docker_image: "img" }, { ...base, container_policy: "keep" },
    { ...docker, docker_image: null }, { ...docker, docker_image: "-image" },
    { ...docker, mounts: [{ source: "relative", target: "/x" }] },
    { ...docker, login_dirs: [{ source: "/a", target: "/x" }], mounts: [{ source: "/b", target: "/x" }] },
    { ...docker, ports: [{ host_port: 65536, container_port: 80 }] },
    { ...docker, host_network: true, ports: [{ host_port: 80, container_port: 80 }] },
  ])("rejects invalid registration %#", raw => {
    expect(() => validateTemplate(raw)).toThrow(expect.objectContaining({ code: "invalid_template" }));
  });
  it("persists registrations/deletions, rejects duplicates, and returns defensive copies", () => {
    const dir = directory(); const registry = new TemplateRegistry(dir);
    registry.register({ ...base, description: "Docker work" });
    registry.register({ name: "codex", harness: "codex", target: "remote", remote_host: "user@remote-host" });
    expect(() => registry.register(base)).toThrow(expect.objectContaining({ code: "template_exists" }));
    const restored = new TemplateRegistry(dir);
    expect(restored.search("work").map(item => item.name)).toEqual(["buddy"]);
    expect(restored.search(null, "codex").map(item => item.name)).toEqual(["codex"]);
    expect(restored.get("codex")).toMatchObject({ target: "remote", remote_host: "user@remote-host" });
    expect(restored.search(null, null, "missing")).toEqual([]);
    const found = restored.get("buddy"); found.args.push("changed");
    expect(restored.get("buddy").args).toEqual([]);
    expect(statSync(join(dir, "templates.json")).mode & 0o777).toBe(0o600);
    restored.delete("buddy");
    expect(() => new TemplateRegistry(dir).get("buddy")).toThrow(expect.objectContaining({ code: "template_not_found" }));
  });
  it("fails closed on a corrupted registry", () => {
    const dir = directory(); writeFileSync(join(dir, "templates.json"), "not JSON");
    expect(() => new TemplateRegistry(dir)).toThrow(expect.objectContaining({ code: "storage_error" }));
  });
  it("rejects missing or mismatched ACP harness identities", () => {
    expect(() => assertHarnessIdentity("codebuddy", { result: { agentInfo: { name: "CodeBuddy" } } })).not.toThrow();
    for (const name of ["codex-acp", "fake-codebuddy", undefined]) {
      expect(() => assertHarnessIdentity("codebuddy", { result: { agentInfo: { name } } })).toThrow(expect.objectContaining({ code: "invalid_harness_command" }));
    }
  });
});

describe("command resolution", () => {
  it("searches PATH and rejects non-executable files/directories; explicit paths never fall back", () => {
    const dir = directory(); const executable = join(dir, "codebuddy");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    expect(() => resolveLocalCommand("codebuddy", { PATH: dir })).toThrow(expect.objectContaining({ code: "command_not_found" }));
    chmodSync(executable, 0o700);
    expect(resolveLocalCommand("codebuddy", { PATH: dir })).toBe(executable);
    expect(() => resolveLocalCommand(join(dir, "missing"), { PATH: dir })).toThrow(expect.objectContaining({ code: "command_not_found" }));
    expect(() => resolveLocalCommand(dir)).toThrow(expect.objectContaining({ code: "command_not_found" }));
  });
  it("uses the remote execution environment to resolve a command", async () => {
    const dir = directory(); const executable = join(dir, "codebuddy");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const ssh = fileURLToPath(new URL("./fixtures/mock-ssh.mjs", import.meta.url));
    const spec = { launchMode: "ssh", sshHost: "mock-host", sshCommand: ssh, dockerContainerName: null,
      cwd: dir, argv: ["codebuddy"], harnessEnv: { PATH: dir }, startupTimeoutSeconds: 2 } as LaunchSpec;
    expect(await resolveTargetCommand(spec)).toBe(executable);
    spec.argv[0] = "/missing/codebuddy";
    await expect(resolveTargetCommand(spec)).rejects.toMatchObject({ code: "command_not_found" });
  });
});

async function app() {
  const dir = directory(); const path = join(dir, "config.yaml");
  writeFileSync(path, stringify({ schema_version: 2, paths: { state_dir: join(dir, "state") },
    server: { port: 0 }, default_harness: "codebuddy", harnesses: { codebuddy: { models: [{ id: "fake-model" }] } },
    launch: { docker_command: fileURLToPath(new URL("./fixtures/mock-docker.mjs", import.meta.url)),
      ssh_command: fileURLToPath(new URL("./fixtures/mock-ssh.mjs", import.meta.url)) },
    timeouts: { startup_timeout_seconds: 5, terminate_grace_seconds: 0.05, remote_cleanup_timeout_seconds: 1 } }));
  const config = loadConfig(path); const server = new HarnessHttpServer(config);
  const address = await server.start();
  // Stop before removing its state directory.
  cleanup.unshift(() => server.stop());
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json() as any) };
  };
  return { dir, config, server, request };
}

describe("template HTTP API and create_session identity checks", () => {
  it("registers, searches, deletes and restores templates without launching a harness", async () => {
    const api = await app();
    expect((await api.request("register_template", { template: { ...base, typo: true } })).status).toBe(400);
    expect((await api.request("register_template", { template: base })).status).toBe(200);
    expect((await api.request("register_template", { template: base })).status).toBe(409);
    expect((await api.request("search_template", { query: "buddy" })).data.templates[0].name).toBe("buddy");
    expect((await api.request("ping")).data.sessions).toBe(0);
    expect(new TemplateRegistry(api.config.paths.stateDir).get("buddy").harness).toBe("codebuddy");
    expect((await api.request("delete_template", { name: "buddy" })).data.deleted).toBe(true);
    expect((await api.request("delete_template", { name: "buddy" })).status).toBe(404);
    expect((await api.request("create_session", { template: "buddy", cwd: api.dir, model_id: "fake-model" })).status).toBe(404);
  });
  it("prefers a template command and cwd, and refuses command overrides or harness mismatches", async () => {
    const api = await app();
    await api.request("register_template", { template: { ...base, command: process.execPath, args: [fixture], cwd: api.dir } });
    const result = await api.request("create_session", { template: "buddy", model_id: "fake-model" });
    expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.data.template).toBe("buddy");
    expect((await api.request("create_session", { template: "buddy", model_id: "fake-model", command: "evil" })).error.code).toBe("launch_internal");
    expect((await api.request("create_session", { template: "buddy", model_id: "fake-model", harness: "codex" })).error.code).toBe("invalid_param");
    await api.request("delete_template", { name: "buddy" });
    // Deletion cannot alter a launch snapshot already accepted by a session.
    expect((await api.request("send_message", { session_id: result.data.session_id, text: "still-live" })).ok).toBe(true);
  });
  it.each(["direct", "docker"])("inherits a remote %s template's target/host and allows overrides", async runtime => {
    const api = await app(); const sshLog = join(api.dir, "ssh.log"); vi.stubEnv("MOCK_SSH_LOG", sshLog);
    const registered = await api.request("register_template", { template: { ...base, runtime,
      target: "remote", remote_host: "template-host", command: process.execPath, args: [fixture], cwd: api.dir,
      ...(runtime === "docker" ? { docker_image: "mock/image:1" } : {}) } });
    expect(registered.ok, JSON.stringify(registered)).toBe(true);
    for (const overrides of [{}, { remote_host: "override-host" }, { target: "local" }]) {
      const created = await api.request("create_session", { template: "buddy", model_id: "fake-model", ...overrides });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.data).toMatchObject({ runtime,
        target: overrides.target ?? "remote", remote_host: overrides.target === "local" ? null : overrides.remote_host ?? "template-host" });
      await api.request("close_session", { session_id: created.data.session_id });
    }
    expect(readFileSync(sshLog, "utf8")).toContain("template-host");
    expect(readFileSync(sshLog, "utf8")).toContain("override-host");
    expect((await api.request("create_session", { template: "buddy", model_id: "fake-model", target: "local", remote_host: "invalid-local-host" })).error.code).toBe("invalid_param");
  });
  it("requires a host when overriding a local template to remote and inherits permission mode", async () => {
    const api = await app();
    await api.request("register_template", { template: { ...base, command: process.execPath, args: [fixture], cwd: api.dir, permission_mode: "read" } });
    expect((await api.request("create_session", { template: "buddy", model_id: "fake-model", target: "remote" })).error.code).toBe("invalid_param");
    for (const permission of [undefined, "edit"]) {
      const created = await api.request("create_session", { template: "buddy", model_id: "fake-model", target: "remote", remote_host: "request-host",
        ...(permission ? { permission_mode: permission } : {}) });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.data.options.permission_mode).toBe(permission ?? "read");
      await api.request("close_session", { session_id: created.data.session_id });
    }
  });
  it("falls back to PATH for an empty template command and for no template", async () => {
    const api = await app(); const executable = join(api.dir, "codebuddy");
    writeFileSync(executable, `#!/bin/sh\nexec ${shellJoin([process.execPath, fixture])} "$@"\n`, { mode: 0o700 });
    vi.stubEnv("PATH", api.dir);
    await api.request("register_template", { template: { ...base, command: "" } });
    for (const template of ["buddy", undefined]) {
      const result = await api.request("create_session", { ...(template ? { template } : {}), cwd: api.dir, model_id: "fake-model" });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      await api.request("close_session", { session_id: result.data.session_id });
    }
    await api.request("register_template", { template: { ...base, name: "bad-path", command: "/missing/codebuddy" } });
    expect((await api.request("create_session", { template: "bad-path", cwd: api.dir, model_id: "fake-model" })).error.code).toBe("command_not_found");
    vi.stubEnv("PATH", "/does-not-exist");
    expect((await api.request("create_session", { cwd: api.dir, model_id: "fake-model" })).error.code).toBe("command_not_found");
  });
  it.each(["--fake-agent=codex-acp", "--no-agent-info", "--initialize-auth-required"])("rejects an executable with invalid identity (%s) before session/new", async flag => {
    const api = await app();
    await api.request("register_template", { template: { ...base, command: process.execPath, args: [fixture, flag] } });
    const created = await api.request("create_session", { template: "buddy", cwd: api.dir, model_id: "fake-model", session_id: "invalid-command" });
    expect(created.error.code).toBe("invalid_harness_command"); expect(created.status).toBe(400);
    expect((await api.request("ping")).data.sessions).toBe(0);
    const raw = readFileSync(join(api.config.paths.sessionDir, "invalid-command", "raw.jsonl"), "utf8");
    const outgoing = raw.trim().split("\n").map(line => JSON.parse(line)).filter(item => item.stream === "stdin")
      .map(item => Buffer.from(item.raw, "base64").toString("utf8")).join("");
    expect(outgoing).toContain("initialize"); expect(outgoing).not.toContain("session/new");
    expect(outgoing).not.toContain("getUserInfo"); expect(outgoing).not.toContain("authentication/status");
  });
  it.each(["local", "remote"])("checks Docker commands in the %s target and cleans up on failure", async target => {
    const api = await app(); const log = join(api.dir, "docker.log"); vi.stubEnv("MOCK_DOCKER_LOG", log);
    await api.request("register_template", { template: { ...docker, command: "/missing/in-container" } });
    const created = await api.request("create_session", { template: "buddy", cwd: api.dir, model_id: "fake-model", target,
      ...(target === "remote" ? { remote_host: "mock-host" } : {}) });
    expect(created.error.code, JSON.stringify(created)).toBe("command_not_found");
    const entries = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).argv);
    expect(entries.some(argv => argv[0] === "run")).toBe(true);
    expect(entries.some(argv => argv[0] === "exec" && argv.includes("harness-command-check"))).toBe(true);
    expect(entries.some(argv => argv[0] === "rm")).toBe(true);
    expect((await api.request("ping")).data.sessions).toBe(0);
  });
  it("uses template PATH inside Docker and carries login mounts/environment into the launch", async () => {
    const api = await app(); const executable = join(api.dir, "codebuddy");
    writeFileSync(executable, `#!/bin/sh\nexec ${shellJoin([process.execPath, fixture])} "$@"\n`, { mode: 0o700 });
    const log = join(api.dir, "docker.log"); vi.stubEnv("MOCK_DOCKER_LOG", log);
    await api.request("register_template", { template: { ...docker, command: null, cwd: api.dir,
      env: { PATH: api.dir, API_KEY: "private-template-sentinel" },
      login_dirs: [{ source: api.dir, target: "/credentials" }] } });
    const created = await api.request("create_session", { template: "buddy", model_id: "fake-model" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await api.request("close_session", { session_id: created.data.session_id });
    const entries = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).argv);
    expect(entries.find(argv => argv[0] === "run")).toContain(`type=bind,src=${api.dir},dst=/credentials`);
    expect(entries.some(argv => argv[0] === "exec" && argv.includes(`PATH=${api.dir}`) && argv.includes(executable))).toBe(true);
    const snapshot = readFileSync(join(api.config.paths.sessionDir, created.data.session_id, "session.json"), "utf8");
    expect(snapshot).not.toContain("private-template-sentinel");
  });
  it("rejects obsolete YAML command configuration", async () => {
    const dir = directory(); const path = join(dir, "config.yaml");
    for (const settings of [{ harnesses: { codebuddy: { command: "codebuddy" } } }, { launch: { codex_command: "codex-acp" } }]) {
      writeFileSync(path, stringify(settings)); expect(() => loadConfig(path)).toThrow(/Unrecognized key/);
    }
    expect(existsSync(join(dir, "templates.json"))).toBe(false);
  });
});
