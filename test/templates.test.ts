import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/logic/config";
import { DEFAULT_NO_PROXY, TemplateRegistry, assertHarnessIdentity, templateDefaults, validateTemplate } from "../src/logic/templates";
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
    for (const [file, runtime] of [["local", "direct"], ["docker", "docker"], ["docker-host", "docker"], ["docker-proxy", "docker"]]) {
      expect(validateTemplate(JSON.parse(readFileSync(new URL(`../templates/${file}.json`, import.meta.url), "utf8"))))
        .toMatchObject({ runtime, target: "local", remote_host: null, permission_mode: "auto" });
    }
    expect(validateTemplate({ ...base, command: " " })).toMatchObject({ command: null, args: [], env: {}, cwd: null,
      runtime: "direct", target: "local", remote_host: null, permission_mode: "auto" });
    expect(validateTemplate({ ...base, target: "remote", remote_host: " user@example.test " }).remote_host).toBe("user@example.test");
  });
  it("stores model/thinking defaults and natural-language instructions verbatim across restarts", () => {
    const dir = directory(); const registry = new TemplateRegistry(dir);
    const guidance = {
      model: "unlisted-model", thinking: "custom-effort",
      before_start: "启动前检查依赖。\n确认目录可用。",
      after_start: "启动后检查会话状态。", special_instructions: "保留中文 😀；不要猜测凭据。",
    };
    expect(registry.register({ ...base, ...guidance })).toMatchObject(guidance);
    const restored = new TemplateRegistry(dir);
    expect(restored.get(base.name)).toMatchObject(guidance);
    expect(restored.search(null, null, base.name)[0]).toMatchObject(guidance);
    expect(templateDefaults(restored.get(base.name))).toMatchObject({ model_id: guidance.model, thinking_level: guidance.thinking });
    for (const field of ["model", "thinking", "before_start", "after_start", "special_instructions"]) {
      expect(templateDefaults(restored.get(base.name))).not.toHaveProperty(field);
    }
  });
  it("applies nullable metadata defaults when optional fields are absent", () => {
    const dir = directory(); writeFileSync(join(dir, "templates.json"), JSON.stringify([base]));
    expect(new TemplateRegistry(dir).get(base.name)).toMatchObject({
      model: null, thinking: null, before_start: null, after_start: null, special_instructions: null,
    });
    expect(validateTemplate({ ...base, before_start: "", after_start: null })).toMatchObject({ before_start: "", after_start: null });
  });
  it.each(["model", "thinking", "before_start", "after_start", "special_instructions"])("validates %s without executing it", field => {
    for (const value of [123, [], {}, "text\0bad"]) {
      expect(() => validateTemplate({ ...base, [field]: value })).toThrow(expect.objectContaining({ code: "invalid_template" }));
    }
    if (field === "model" || field === "thinking") {
      for (const value of ["", " \n "]) expect(() => validateTemplate({ ...base, [field]: value })).toThrow();
    }
  });
  it("generates all proxy variables from one port and replaces stale aliases while keeping other env", () => {
    const env = { KEEP: "keep", http_proxy: "old-http", https_proxy: "old-https", no_proxy: "old-bypass",
      HTTP_PROXY: "old-upper-http", HTTPS_PROXY: "old-upper-https", NO_PROXY: "old-upper-bypass", ALL_PROXY: "old-all", all_proxy: "old-all-lower" };
    const proxy = validateTemplate({ ...docker, network_mode: "proxy", proxy_port: 12345, env });
    expect(proxy.env).toEqual({ KEEP: "keep", http_proxy: "http://host.docker.internal:12345",
      https_proxy: "http://host.docker.internal:12345", no_proxy: DEFAULT_NO_PROXY });
    expect(env.http_proxy).toBe("old-http"); // No mutation of caller input.
    expect(templateDefaults(proxy)).toMatchObject({ host_network: false, env: proxy.env });
    expect(templateDefaults(proxy)).not.toHaveProperty("network_mode");
    expect(templateDefaults(proxy)).not.toHaveProperty("proxy_port");
    const dir = directory(); new TemplateRegistry(dir).register({ ...proxy, name: "proxy-persisted" });
    expect(new TemplateRegistry(dir).get("proxy-persisted")).toMatchObject({ network_mode: "proxy", proxy_port: 12345, env: proxy.env });
  });
  it("maps none/host network mode to explicit session host_network without legacy template fields", () => {
    const ordinary = validateTemplate(docker); const host = validateTemplate({ ...docker, network_mode: "host" });
    expect(ordinary).toMatchObject({ network_mode: "none", proxy_port: null });
    expect(host).not.toHaveProperty("host_network");
    expect(templateDefaults(ordinary).host_network).toBe(false); expect(templateDefaults(host).host_network).toBe(true);
  });
  it.each([0, -1, 65536, 1.5, "8080", false, null, undefined])("rejects invalid/missing proxy port %s", proxy_port => {
    expect(() => validateTemplate({ ...docker, network_mode: "proxy", proxy_port })).toThrow(expect.objectContaining({ code: "invalid_template" }));
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
    { ...docker, host_network: true }, { ...docker, host_network: false },
    { ...docker, network_mode: "host", ports: [{ host_port: 80, container_port: 80 }] },
    { ...docker, network_mode: "host", env: { http_proxy: "http://proxy:12345" } },
    { ...docker, network_mode: "none", env: { https_proxy: "http://proxy:12345" } },
    { ...docker, env: { HTTP_PROXY: "http://proxy:12345" } },
    { ...docker, network_mode: "none", proxy_port: 12345 }, { ...docker, network_mode: "host", proxy_port: 12345 },
    { ...docker, network_mode: "invalid" }, { ...base, network_mode: "host" },
    { ...base, network_mode: "proxy", proxy_port: 12345 },
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
  it("rejects old host_network registry records without silently migrating them", () => {
    const dir = directory(); writeFileSync(join(dir, "templates.json"), JSON.stringify([{ ...docker, host_network: false }]));
    expect(() => new TemplateRegistry(dir)).toThrow(expect.objectContaining({ code: "storage_error" }));
  });
  it("fails closed on a corrupted registry", () => {
    const dir = directory(); writeFileSync(join(dir, "templates.json"), "not JSON");
    expect(() => new TemplateRegistry(dir)).toThrow(expect.objectContaining({ code: "storage_error" }));
  });
  it.each(["codebuddy", "codex", "agy"])("accepts omitted/null ACP v1 agentInfo for %s", harness => {
    expect(() => assertHarnessIdentity(harness, { result: { protocolVersion: 1 } })).not.toThrow();
    expect(() => assertHarnessIdentity(harness, { result: { protocolVersion: 1, agentInfo: null } })).not.toThrow();
  });
  it.each([
    ["codebuddy", "CodeBuddy", "codex-acp"],
    ["codex", "Codex-ACP", "codebuddy"],
    ["agy", "Antigravity", "codex"],
  ])("validates supplied ACP harness identity for %s", (harness, validName, wrongName) => {
    expect(() => assertHarnessIdentity(harness, { result: { agentInfo: { name: validName } } })).not.toThrow();
    for (const agentInfo of [{ name: wrongName }, { name: "fake-codebuddy" }, {}, { name: "" }, { name: " " }, { name: 123 }, "invalid", false, []]) {
      expect(() => assertHarnessIdentity(harness, { result: { agentInfo } })).toThrow(expect.objectContaining({ code: "invalid_harness_command" }));
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
    server: { port: 0 }, default_harness: "codebuddy",
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

describe("template HTTP API and decoupled create_session", () => {
  const launch = { command: process.execPath, args: [fixture, "--fake-agent=codebuddy"] };
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
    // create_session never references a template: naming one is an unsupported parameter.
    const rejected = await api.request("create_session", { template: "buddy", cwd: api.dir, model_id: "fake-model" });
    expect(rejected.status).toBe(400);
    expect(rejected.error.code).toBe("unknown_param");
  });
  it("returns LLM instructions without running them and rejects template-only fields on sessions", async () => {
    const api = await app(); const marker = join(api.dir, "must-not-run");
    const guidance = { model: "fake-model", thinking: "low", before_start: `touch ${marker}`,
      after_start: `touch ${marker}`, special_instructions: "由调用方 LLM 执行，不是服务端 hook。" };
    const registered = await api.request("register_template", { template: { ...base, ...guidance } });
    expect(registered.ok).toBe(true); expect(registered.data.template).toMatchObject(guidance);
    expect((await api.request("search_template", { name: base.name })).data.templates[0]).toMatchObject(guidance);
    for (const field of Object.keys(guidance)) {
      const rejected = await api.request("create_session", { ...launch, cwd: api.dir, model_id: "fake-model", [field]: guidance[field as keyof typeof guidance] });
      expect(rejected.error.code).toBe("unknown_param");
    }
    expect((await api.request("ping")).data.sessions).toBe(0); expect(existsSync(marker)).toBe(false);
    // A caller explicitly maps defaults; the server does not run either instruction at startup.
    const created = await api.request("create_session", { ...launch, cwd: api.dir, model_id: guidance.model, thinking_level: guidance.thinking });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.data.options).toMatchObject({ model_id: guidance.model, thinking_level: guidance.thinking });
    expect(existsSync(marker)).toBe(false);
    await api.request("close_session", { session_id: created.data.session_id });
  });
  it.each(["local", "remote"].flatMap(target => ["none", "host", "proxy"].map(network_mode => ({ target, network_mode }))))(
    "expands $target Docker $network_mode mode and delivers generated proxy env to the harness", async ({ target, network_mode }) => {
      const api = await app(); const envFile = join(api.dir, "proxy-env.json"); const log = join(api.dir, "docker.log");
      vi.stubEnv("MOCK_DOCKER_LOG", log);
      let proxyPort = 12345;
      if (network_mode === "proxy") {
        const listener = createTcpServer(socket => socket.end());
        await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
        cleanup.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
        proxyPort = (listener.address() as { port: number }).port;
        vi.stubEnv("MOCK_DOCKER_HOST_GATEWAY", "127.0.0.1");
      }
      for (const key of ["http_proxy", "https_proxy", "no_proxy"]) vi.stubEnv(key, "");
      const registered = await api.request("register_template", { template: { ...docker, ...launch, cwd: api.dir, target,
        ...(target === "remote" ? { remote_host: "proxy-execution-host" } : {}), network_mode,
        ...(network_mode === "proxy" ? { proxy_port: proxyPort } : {}), env: { FAKE_HARNESS_PROXY_FILE: envFile, KEEP: "unchanged" } } });
      expect(registered.ok, JSON.stringify(registered)).toBe(true);
      const t = (await api.request("search_template", { name: base.name })).data.templates[0];
      const created = await api.request("create_session", { ...launch, model_id: "fake-model", cwd: t.cwd, runtime: t.runtime,
        target: t.target, ...(t.target === "remote" ? { remote_host: t.remote_host } : {}), docker_image: t.docker_image,
        host_network: t.network_mode === "host", env: t.env });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      await api.request("close_session", { session_id: created.data.session_id });
      const received = JSON.parse(readFileSync(envFile, "utf8"));
      expect(received).toEqual(network_mode === "proxy" ? {
        http_proxy: `http://host.docker.internal:${proxyPort}`, https_proxy: `http://host.docker.internal:${proxyPort}`, no_proxy: DEFAULT_NO_PROXY,
      } : { http_proxy: "", https_proxy: "", no_proxy: "" });
      const entries = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).argv as string[]);
      const run = entries.find(argv => argv[0] === "run")!;
      expect(run.includes("--network")).toBe(network_mode === "host");
      expect(run.includes("host.docker.internal:host-gateway")).toBe(network_mode === "proxy");
      expect(entries.some(argv => argv.includes("proxy-preflight"))).toBe(network_mode === "proxy");
      if (network_mode === "proxy") for (const key of ["http_proxy", "https_proxy", "no_proxy"]) {
        expect(entries.some(argv => argv[0] === "exec" && argv.includes(`${key}=${t.env[key]}`))).toBe(true);
      }
    });
  it("starts a harness from direct launch parameters, reports no template identity, and honors a cwd override", async () => {
    const api = await app();
    const created = await api.request("create_session", { ...launch, cwd: api.dir, model_id: "fake-model" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.data.cwd).toBe(api.dir);
    // The snapshot carries no selected-template identity.
    expect(created.data.template).toBeUndefined();
    expect((await api.request("send_message", { session_id: created.data.session_id, text: "direct" })).ok).toBe(true);
    await api.request("close_session", { session_id: created.data.session_id });
    // A distinct existing absolute directory, so the override cannot be confused with a default.
    const overrideDir = join(api.dir, "override-cwd"); mkdirSync(overrideDir, { recursive: true });
    const overridden = await api.request("create_session", { ...launch, cwd: overrideDir, model_id: "fake-model" });
    expect(overridden.ok, JSON.stringify(overridden)).toBe(true);
    expect(overridden.data.cwd).toBe(overrideDir);
    expect(overridden.data.cwd).not.toBe(api.dir);
    await api.request("close_session", { session_id: overridden.data.session_id });
  });
  it.each(["direct", "docker"])("launches a remote %s session from direct parameters and validates the host pairing", async runtime => {
    const api = await app(); const sshLog = join(api.dir, "ssh.log"); vi.stubEnv("MOCK_SSH_LOG", sshLog);
    const created = await api.request("create_session", { ...launch, model_id: "fake-model", cwd: api.dir, runtime,
      target: "remote", remote_host: "request-host", ...(runtime === "docker" ? { docker_image: "mock/image:1" } : {}) });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.data).toMatchObject({ runtime, target: "remote", remote_host: "request-host" });
    await api.request("close_session", { session_id: created.data.session_id });
    expect(readFileSync(sshLog, "utf8")).toContain("request-host");
    // A local target must not carry a remote host.
    expect((await api.request("create_session", { ...launch, model_id: "fake-model", cwd: api.dir, target: "local", remote_host: "invalid-local-host" })).error.code).toBe("invalid_param");
    // A remote target requires one.
    expect((await api.request("create_session", { ...launch, model_id: "fake-model", cwd: api.dir, target: "remote" })).error.code).toBe("invalid_param");
  });
  it("uses the built-in PATH executable when command is omitted, and rejects a missing explicit command", async () => {
    const api = await app(); const executable = join(api.dir, "codebuddy");
    writeFileSync(executable, `#!/bin/sh\nexec ${shellJoin([process.execPath, fixture])} "$@"\n`, { mode: 0o700 });
    vi.stubEnv("PATH", api.dir);
    const fromPath = await api.request("create_session", { cwd: api.dir, model_id: "fake-model" });
    expect(fromPath.ok, JSON.stringify(fromPath)).toBe(true);
    await api.request("close_session", { session_id: fromPath.data.session_id });
    expect((await api.request("create_session", { cwd: api.dir, model_id: "fake-model", command: "/missing/codebuddy" })).error.code).toBe("command_not_found");
    vi.stubEnv("PATH", "/does-not-exist");
    expect((await api.request("create_session", { cwd: api.dir, model_id: "fake-model" })).error.code).toBe("command_not_found");
  });
  it.each(["codebuddy", "codex", "agy"].flatMap(harness => ["--no-agent-info", "--null-agent-info"].map(flag => ({ harness, flag }))))(
    "creates and uses a $harness session with $flag", async ({ harness, flag }) => {
      const api = await app();
      const created = await api.request("create_session", { harness, command: process.execPath, args: [fixture, flag], cwd: api.dir, model_id: "fake-model" });
      expect(created.status, JSON.stringify(created)).toBe(200);
      expect(created.data).toMatchObject({ state: "ready", harness, harness_session_id: "fake-1" });
      expect((await api.request("send_message", { session_id: created.data.session_id, text: "without identity metadata" })).ok).toBe(true);
      expect((await api.request("close_session", { session_id: created.data.session_id })).ok).toBe(true);
      expect((await api.request("ping")).data.sessions).toBe(0);
    });
  it.each(["--no-agent-info", "--null-agent-info"])("preserves authentication-required setup with %s", async flag => {
    const api = await app();
    const created = await api.request("create_session", { command: process.execPath, args: [fixture, flag, "--auth-required"], cwd: api.dir, model_id: "fake-model" });
    expect(created.status, JSON.stringify(created)).toBe(403);
    expect(created.error.code).toBe("authentication_required");
    const session = created.error.detail.session_id;
    expect(created.error.detail.next_action).toEqual({ method: "authenticate", params: { session_id: session } });
    expect((await api.request("ping")).data.sessions).toBe(1);
    expect((await api.request("close_session", { session_id: session })).ok).toBe(true);
  });
  it.each(["--fake-agent=codex-acp", "--initialize-auth-required"])("rejects an executable with invalid identity (%s) before session/new", async flag => {
    const api = await app();
    const created = await api.request("create_session", { command: process.execPath, args: [fixture, flag], cwd: api.dir, model_id: "fake-model", session_id: "invalid-command" });
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
    const created = await api.request("create_session", { command: "/missing/in-container", cwd: "/workspace", model_id: "fake-model",
      runtime: "docker", docker_image: "mock/image:1", target, ...(target === "remote" ? { remote_host: "mock-host" } : {}) });
    expect(created.error.code, JSON.stringify(created)).toBe("command_not_found");
    const entries = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).argv);
    expect(entries.some(argv => argv[0] === "run")).toBe(true);
    expect(entries.some(argv => argv[0] === "exec" && argv.includes("harness-command-check"))).toBe(true);
    expect(entries.some(argv => argv[0] === "rm")).toBe(true);
    expect((await api.request("ping")).data.sessions).toBe(0);
  });
  it("uses the direct PATH inside Docker and merges login_dirs/mounts and env into the launch", async () => {
    const api = await app(); const executable = join(api.dir, "codebuddy");
    writeFileSync(executable, `#!/bin/sh\nexec ${shellJoin([process.execPath, fixture])} "$@"\n`, { mode: 0o700 });
    const log = join(api.dir, "docker.log"); vi.stubEnv("MOCK_DOCKER_LOG", log);
    const created = await api.request("create_session", { command: null, cwd: api.dir, model_id: "fake-model",
      runtime: "docker", docker_image: "mock/image:1",
      env: { PATH: api.dir, API_KEY: "private-sentinel" },
      login_dirs: [{ source: api.dir, target: "/credentials" }],
      mounts: [{ source: api.dir, target: "/workspace" }] });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await api.request("close_session", { session_id: created.data.session_id });
    const entries = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).argv);
    const run = entries.find(argv => argv[0] === "run")!;
    expect(run).toContain(`type=bind,src=${api.dir},dst=/credentials`);
    expect(run).toContain(`type=bind,src=${api.dir},dst=/workspace`);
    expect(entries.some(argv => argv[0] === "exec" && argv.includes(`PATH=${api.dir}`) && argv.includes("codebuddy"))).toBe(true);
    const snapshot = readFileSync(join(api.config.paths.sessionDir, created.data.session_id, "session.json"), "utf8");
    expect(snapshot).not.toContain("private-sentinel");
  });
  it("rejects a NUL-bearing cwd/mount/image as invalid_param before any launch or state write", async () => {
    const api = await app(); const log = join(api.dir, "docker.log"); vi.stubEnv("MOCK_DOCKER_LOG", log);
    // Bad cwd (direct): rejected at normalization, no process spawned.
    const badCwd = await api.request("create_session", { ...launch, cwd: `${api.dir}\0bad`, model_id: "fake-model" });
    expect(badCwd.status).toBe(400); expect(badCwd.error.code).toBe("invalid_param");
    // Bad mount source (docker new): rejected before `docker run`.
    const badMount = await api.request("create_session", { command: null, cwd: "/workspace", model_id: "fake-model",
      runtime: "docker", docker_image: "mock/image:1", mounts: [{ source: "/src\0bad", target: "/workspace" }] });
    expect(badMount.error.code).toBe("invalid_param");
    // Bad login dir / image reference: rejected.
    const badLogin = await api.request("create_session", { command: null, cwd: "/workspace", model_id: "fake-model",
      runtime: "docker", docker_image: "mock/image:1", login_dirs: [{ source: "/creds\0bad", target: "/creds" }] });
    expect(badLogin.error.code).toBe("invalid_param");
    const badImage = await api.request("create_session", { command: null, cwd: "/workspace", model_id: "fake-model",
      runtime: "docker", docker_image: "img\0bad" });
    expect(badImage.error.code).toBe("invalid_param");
    // Nothing was created or spawned.
    expect((await api.request("ping")).data.sessions).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
  it("rejects a managed flag for the resolved default harness as invalid_param without a session", async () => {
    const api = await app();
    const rejected = await api.request("create_session", { cwd: api.dir, model_id: "fake-model", args: ["--acp"] });
    expect(rejected.status).toBe(400); expect(rejected.error.code).toBe("invalid_param");
    expect((await api.request("ping")).data.sessions).toBe(0);
  });
  it("treats an empty command as the built-in PATH executable", async () => {
    const api = await app(); const executable = join(api.dir, "codebuddy");
    writeFileSync(executable, `#!/bin/sh\nexec ${shellJoin([process.execPath, fixture])} "$@"\n`, { mode: 0o700 });
    vi.stubEnv("PATH", api.dir);
    const created = await api.request("create_session", { command: "", cwd: api.dir, model_id: "fake-model" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await api.request("close_session", { session_id: created.data.session_id });
  });
  it("rejects obsolete YAML command configuration", async () => {
    const dir = directory(); const path = join(dir, "config.yaml");
    for (const settings of [{ harnesses: { codebuddy: { command: "codebuddy" } } }, { launch: { codex_command: "codex-acp" } }]) {
      writeFileSync(path, stringify(settings)); expect(() => loadConfig(path)).toThrow(/Unrecognized key/);
    }
    expect(existsSync(join(dir, "templates.json"))).toBe(false);
  });
});
