/**
 * Unit coverage for the launch plumbing: adapter argv/permission-mode routing, the Docker and
 * remote command builders, and `create_session` parameter validation. These are pure
 * functions, so they pin down the exact command lines without a running daemon.
 */
import { describe, expect, it } from "vitest";

import {
  AdapterError,
  AuthStatusUnsupported,
  CodeBuddyAdapter,
  getAdapter,
  normalizeAuthStatus,
  authMethods,
  supportedPermissionModes,
  type AdapterClient,
  type AdapterConfig,
} from "../src/adapters";
import { isIpAddress, normalizeCreateParams, ParamError } from "../src/create-params";
import {
  buildTransportTarget,
  containerAction,
  containerCleanupArgs,
  containerControlArgv,
  dockerExecArgv,
  dockerRunArgs,
  isDockerId,
  newRemotePidFile,
  remoteCleanupCommand,
  remoteCommand,
  shellJoin,
  shellQuote,
  type LaunchSpec,
} from "../src/runtime";

function adapterConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    harness: "codebuddy",
    cwd: "/work",
    modelId: "m1",
    command: "codebuddy",
    args: [],
    env: {},
    launchMode: "local",
    runtime: "direct",
    permissionMode: "auto",
    acpModeId: null,
    sshHost: null,
    dockerImage: null,
    reuseContainer: false,
    ...overrides,
  };
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    launchMode: "local",
    sshHost: null,
    sshCommand: "ssh",
    dockerCommand: "docker",
    cwd: "/work",
    argv: ["codebuddy", "--acp"],
    harnessEnv: {},
    dockerImage: null,
    dockerContainerName: null,
    dockerId: null,
    dockerMounts: [],
    dockerPorts: [],
    dockerHostNetwork: false,
    containerPolicy: "remove",
    reuseContainer: false,
    remotePidFile: "harness-acp-abc.pid",
    startupTimeoutSeconds: 5,
    terminateGraceSeconds: 2,
    remoteCleanupTimeoutSeconds: 3,
    ...overrides,
  };
}

function stubClient(
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
  initialize: Record<string, unknown> = {},
): AdapterClient {
  return {
    sessionId: () => "s1",
    initializeResponse: () => initialize,
    request: async (method, params) => {
      const handler = handlers[method];
      if (!handler) {
        const error = new Error(`unknown method ${method}`) as Error & { code: number };
        error.code = -32601;
        throw error;
      }
      return handler(params) as Record<string, unknown>;
    },
  };
}

// --- adapters ----------------------------------------------------------------

