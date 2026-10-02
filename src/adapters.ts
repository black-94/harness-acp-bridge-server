/**
 * Harness adapters.
 *
 * Ports `harness_acp_mcp/adapters.py`: per-harness argument construction, permission-mode
 * routing, and authentication status probing. A caller can never influence the command line
 * or environment beyond what the adapter and the config file decide.
 */
import { publicAccount } from "./persistence.js";

export type HarnessName = "codebuddy" | "codex" | "agy";
export type LaunchMode = "local" | "ssh";
export type Runtime = "direct" | "docker";
export type PermissionMode = "read" | "edit" | "auto" | "yolo";
export type ContainerPolicy = "remove" | "keep";

export class AdapterError extends Error {
  override name = "AdapterError";
}

/** Raised when a harness has no reliable auth-status endpoint. */
export class AuthStatusUnsupported extends Error {
  override name = "AuthStatusUnsupported";
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DETACH_ARGS = new Set(["--bg", "--background", "--tmux", "--tmux-classic", "--serve"]);
const CODEBUDDY_MANAGED = new Set([
  "--acp",
  "--acp-transport",
  "--model",
  "--permission-mode",
  "--input-format",
  "--output-format",
  "--print",
  "-p",
]);
const PERMISSION_MODES: readonly PermissionMode[] = ["read", "edit", "auto", "yolo"];

const CODEBUDDY_MODE_FLAGS: Record<PermissionMode, string> = {
  read: "plan",
  edit: "acceptEdits",
  auto: "auto",
  yolo: "bypassPermissions",
};

/** The subset of the session config the adapters validate and read. */
export interface AdapterConfig {
  harness: string;
  cwd: string;
  modelId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  launchMode: LaunchMode;
  runtime: Runtime;
  permissionMode: PermissionMode;
  /** Agy ACP mode id resolved from `launch.agy_<permission_mode>_mode_id`. */
  acpModeId: string | null;
  sshHost: string | null;
  dockerImage: string | null;
  reuseContainer: boolean;
}

export interface AdapterClient {
  sessionId(): string | null;
  initializeResponse(): Record<string, unknown>;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AuthInfo {
  authenticated: boolean;
  methods: Array<Record<string, unknown>>;
  user: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface HarnessAdapter {
  readonly name: HarnessName;
  validate(config: AdapterConfig): void;
  buildArgv(config: AdapterConfig): string[];
  getAuthInfo(client: AdapterClient, initializeResponse: Record<string, unknown>): Promise<AuthInfo>;
  authenticate(client: AdapterClient, methodId: string): Promise<AuthInfo>;
  setModel(client: AdapterClient, modelId: string): Promise<void>;
  /** Harness-specific permission-mode routing; default is a no-op. */
  setMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void>;
  /** Apply the requested reasoning level for the selected model (never silently ignore it). */
  setThinkingLevel(
    client: AdapterClient,
    sessionId: string,
    modelId: string,
    level: string,
    configOptions: Array<Record<string, unknown>> | null,
  ): Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AdapterError(message);
}

abstract class BaseAdapter implements HarnessAdapter {
  abstract readonly name: HarnessName;

  validate(config: AdapterConfig): void {
    assert(config.cwd.trim(), "cwd must not be empty");
    assert(config.modelId.trim(), "model_id must not be empty");
    assert(
      config.launchMode === "local" || config.launchMode === "ssh",
      "launch_mode must be local or ssh",
    );
    assert(
      config.launchMode !== "ssh" || Boolean(config.sshHost),
      "ssh_host is required for SSH launch mode",
    );
    assert(config.command.trim(), "command must not be empty");
    assert(
      config.runtime === "direct" || config.runtime === "docker",
      "runtime must be direct or docker",
    );
    assert(
      PERMISSION_MODES.includes(config.permissionMode),
      "permission_mode must be read, edit, auto, or yolo",
    );
    assert(
      config.runtime !== "docker" || config.reuseContainer || Boolean(config.dockerImage),
      `Docker image is required for ${config.harness} with runtime=docker`,
    );
    for (const name of Object.keys(config.env)) {
      assert(ENV_NAME.test(name), `invalid environment variable name: ${JSON.stringify(name)}`);
    }
    for (const value of config.args) {
      const flag = value.split("=", 1)[0] ?? "";
      assert(
        !DETACH_ARGS.has(flag) && value !== "setsid",
        `argument may detach from the managed process group: ${value}`,
      );
    }
  }

  buildArgv(config: AdapterConfig): string[] {
    this.validate(config);
    return [config.command, ...config.args];
  }

  async getAuthInfo(
    client: AdapterClient,
    initializeResponse: Record<string, unknown>,
  ): Promise<AuthInfo> {
    const methods = authMethods(initializeResponse);
    let response: Record<string, unknown>;
    try {
      response = await client.request("authentication/status", {});
    } catch (error) {
      if (rpcCode(error) === -32601) throw new AuthStatusUnsupported("authentication/status unsupported");
      throw error;
    }
    return normalizeAuthStatus(response, methods);
  }

  async authenticate(client: AdapterClient, methodId: string): Promise<AuthInfo> {
    await client.request("authenticate", { methodId });
    return this.getAuthInfo(client, client.initializeResponse());
  }

  async setModel(client: AdapterClient, modelId: string): Promise<void> {
    await client.request("session/set_model", { sessionId: client.sessionId(), modelId });
  }

  async setMode(_client: AdapterClient, _config: AdapterConfig, _sessionId: string): Promise<void> {
    // Most harnesses fix their mode at launch; only Codex and Agy need a round trip.
  }

  async setThinkingLevel(
    client: AdapterClient,
    sessionId: string,
    modelId: string,
    level: string,
    configOptions: Array<Record<string, unknown>> | null,
  ): Promise<void> {
    const configId = {
      codebuddy: "thought_level",
      codex: "reasoning_effort",
      agy: "thinking_level",
    }[this.name];
    // agy-acp accepts this option for Gemini 2 but ignores it during generation.
    if (this.name === "agy" && modelId.startsWith("gemini-2.")) {
      throw new AdapterError(`thinking_level is not supported by agy model ${modelId}`);
    }
    if (configOptions !== null) {
      const option = configOptions.find((entry) => entry.id === configId || entry.configId === configId);
      if (!option) throw new AdapterError(`thinking_level is not supported by ${this.name} model ${modelId}`);
      if (Array.isArray(option.options)) {
        const values = option.options.filter(isRecord).map((entry) => entry.value);
        if (!values.includes(level)) {
          throw new AdapterError(`thinking_level ${JSON.stringify(level)} is not supported by ${this.name} model ${modelId}`);
        }
      }
    }
    await client.request("session/set_config_option", { sessionId, configId, value: level });
  }
}

export class CodeBuddyAdapter extends BaseAdapter {
  readonly name: HarnessName = "codebuddy";

  override validate(config: AdapterConfig): void {
    super.validate(config);
    for (const value of config.args) {
      const flag = value.split("=", 1)[0] ?? "";
      assert(
        !CODEBUDDY_MANAGED.has(flag),
        `CodeBuddy argument is managed by the adapter: ${value}`,
      );
    }
  }

  override buildArgv(config: AdapterConfig): string[] {
    this.validate(config);
    return [
      config.command,
      ...config.args,
      "--model",
      config.modelId,
      "--permission-mode",
      CODEBUDDY_MODE_FLAGS[config.permissionMode],
      "--acp",
      "--acp-transport",
      "stdio",
    ];
  }

  override async getAuthInfo(
    client: AdapterClient,
    initializeResponse: Record<string, unknown>,
  ): Promise<AuthInfo> {
    const methods = authMethods(initializeResponse);
    let response: Record<string, unknown>;
    try {
      response = await client.request("_codebuddy.ai/getUserInfo", {});
    } catch (error) {
      if (rpcCode(error) === -32601) throw new AuthStatusUnsupported("getUserInfo unsupported");
      throw error;
    }
    const result = isRecord(response.result) ? response.result : {};
    const user = result.userInfo;
    // ``userInfo`` may carry live credentials; only whitelisted identity fields survive.
    // The login boolean stays tied to the raw object so a user whose only fields are
    // redacted credentials is still reported as authenticated.
    return {
      authenticated: isRecord(user) && Object.keys(user).length > 0,
      methods,
      user: publicAccount(user),
      raw: result,
    };
  }
}

export class CodexAdapter extends BaseAdapter {
  readonly name: HarnessName = "codex";

  /** Codex selects its permission mode through a session config option, not argv. */
  override async setMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void> {
    const mode: Record<PermissionMode, string> = {
      read: "read-only",
      edit: "agent",
      auto: "agent",
      yolo: "agent-full-access",
    };
    await client.request("session/set_config_option", {
      sessionId,
      configId: "mode",
      value: mode[config.permissionMode],
    });
  }
}

export class AgyAdapter extends BaseAdapter {
  readonly name: HarnessName = "agy";

  override validate(config: AdapterConfig): void {
    super.validate(config);
    assert(
      config.permissionMode === "auto" || Boolean(config.acpModeId),
      `launch.agy_${config.permissionMode}_mode_id must be configured`,
    );
  }

  /** Agy selects its mode through the ACP `session/set_mode` method. */
  override async setMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void> {
    // No mode id configured for this permission mode: leave the harness default alone.
    if (!config.acpModeId) return;
    await client.request("session/set_mode", { sessionId, modeId: config.acpModeId });
  }
}

const ADAPTERS: Record<string, HarnessAdapter> = {
  codebuddy: new CodeBuddyAdapter(),
  codex: new CodexAdapter(),
  agy: new AgyAdapter(),
};

export function getAdapter(name: string): HarnessAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new AdapterError(`unsupported harness: ${JSON.stringify(name)}`);
  return adapter;
}

export function isBuiltinHarness(name: string): name is HarnessName {
  return name in ADAPTERS;
}

/**
 * Permission modes a built-in harness can actually route with the current configuration.
 *
 * CodeBuddy and Codex can route all four modes unconditionally. Agy selects its mode with
 * `session/set_mode` using `launch.agy_<mode>_mode_id`: `auto` may use the harness default
 * (no id needed) and `yolo` defaults to `"yolo"`, but `read`/`edit` are routable only when
 * their explicit mode id is configured (`AgyAdapter.validate` rejects them otherwise). An
 * entry with no built-in adapter reports no supported modes rather than assuming any.
 */
export function supportedPermissionModes(
  harness: string,
  agyModeIds: Record<string, string | null>,
): PermissionMode[] {
  if (!isBuiltinHarness(harness)) return [];
  if (harness !== "agy") return [...PERMISSION_MODES];
  return PERMISSION_MODES.filter((mode) => {
    if (mode === "auto" || mode === "yolo") return true;
    return Boolean(agyModeIds[mode]);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcCode(error: unknown): number | null {
  if (error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "number") {
    return (error as { code: number }).code;
  }
  return null;
}

export function authMethods(initializeResponse: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = isRecord(initializeResponse.result) ? initializeResponse.result : null;
  const methods = result?.authMethods;
  return Array.isArray(methods) ? methods.filter(isRecord) : [];
}

/** Port of `_normalize_auth_status`: fail closed when there is no reliable indicator. */
export function normalizeAuthStatus(
  response: Record<string, unknown>,
  methods: Array<Record<string, unknown>>,
): AuthInfo {
  const result = isRecord(response.result) ? response.result : null;
  if (!result) throw new AuthStatusUnsupported("authentication/status returned no object");
  const candidate = isRecord(result.authStatus) ? result.authStatus : result;
  const explicit = candidate.authenticated;
  const kind = String(candidate.kind ?? "").toLowerCase();
  const statusType = String(candidate.type ?? "").toLowerCase();
  let authenticated: boolean;
  if (typeof explicit === "boolean") {
    authenticated = explicit;
  } else if (kind) {
    authenticated = !["none", "unauthenticated", "auth_required", "unknown"].includes(kind);
  } else if (["api-key", "chat-gpt", "gateway"].includes(statusType)) {
    authenticated = true;
  } else if (["none", "unauthenticated", "auth-required", "unknown"].includes(statusType)) {
    authenticated = false;
  } else {
    throw new AuthStatusUnsupported("authentication status has no reliable login indicator");
  }
  let account = isRecord(candidate.account) ? candidate.account : null;
  if (!account && typeof candidate.email === "string") account = { email: candidate.email };
  return { authenticated, methods, user: publicAccount(account), raw: candidate };
}
