/**
 * Harness adapters.
 *
 * Ports `harness_acp_mcp/adapters.py`: per-harness argument construction, permission-mode
 * routing, and authentication status probing. A caller can never influence the command line
 * or environment beyond what the adapter and the config file decide.
 */
import { BridgeError } from "../logic/errors.js";
import { publicAccount } from "../redact/privacy.js";

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
  constructor(message: string, readonly detail?: unknown) { super(message); }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Arguments that would detach the harness from the supervised process group. */
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

/**
 * Shared launch-argv safety check used by both template registration and `create_session`
 * normalization, so a managed/detaching argument is rejected before a session ever starts.
 *
 * Detaching arguments are refused for every harness; CodeBuddy's adapter-owned flags (which the
 * adapter injects itself) can never be overridden by a caller. A null harness means the server's
 * default harness is not yet known, so only the universal detach rule applies here — the adapter's
 * own `validate` still enforces the harness-specific rule once the harness is resolved.
 */
export function assertLaunchArgs(harness: string | null, args: readonly string[]): void {
  for (const value of args) {
    const flag = value.split("=", 1)[0] ?? "";
    assert(
      !DETACH_ARGS.has(flag) && value !== "setsid",
      `argument may detach from the managed process group: ${value}`,
    );
  }
  if (harness === "codebuddy") {
    for (const value of args) {
      const flag = value.split("=", 1)[0] ?? "";
      assert(!CODEBUDDY_MANAGED.has(flag), `CodeBuddy argument is managed by the adapter: ${value}`);
    }
  }
}

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
  /** Current live options/model, used only for protocol compatibility routing. */
  configOptions?(): Array<Record<string, unknown>> | null;
  modelId?(): string | null;
  reasoningEffort?(): string | null;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AuthInfo {
  authenticated: boolean;
  methods: Array<Record<string, unknown>>;
  user: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

/**
 * A normalized step of an interactive login: something the user must do (open a URL, enter a
 * token/device code) before the harness `authenticate` call can complete. Never a success state.
 */
export interface AuthInteraction {
  title: string;
  message: string;
  schema: Record<string, unknown>;
  raw?: unknown;
}

/** Structural view of a reverse question, so adapters never import the protocol module. */
export interface AuthQuestion {
  kind: string;
  title: string;
  message: string;
  /** URL-mode elicitation target (`elicitation/create` with `mode: "url"`). */
  url?: string | null;
}

/** Browser actions only need an acknowledgement; the harness still waits for the real login. */
const BROWSER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { opened: { type: "boolean", enum: [true] } },
  required: ["opened"],
  additionalProperties: false,
};

export interface HarnessAdapter {
  readonly name: HarnessName;
  validate(config: AdapterConfig): void;
  buildArgv(config: AdapterConfig): string[];
  getAuthInfo(client: AdapterClient, initializeResponse: Record<string, unknown>): Promise<AuthInfo>;
  authenticate(client: AdapterClient, methodId: string): Promise<AuthInfo>;
  /** Normalize a harness auth *notification* (an `auth` output event). */
  normalizeAuthInteraction(data: unknown): AuthInteraction | null;
  /** Normalize an incoming reverse question that belongs to the auth flow, or null. */
  normalizeAuthQuestion(question: AuthQuestion): AuthInteraction | null;
  /** Strict, per-harness stderr line hook that recognizes the harness's own login URL. */
  normalizeAuthStderr(line: string): AuthInteraction | null;
  setModel(client: AdapterClient, modelId: string): Promise<Record<string, unknown>>;
  /** Harness-specific permission-mode routing; default is a no-op. */
  setMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void>;
  setPermissionMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void>;
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
    assertLaunchArgs(this.name, config.args);
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
      if (rpcCode(error) === -32601) throw new AuthStatusUnsupported("authentication/status unsupported", (error as { detail?: unknown }).detail);
      throw error;
    }
    return normalizeAuthStatus(response, methods);
  }

  async authenticate(client: AdapterClient, methodId: string): Promise<AuthInfo> {
    const response = await client.request("authenticate", { methodId });
    assertAuthenticateResult(response);
    return this.getAuthInfo(client, client.initializeResponse());
  }

  normalizeAuthInteraction(_data: unknown): AuthInteraction | null { return null; }

  normalizeAuthQuestion(_question: AuthQuestion): AuthInteraction | null { return null; }

  normalizeAuthStderr(_line: string): AuthInteraction | null { return null; }

  async setModel(client: AdapterClient, modelId: string): Promise<Record<string, unknown>> {
    return client.request("session/set_model", { sessionId: client.sessionId(), modelId });
  }

  async setMode(_client: AdapterClient, _config: AdapterConfig, _sessionId: string): Promise<void> {
    // Most harnesses fix their mode at launch; only Codex and Agy need a round trip.
  }

  async setPermissionMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void> {
    await this.setMode(client, config, sessionId);
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
    const response = await client.request("session/set_config_option", { sessionId, configId, value: level });
    assertReturnedOption(response, configId, level);
  }
}