describe("adapters", () => {
  it("rejects unknown harnesses", () => {
    expect(() => getAdapter("nope")).toThrow(AdapterError);
  });

  it("builds CodeBuddy argv with the permission mode mapped to its flag", () => {
    const adapter = getAdapter("codebuddy");
    const modes: Array<[AdapterConfig["permissionMode"], string]> = [
      ["read", "plan"],
      ["edit", "acceptEdits"],
      ["auto", "auto"],
      ["yolo", "bypassPermissions"],
    ];
    for (const [mode, flag] of modes) {
      const argv = adapter.buildArgv(adapterConfig({ permissionMode: mode, args: ["--extra"] }));
      expect(argv).toEqual([
        "codebuddy",
        "--extra",
        "--model",
        "m1",
        "--permission-mode",
        flag,
        "--acp",
        "--acp-transport",
        "stdio",
      ]);
    }
  });

  it("refuses CodeBuddy arguments the adapter manages", () => {
    const adapter = getAdapter("codebuddy");
    for (const flag of ["--model=x", "--acp", "-p", "--print", "--output-format=json"]) {
      expect(() => adapter.buildArgv(adapterConfig({ args: [flag] }))).toThrow(AdapterError);
    }
  });

  it("validates launch arguments and refuses detaching arguments", () => {
    const adapter = getAdapter("codebuddy");
    expect(() => adapter.validate(adapterConfig({ cwd: " " }))).toThrow(/cwd/);
    expect(() => adapter.validate(adapterConfig({ modelId: "" }))).toThrow(/model_id/);
    expect(() => adapter.validate(adapterConfig({ command: " " }))).toThrow(/command/);
    expect(() => adapter.validate(adapterConfig({ launchMode: "ssh", sshHost: null }))).toThrow(/ssh_host/);
    expect(() => adapter.validate(adapterConfig({ env: { "BAD-NAME": "x" } }))).toThrow(/environment/);
    for (const value of ["--bg", "--tmux", "--serve", "setsid", "--background=1"]) {
      expect(() => adapter.validate(adapterConfig({ args: [value] }))).toThrow(/detach/);
    }
    // Docker without an image (and without a reused container) is invalid.
    expect(() =>
      adapter.validate(adapterConfig({ runtime: "docker", dockerImage: null, reuseContainer: false })),
    ).toThrow(/Docker image/);
    expect(() =>
      adapter.validate(adapterConfig({ runtime: "docker", dockerImage: null, reuseContainer: true })),
    ).not.toThrow();
  });

  it("requires an agy mode id for non-auto permission modes", () => {
    const adapter = getAdapter("agy");
    expect(() => adapter.validate(adapterConfig({ harness: "agy", permissionMode: "edit", acpModeId: null }))).toThrow(
      /agy_edit_mode_id/,
    );
    expect(() =>
      adapter.validate(adapterConfig({ harness: "agy", permissionMode: "auto", acpModeId: null })),
    ).not.toThrow();
    expect(() =>
      adapter.validate(adapterConfig({ harness: "agy", permissionMode: "edit", acpModeId: "edit-mode" })),
    ).not.toThrow();
  });

  it("routes the codex permission mode through session/set_config_option", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = stubClient({
      "session/set_config_option": (params) => {
        calls.push({ method: "session/set_config_option", params });
        return {};
      },
    });
    const adapter = getAdapter("codex");
    const expected: Record<string, string> = {
      read: "read-only",
      edit: "agent",
      auto: "agent",
      yolo: "agent-full-access",
    };
    for (const [mode, value] of Object.entries(expected)) {
      await adapter.setMode(
        client,
        adapterConfig({ harness: "codex", permissionMode: mode as AdapterConfig["permissionMode"] }),
        "s1",
      );
      expect(calls.at(-1)?.params).toEqual({ sessionId: "s1", configId: "mode", value });
    }
  });

  it("reports the permission modes each harness can actually route", () => {
    const full = ["read", "edit", "auto", "yolo"];
    expect(supportedPermissionModes("codebuddy", {})).toEqual(full);
    expect(supportedPermissionModes("codex", {})).toEqual(full);
    // Agy read/edit need an explicit mode id; auto may use the harness default and yolo
    // defaults to "yolo".
    expect(supportedPermissionModes("agy", { read: null, edit: null, auto: null, yolo: "yolo" })).toEqual([
      "auto",
      "yolo",
    ]);
    expect(
      supportedPermissionModes("agy", { read: "r", edit: "e", auto: null, yolo: "yolo" }),
    ).toEqual(full);
    // A configured entry with no built-in adapter routes nothing.
    expect(supportedPermissionModes("custom", {})).toEqual([]);
  });

  it("routes the agy permission mode through session/set_mode and skips when unset", async () => {
    const calls: string[] = [];
    const client = stubClient({
      "session/set_mode": (params) => {
        calls.push(String(params.modeId));
        return {};
      },
    });
    const adapter = getAdapter("agy");
    await adapter.setMode(client, adapterConfig({ harness: "agy", acpModeId: "agy-edit-mode" }), "s1");
    expect(calls).toEqual(["agy-edit-mode"]);
    await adapter.setMode(client, adapterConfig({ harness: "agy", acpModeId: null }), "s1");
    expect(calls).toEqual(["agy-edit-mode"]);
  });

  it("maps thinking_level to each harness option and validates model-specific choices", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = stubClient({
      "session/set_config_option": (params) => {
        calls.push(params);
        return {};
      },
    });
    for (const [harness, configId] of [
      ["codebuddy", "thought_level"],
      ["codex", "reasoning_effort"],
      ["agy", "thinking_level"],
    ]) {
      await getAdapter(harness).setThinkingLevel(client, "s1", "model-1", "high", [
        { id: configId, options: [{ value: "low" }, { value: "high" }] },
      ]);
      expect(calls.at(-1)).toEqual({ sessionId: "s1", configId, value: "high" });
      await expect(getAdapter(harness).setThinkingLevel(client, "s1", "model-2", "medium", [
        { id: configId, options: [{ value: "low" }, { value: "high" }] },
      ])).rejects.toThrow(/model-2/);
      await expect(getAdapter(harness).setThinkingLevel(client, "s1", "model-2", "high", [])).rejects.toThrow(/model-2/);
    }
    expect(calls).toHaveLength(3);
    await expect(getAdapter("agy").setThinkingLevel(client, "s1", "gemini-2.5-pro", "high", null))
      .rejects.toThrow(/not supported/);
  });

  it("sends the model through session/set_model", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = stubClient({
      "session/set_model": (params) => {
        calls.push(params);
        return {};
      },
    });
    await getAdapter("codex").setModel(client, "m2");
    expect(calls).toEqual([{ sessionId: "s1", modelId: "m2" }]);
  });

  it("reads CodeBuddy account info through the whitelist only", async () => {
    const adapter = new CodeBuddyAdapter();
    const initialize = { result: { authMethods: [{ id: "api-key" }] } };
    const authenticated = await adapter.getAuthInfo(
      stubClient(
        { "_codebuddy.ai/getUserInfo": () => ({ result: { userInfo: { userId: "u1", token: "secret" } } }) },
        initialize,
      ),
      initialize,
    );
    expect(authenticated.authenticated).toBe(true);
    expect(authenticated.methods).toEqual([{ id: "api-key" }]);
    // The credential is dropped; only identity survives.
    expect(authenticated.user).toEqual({ userId: "u1" });

    const anonymous = await adapter.getAuthInfo(
      stubClient({ "_codebuddy.ai/getUserInfo": () => ({ result: { userInfo: {} } }) }, initialize),
      initialize,
    );
    expect(anonymous.authenticated).toBe(false);
    expect(anonymous.user).toBeNull();
  });

  it("reports AuthStatusUnsupported when the harness has no status endpoint", async () => {
    const adapter = getAdapter("codex");
    await expect(adapter.getAuthInfo(stubClient({}), { result: { authMethods: [] } })).rejects.toBeInstanceOf(
      AuthStatusUnsupported,
    );
  });

  it("normalizes authentication/status and fails closed when there is no indicator", () => {
    expect(normalizeAuthStatus({ result: { authenticated: true } }, []).authenticated).toBe(true);
    expect(normalizeAuthStatus({ result: { authenticated: false } }, []).authenticated).toBe(false);
    expect(normalizeAuthStatus({ result: { kind: "api-key" } }, []).authenticated).toBe(true);
    expect(normalizeAuthStatus({ result: { kind: "none" } }, []).authenticated).toBe(false);
    expect(normalizeAuthStatus({ result: { type: "chat-gpt" } }, []).authenticated).toBe(true);
    expect(normalizeAuthStatus({ result: { type: "unknown" } }, []).authenticated).toBe(false);
    // The account is whitelisted, and an email alone is enough.
    const withAccount = normalizeAuthStatus(
      { result: { authenticated: true, account: { email: "a@b.c", token: "t" } } },
      [],
    );
    expect(withAccount.user).toEqual({ email: "a@b.c" });
    // A bare email is used as the account when another field proves login...
    expect(normalizeAuthStatus({ result: { authenticated: true, email: "only@b.c" } }, []).user).toEqual({
      email: "only@b.c",
    });
    // ...but an email alone is not a login indicator, so it fails closed.
    expect(() => normalizeAuthStatus({ result: { email: "only@b.c" } }, [])).toThrow(AuthStatusUnsupported);
    expect(() => normalizeAuthStatus({ result: { something: "else" } }, [])).toThrow(AuthStatusUnsupported);
    expect(() => normalizeAuthStatus({}, [])).toThrow(AuthStatusUnsupported);
    expect(authMethods({ result: { authMethods: [{ id: "a" }, "junk"] } })).toEqual([{ id: "a" }]);
    expect(authMethods({})).toEqual([]);
  });
});