export class CodeBuddyAdapter extends BaseAdapter {
  readonly name: HarnessName = "codebuddy";

  override async setPermissionMode(client: AdapterClient, config: AdapterConfig, sessionId: string): Promise<void> {
    await client.request("session/set_mode", { sessionId, modeId: CODEBUDDY_MODE_FLAGS[config.permissionMode] });
  }

  override validate(config: AdapterConfig): void {
    // BaseAdapter.validate already applies the CodeBuddy managed-flag rule (via assertLaunchArgs).
    super.validate(config);
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
    // Prefer the common ACP extension, and use the vendor endpoint only when absent.
    try { return await super.getAuthInfo(client, initializeResponse); }
    catch (error) { if (!(error instanceof AuthStatusUnsupported)) throw error; }
    const methods = authMethods(initializeResponse);
    let response: Record<string, unknown>;
    try {
      response = await client.request("_codebuddy.ai/getUserInfo", {});
    } catch (error) {
      if (rpcCode(error) === -32601) throw new AuthStatusUnsupported("getUserInfo unsupported", (error as { detail?: unknown }).detail);
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

  override normalizeAuthInteraction(data: unknown): AuthInteraction | null {
    // Only CodeBuddy's proprietary `_codebuddy.ai/authUrl` notification is an auth step; a generic
    // status frame that merely carries a `url` is left as explicit unsupported traffic.
    if (!isRecord(data) || data.method !== "_codebuddy.ai/authUrl") return null;
    const params = isRecord(data.params) ? data.params : null;
    const value = params?.authUrl ?? params?.authURL ?? params?.auth_url ?? params?.url;
    if (typeof value !== "string" || !/^https?:\/\/\S+$/i.test(value)) return null;
    // The whole usable URL is the message; confirming it is only an acknowledgement, never proof of
    // login.
    return { title: "Complete CodeBuddy authentication", message: value, schema: BROWSER_SCHEMA, raw: data };
  }
}

export class CodexAdapter extends BaseAdapter {
  readonly name: HarnessName = "codex";

  /** Keep public model IDs independent of reasoning effort and legacy ACP syntax. */
  override async setModel(client: AdapterClient, modelId: string): Promise<Record<string, unknown>> {
    // Preserve existing callers that explicitly select a legacy model[effort] ID.
    if (/\[[^\]]+\]$/.test(modelId)) return super.setModel(client, modelId);
    const options = client.configOptions?.() ?? null;
    const hasModelOption = options?.some((option) => option.id === "model" || option.configId === "model");
    if (options === null || hasModelOption) {
      try {
        const response = await client.request("session/set_config_option", {
          sessionId: client.sessionId(), configId: "model", value: modelId,
        });
        assertReturnedOption(response, "model", modelId);
        return response;
      } catch (error) {
        // Only a missing method proves this interface is unavailable. Never retry
        // invalid models, permission/auth failures or timeouts through another API.
        if (rpcCode(error) !== -32601) throw error;
      }
    }
    // Older codex-acp requires model[effort]. Carry the *observed* current effort
    // across the switch; never invent [high] or silently replace a user's choice.
    const effortOption = options?.find((option) => option.id === "reasoning_effort" || option.configId === "reasoning_effort");
    const current = client.modelId?.();
    const effort = typeof effortOption?.currentValue === "string"
      ? effortOption.currentValue
      : client.reasoningEffort?.() ?? current?.match(/\[([^\]]+)\]$/)?.[1];
    if (!effort) {
      throw new AdapterError("legacy codex model selection requires an observed reasoning effort; upgrade codex-acp or use an explicit model[effort] ID");
    }
    return super.setModel(client, `${modelId}[${effort}]`);
  }

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

  /**
   * The ChatGPT device-code flow raises a URL-mode `elicitation/create` whose message carries the
   * machine code the user types in the browser and whose `url` is the verification page. The
   * normalized question must contain BOTH the full verification URL and the machine code; accepting
   * only acknowledges, the login still has to complete.
   */
  override normalizeAuthQuestion(question: AuthQuestion): AuthInteraction | null {
    if (question.kind !== "elicitation") return null;
    const url = typeof question.url === "string" ? question.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url)) return null;
    const text = question.message.trim();
    const message = text && text.includes(url) ? text : [text, url].filter(Boolean).join("\n");
    return { title: "Complete Codex authentication", message, schema: BROWSER_SCHEMA, raw: question };
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

  /**
   * Agy 1.3.0's OAuth loopback login prints its authorization URL to stderr (never stdout, which
   * is the JSON-RPC channel) and blocks the `authenticate` call until the browser round-trip
   * completes. Only that exact, harness-owned line is an auth URL; arbitrary stderr — including
   * tracebacks with unrelated links — is not.
   */
  override normalizeAuthStderr(line: string): AuthInteraction | null {
    const match = /^Open the following link to authenticate the ACP server:\s*(https?:\/\/\S+)\s*$/.exec(line.trim());
    if (!match) return null;
    const url = match[1]!;
    if (!/^https?:\/\/\S+$/i.test(url)) return null;
    return { title: "Complete Agy authentication", message: url, schema: BROWSER_SCHEMA, raw: { line: line.trim() } };
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

/** Acknowledgement alone is not a readback. Reject a contradictory value when provided. */
function assertReturnedOption(response: Record<string, unknown>, configId: string, requested: string): void {
  const result = isRecord(response.result) ? response.result : null;
  if (!Array.isArray(result?.configOptions)) return;
  const option = result.configOptions.filter(isRecord).find(entry => entry.id === configId || entry.configId === configId);
  if (option && "currentValue" in option && option.currentValue !== requested) {
    throw new AdapterError(`harness reported ${configId}=${JSON.stringify(option.currentValue)} after requesting ${JSON.stringify(requested)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The ACP `AuthenticateResponse` is an empty object (optionally with `_meta`); the harness session
 * opening right after is the real proof of login. Known vendor shapes that carry an explicit login
 * flag are honoured; an unknown non-empty shape is refused rather than treated as success, so a
 * nonstandard `{success:false}` (or any unrecognised payload) is never accepted.
 */
export function assertAuthenticateResult(response: Record<string, unknown>): void {
  const result = isRecord(response.result) ? response.result : null;
  if (!result) throw new BridgeError("unsupported_response", "authenticate returned no result object", { raw: response });
  if (typeof result.authenticated === "boolean") {
    if (!result.authenticated) throw new BridgeError("authentication_failed", "harness reported the login did not complete", { result });
    return;
  }
  if (typeof result.success === "boolean") {
    if (!result.success) throw new BridgeError("authentication_failed", "harness reported the login did not succeed", { result });
    return;
  }
  const unknown = Object.keys(result).filter(key => key !== "_meta");
  if (unknown.length) throw new BridgeError("unsupported_response", `unsupported authenticate result fields: ${unknown.join(", ")}`, { result });
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
  } else if (["api-key", "chat-gpt", "gateway", "authenticated"].includes(kind)) {
    authenticated = true;
  } else if (["none", "unauthenticated", "auth_required", "auth-required"].includes(kind)) {
    authenticated = false;
  } else if (["api-key", "chat-gpt", "gateway"].includes(statusType)) {
    authenticated = true;
  } else if (["none", "unauthenticated", "auth-required"].includes(statusType)) {
    authenticated = false;
  } else {
    throw new AuthStatusUnsupported("authentication status has no reliable login indicator", candidate);
  }
  let account = isRecord(candidate.account) ? candidate.account : null;
  if (!account && typeof candidate.email === "string") account = { email: candidate.email };
  return { authenticated, methods, user: publicAccount(account), raw: candidate };
}