// --- runtime builders --------------------------------------------------------

describe("runtime argument builders", () => {
  it("quotes shell words like shlex", () => {
    expect(shellQuote("simple-1.0:/x")).toBe("simple-1.0:/x");
    expect(shellQuote("has space")).toBe("'has space'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellJoin(["env", "A=1", "cmd --flag"])).toBe("env A=1 'cmd --flag'");
  });

  it("validates docker ids and pid file names", () => {
    expect(isDockerId("a".repeat(64))).toBe(true);
    expect(isDockerId("A".repeat(64))).toBe(false);
    expect(isDockerId("a".repeat(63))).toBe(false);
    expect(newRemotePidFile()).toMatch(/^harness-acp-[0-9a-f]+\.pid$/);
  });

  it("builds docker run arguments with mounts, ports, and network", () => {
    const argv = dockerRunArgs(
      spec({
        dockerImage: "img:1",
        dockerContainerName: "harness-acp-x",
        dockerMounts: [
          { source: "/host/a", target: "/a", read_only: true },
          { source: "/host/b", target: "/b", read_only: false },
        ],
        dockerPorts: [
          { host_port: 8080, container_port: 80, protocol: "tcp", host_ip: "127.0.0.1" },
          { host_port: 9090, container_port: 90, protocol: "udp", host_ip: "::1" },
          { host_port: 7070, container_port: 70, protocol: "tcp", host_ip: null },
        ],
        dockerHostNetwork: false,
      }),
    );
    expect(argv).toEqual([
      "run",
      "--detach",
      "--init",
      "--name",
      "harness-acp-x",
      "--mount",
      "type=bind,src=/host/a,dst=/a,readonly",
      "--mount",
      "type=bind,src=/host/b,dst=/b",
      "-p",
      "127.0.0.1:8080:80/tcp",
      "-p",
      "[::1]:9090:90/udp",
      "-p",
      "7070:70/tcp",
      "--entrypoint",
      "/bin/sh",
      "img:1",
      "-c",
      "while :; do sleep 3600; done",
    ]);
    expect(dockerRunArgs(spec({ dockerImage: "img:1", dockerContainerName: "c", dockerHostNetwork: true }))).toContain(
      "--network",
    );
    expect(dockerRunArgs(spec({ dockerImage: "img:1", dockerContainerName: "c" }))).not.toContain("--network");
  });

  it("wraps docker control commands in ssh for a remote target", () => {
    expect(containerControlArgv(spec(), ["ps"])).toEqual(["docker", "ps"]);
    expect(containerControlArgv(spec({ launchMode: "ssh", sshHost: "h1" }), ["stop", "-t", "0", "name"])).toEqual([
      "ssh",
      "--",
      "h1",
      "docker stop -t 0 name",
    ]);
  });

  it("selects the container cleanup command from the policy", () => {
    const keep = spec({ dockerContainerName: "n", containerPolicy: "keep" });
    const remove = spec({ dockerContainerName: "n", containerPolicy: "remove" });
    expect(containerCleanupArgs(keep, "policy")).toEqual(["stop", "-t", "0", "n"]);
    expect(containerCleanupArgs(remove, "policy")).toEqual(["rm", "-f", "n"]);
    expect(containerCleanupArgs(keep, "force_remove")).toEqual(["rm", "-f", "n"]);
    expect(containerCleanupArgs(keep, "skip")).toEqual([]);
    // A container that was never prepared is left alone when reused, and force-removed when
    // this session may have half-created it.
    expect(containerAction(true, true)).toBe("policy");
    expect(containerAction(false, true)).toBe("skip");
    expect(containerAction(false, false)).toBe("force_remove");
  });

  it("builds the remote wrapper with pid-file supervision", () => {
    const command = remoteCommand(spec({ launchMode: "ssh", sshHost: "h" }));
    expect(command).toContain(`cd /work || exit 1`);
    expect(command).toContain("umask 077");
    expect(command).toContain("harness_pgid=");
    expect(command).toContain("printf \"%s %s\\n\"");
    expect(command).toContain("wait \"$harness_pid\"");
    expect(command).toContain("trap ");
    // The pid file is a single safe token inside the wrapper.
    expect(command).toContain('pid_file="$remote_tmp"/harness-acp-abc.pid');

    // Env is injected for the remote program.
    const withEnv = remoteCommand(spec({ harnessEnv: { A: "1" } }));
    expect(withEnv).toContain("env A=1 codebuddy");

    // For Docker the wrapper must not cd on the host; it enters the container instead.
    const dockerRemote = remoteCommand(
      spec({
        launchMode: "ssh",
        sshHost: "h",
        cwd: "/container/path",
        dockerContainerName: "cid",
        argv: ["codebuddy"],
      }),
    );
    expect(dockerRemote).not.toContain("cd /container/path");
    expect(dockerRemote).toContain("docker exec -i --workdir /container/path cid codebuddy");
  });

  it("builds the remote cleanup command", () => {
    const command = remoteCleanupCommand(spec({ launchMode: "ssh", sshHost: "h" }));
    expect(command).toContain('read harness_pid harness_pgid < "$pid_file"');
    expect(command).toContain('kill -TERM -"$harness_pgid"');
    expect(command).toContain('rm -f "$pid_file"');
    // Skipping leaves a caller-owned container alone but still cleans the pid file.
    expect(remoteCleanupCommand(spec({ dockerContainerName: "cid" }), "skip")).not.toContain("docker");
    expect(remoteCleanupCommand(spec({ dockerContainerName: "cid" }), "policy")).toContain("docker rm -f cid");
  });

  it("builds the transport target for local, docker, and ssh launches", () => {
    const local = buildTransportTarget(spec());
    expect(local.argv).toEqual(["codebuddy", "--acp"]);
    expect(local.cwd).toBe("/work");

    const docker = buildTransportTarget(
      spec({ dockerImage: "img", dockerContainerName: "cid", cwd: "/inside" }),
    );
    expect(docker.argv).toEqual(["docker", "exec", "-i", "--workdir", "/inside", "cid", "codebuddy", "--acp"]);
    expect(docker.cwd).toBeNull();

    const ssh = buildTransportTarget(spec({ launchMode: "ssh", sshHost: "h1" }));
    expect(ssh.argv[0]).toBe("ssh");
    expect(ssh.argv[1]).toBe("--");
    expect(ssh.argv[2]).toBe("h1");
    expect(ssh.cwd).toBeNull();

    // Remote + Docker enters the container on the remote host.
    const sshDocker = buildTransportTarget(
      spec({ launchMode: "ssh", sshHost: "h1", dockerContainerName: "cid", cwd: "/inside" }),
    );
    expect(sshDocker.argv[3]).toContain("docker exec -i --workdir /inside cid codebuddy");
    expect(dockerExecArgv(spec())).toEqual(["codebuddy", "--acp"]);
  });
});

// --- create_session validation ----------------------------------------------

describe("create_session parameter validation", () => {
  const base = { cwd: "/work", model_id: "m1" };
  const expectCode = (params: Record<string, unknown>, code: string): void => {
    try {
      normalizeCreateParams(params);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ParamError);
      expect((error as ParamError).code).toBe(code);
    }
  };

  it("applies the reference defaults", () => {
    const params = normalizeCreateParams(base);
    expect(params).toMatchObject({
      harness: null,
      target: "local",
      runtime: "direct",
      permissionMode: "auto",
      thinkingLevel: null,
      containerPolicy: "remove",
      dockerId: null,
      dockerMounts: [],
      dockerPorts: [],
      dockerHostNetwork: false,
    });
    // A reused container defaults to `keep`, so the caller's container survives.
    const reuse = normalizeCreateParams({ ...base, cwd: "/work", runtime: "docker", docker_id: "e".repeat(64) });
    expect(reuse.containerPolicy).toBe("keep");
    expect(reuse.dockerId).toBe("e".repeat(64));
  });

  it("accepts thinking_level and rejects empty or non-string levels", () => {
    expect(normalizeCreateParams({ ...base, thinking_level: " high " }).thinkingLevel).toBe("high");
    expectCode({ ...base, thinking_level: " " }, "invalid_param");
    expectCode({ ...base, thinking_level: 1 }, "invalid_param");
  });

  it("accepts a complete docker launch and normalizes its options", () => {
    const params = normalizeCreateParams({
      ...base,
      cwd: "/container",
      runtime: "docker",
      docker_image: "img:1",
      host_network: true,
      mounts: [{ source: "/h", target: "/c", read_only: true }],
    });
    expect(params.dockerImage).toBe("img:1");
    expect(params.dockerHostNetwork).toBe(true);
    expect(params.dockerMounts).toEqual([{ source: "/h", target: "/c", read_only: true }]);
  });

  it("refuses launch internals", () => {
    for (const key of ["command", "args", "env", "ssh_host", "ssh_command", "launch_mode", "base_dir", "entrypoint"]) {
      expectCode({ ...base, [key]: "x" }, "launch_internal");
    }
  });

  it("refuses unknown parameters and bad harness names", () => {
    expectCode({ ...base, nope: 1 }, "unknown_param");
    expectCode({ ...base, harness: "other" }, "invalid_param");
    expectCode({ ...base, permission_mode: "root" }, "invalid_param");
    expectCode({ ...base, permission_mode: "bypass" }, "invalid_param");
    expect(normalizeCreateParams({ ...base, permission_mode: "yolo" }).permissionMode).toBe("yolo");
    expectCode({ ...base, target: "cloud" }, "invalid_param");
    expectCode({ ...base, runtime: "podman" }, "invalid_param");
  });

  it("refuses docker options on a direct runtime", () => {
    for (const extra of [
      { docker_image: "img" },
      { docker_id: "f".repeat(64) },
      { mounts: [{ source: "/a", target: "/b" }] },
      { ports: [{ host_port: 1, container_port: 2 }] },
      { host_network: true },
      { container_policy: "keep" },
    ]) {
      expectCode({ ...base, ...extra }, "invalid_param");
    }
  });

  it("refuses invalid or conflicting docker launches", () => {
    const id = "a".repeat(64);
    // Image required, cwd must be an absolute container path, id must be a full hex id.
    expectCode({ ...base, runtime: "docker", cwd: "/work" }, "invalid_param");
    expectCode({ ...base, runtime: "docker", cwd: "work", docker_image: "img" }, "invalid_param");
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_id: "short" }, "invalid_param");
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_id: id.toUpperCase() }, "invalid_param");
    // Reuse conflicts with new-container options.
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_id: id, docker_image: "img" }, "invalid_param");
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_id: id, host_network: true }, "invalid_param");
    expectCode(
      { ...base, runtime: "docker", cwd: "/work", docker_id: id, ports: [{ host_port: 1, container_port: 2 }] },
      "invalid_param",
    );
    // host_network cannot co-exist with published ports.
    expectCode(
      {
        ...base,
        runtime: "docker",
        cwd: "/work",
        docker_image: "img",
        host_network: true,
        ports: [{ host_port: 1, container_port: 2 }],
      },
      "invalid_param",
    );
    // Image reference hygiene.
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_image: "-img" }, "invalid_param");
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_image: "img,2" }, "invalid_param");
    expectCode({ ...base, runtime: "docker", cwd: "/work", docker_image: "x".repeat(256) }, "invalid_param");
  });

  it("validates mounts and ports", () => {
    const docker = { ...base, cwd: "/work", runtime: "docker", docker_image: "img" };
    expectCode({ ...docker, mounts: "nope" }, "invalid_param");
    expectCode({ ...docker, mounts: [{ source: "rel", target: "/b" }] }, "invalid_param");
    expectCode({ ...docker, mounts: [{ source: "/a", target: "rel" }] }, "invalid_param");
    expectCode({ ...docker, mounts: [{ source: "/a,b", target: "/b" }] }, "invalid_param");
    expectCode({ ...docker, mounts: [{ source: "/a", target: "/b", read_only: "yes" }] }, "invalid_param");
    expectCode({ ...docker, mounts: [{ source: "/a", target: "/b", extra: 1 }] }, "invalid_param");
    expectCode(
      {
        ...docker,
        mounts: [
          { source: "/a", target: "/same" },
          { source: "/b", target: "/same" },
        ],
      },
      "invalid_param",
    );
    expectCode({ ...docker, ports: [{ host_port: 1.5, container_port: 2 }] }, "invalid_param");
    expectCode({ ...docker, ports: [{ host_port: 70000, container_port: 2 }] }, "invalid_param");
    expectCode({ ...docker, ports: [{ host_port: 1, container_port: 2, protocol: "icmp" }] }, "invalid_param");
    expectCode({ ...docker, ports: [{ host_port: 1, container_port: 2, host_ip: "1.2.3" }] }, "invalid_param");
    expectCode({ ...docker, ports: [{ host_port: 1, container_port: 2, unexpected: true }] }, "invalid_param");
  });

  it("checks the target/remote_host pairing", () => {
    expectCode({ ...base, target: "remote" }, "invalid_param");
    expectCode({ ...base, target: "local", remote_host: "h" }, "invalid_param");
    const remote = normalizeCreateParams({ ...base, target: "remote", remote_host: "h" });
    expect(remote.remoteHost).toBe("h");
  });

  it("recognizes IPv4 and IPv6 bind addresses", () => {
    expect(isIpAddress("127.0.0.1")).toBe(true);
    expect(isIpAddress("0.0.0.0")).toBe(true);
    expect(isIpAddress("::1")).toBe(true);
    expect(isIpAddress("fe80::1")).toBe(true);
    expect(isIpAddress("::")).toBe(true);
    expect(isIpAddress("127.0.0.1.1")).toBe(false);
    expect(isIpAddress("999.1.1.1")).toBe(false);
    expect(isIpAddress("gggg::1")).toBe(false);
    expect(isIpAddress("1:2:3:4:5:6:7:8:9")).toBe(false);
  });
});
