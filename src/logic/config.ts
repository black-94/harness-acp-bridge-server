/** Administrator-owned HTTP, launch, session policy, and preview configuration. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { supportedPermissionModes, type PermissionMode } from "../adapter/adapters.js";

export const CONFIG_ENV = "HARNESS_ACP_BRIDGE_CONFIG";
export const SCHEMA_VERSION = 2;
export const SERVICE_NAME = "harness-acp-bridge";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const SIZE_RE = /^(?<number>[0-9]+)\s*(?<unit>b|kb|kib|mb|mib|gb|gib)?$/i;
const MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/** Parse `100MiB` / `128KiB` / `4096` into a byte count. */
export function parseSize(value: string | number, label: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ConfigError(`${label} must be a positive byte count`);
    }
    return value;
  }
  const match = SIZE_RE.exec(value.trim());
  if (!match?.groups) {
    throw new ConfigError(`${label} must be a positive byte count (for example 100MiB)`);
  }
  const amount = Number(match.groups.number);
  const unit = (match.groups.unit ?? "b").toLowerCase();
  const bytes = amount * MULTIPLIERS[unit];
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ConfigError(`${label} must be a positive byte count`);
  }
  return bytes;
}

/**
 * Base directory that holds session directories by default.
 *
 * Sessions land directly under `~/.harness-acp-bridge/<date>-<random>/`, not under an
 * XDG state `sessions/` subtree. `XDG_STATE_HOME` is intentionally not consulted here.
 */
export function defaultStateDirectory(): string {
  return join(homedir(), ".harness-acp-bridge");
}

export function defaultConfigPath(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  const base = configured ? configured : join(homedir(), ".config");
  return join(base, SERVICE_NAME, "config.yaml");
}

export interface ModelConfig {
  /** Model id passed verbatim to the harness ACP `session/set_model`. */
  id: string;
  /** Human readable label; defaults to the id when omitted. */
  name: string;
  /**
   * Thinking levels this model may be configured with, as declared in the configuration
   * file. `null` means the file does not declare them: the level is unknown, never assumed
   * supported, and validated only against the live ACP config options when advertised.
   * `[]` means the model was explicitly declared to support none.
   */
  thinkingLevels: string[] | null;
}

export interface HarnessConfig {
  name: string;
  /** Explicitly configured command, or the `launch.<harness>_command` fallback. */
  command: string;
  args: string[];
  env: Record<string, string>;
  models: ModelConfig[];
  description: string | null;
}

export interface BridgeConfig {
  schemaVersion: number;
  /** Path the settings were read from, or null when defaults were used. */
  configPath: string | null;
  paths: {
    stateDir: string;
    sessionDir: string;
  };
  server: {
    host: string;
    port: number;
    maxBodyBytes: number;
  };
  sessions: {
    maxConcurrency: number;
    idleTimeoutSeconds: number;
    reapIntervalSeconds: number;
    /**
     * Threshold (seconds) after which a still-running message with no observed harness
     * progress is flagged as `stalled` for a UI hint. Advisory only: it never changes the
     * absolute `turnTimeoutSeconds` semantics and never fabricates a terminal state.
     * `0` disables the hint.
     */
    stallHintSeconds: number;
  };
  timeouts: {
    startupTimeoutSeconds: number;
    requestTimeoutSeconds: number;
    turnTimeoutSeconds: number;
    turnCancelTimeoutSeconds: number;
    authenticationTimeoutSeconds: number;
    inputTimeoutSeconds: number;
    terminateGraceSeconds: number;
    remoteCleanupTimeoutSeconds: number;
  };
  buffers: {
    maxReadBytes: number;
    previewPageEvents: number;
    previewTextBytes: number;
  };
  /** Launch plumbing: the CLI programs used to reach a harness. Never caller-supplied. */
  launch: {
    sshCommand: string;
    dockerCommand: string;
    /** Configured command per built-in harness name, used when a harness omits `command`. */
    harnessCommands: Record<string, string>;
    /** Agy ACP mode ids per permission mode (`agy_<mode>_mode_id`). */
    agyModeIds: Record<string, string | null>;
  };
  authentication: {
    /** How long one `authenticate` round trip may take before the session is closed. */
    /** How many distinct harness+target authentications may run at once. */
    maxConcurrentTargets: number;
    /** Private ledger file holding the per-target attempt timestamps. */
    ledgerPath: string;
    /**
     * Per harness+target attempt limit. Disabling it skips the persistent ledger entirely
     * (nothing is read or written), which is the escape hatch for a harness whose login is
     * interactive and expected to be retried.
     */
    rateLimit: {
      enabled: boolean;
      minIntervalSeconds: number;
      maxAttempts: number;
      windowSeconds: number;
    };
  };
  harnesses: Record<string, HarnessConfig>;
  defaultHarness: string | null;
  /** Stable hash of the resolved settings; used to detect config drift. */
  fingerprint: string;
}

const modelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    // Optional. Omitted/`null` means "not declared" (unknown); `[]` means "declared none".
    thinking_levels: z.array(z.string().min(1)).nullable().default(null),
  })
  .strict();

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const harnessSchema = z
  .object({
    // Optional: falls back to `launch.<harness>_command` for the built-in harness names.
    command: z.string().min(1).nullable().default(null),
    // Keys must be valid environment variable names; values are arbitrary strings.
    args: z.array(z.string()).default([]),
    env: z.record(z.string().regex(envName), z.string()).default({}),
    models: z.array(modelSchema).default([]),
    description: z.string().nullable().default(null),
  })
  .strict();

const sizeValue = z.union([z.number(), z.string()]);

const fileSchema = z
  .object({
    schema_version: z.number().int().default(SCHEMA_VERSION),
    paths: z
      .object({
        state_dir: z.string().nullable().default(null),
        session_dir: z.string().nullable().default(null),
      })
      .strict()
      .default({}),
    server: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(8787),
        max_body_bytes: sizeValue.default("1MiB"),
      })
      .strict()
      .default({}),
    sessions: z
      .object({
        max_concurrency: z.number().int().positive().default(2),
        idle_timeout_seconds: z.number().nonnegative().default(3600),
        reap_interval_seconds: z.number().positive().default(30),
        stall_hint_seconds: z.number().nonnegative().default(120),
      })
      .strict()
      .default({}),
    timeouts: z
      .object({
        startup_timeout_seconds: z.number().positive().default(60),
        request_timeout_seconds: z.number().positive().default(60),
        turn_timeout_seconds: z.number().positive().default(1800),
        authentication_timeout_seconds: z.number().positive().default(600),
        input_timeout_seconds: z.number().nonnegative().default(0),
        turn_cancel_timeout_seconds: z.number().positive().default(5),
        terminate_grace_seconds: z.number().positive().default(5),
        remote_cleanup_timeout_seconds: z.number().positive().default(10),
      })
      .strict()
      .default({}),
    buffers: z
      .object({
        max_read_bytes: sizeValue.default("100MiB"),
        preview_page_events: z.number().int().positive().default(200),
        preview_text_bytes: sizeValue.default("16KiB"),
      })
      .strict()
      .default({}),
    launch: z
      .object({
        ssh_command: z.string().min(1).default("ssh"),
        docker_command: z.string().min(1).default("docker"),
        codebuddy_command: z.string().min(1).default("codebuddy"),
        codex_command: z.string().min(1).default("codex-acp"),
        agy_command: z.string().min(1).default("agy_acp_server"),
        agy_read_mode_id: z.string().min(1).nullable().default(null),
        agy_edit_mode_id: z.string().min(1).nullable().default(null),
        agy_auto_mode_id: z.string().min(1).nullable().default(null),
        agy_yolo_mode_id: z.string().min(1).nullable().default(null),
      })
      .strict()
      .default({}),
    authentication: z
      .object({
        max_concurrent_targets: z.number().int().positive().default(2),
        ledger_path: z.string().min(1).nullable().default(null),
        rate_limit: z
          .object({
            enabled: z.boolean().default(true),
            min_interval_seconds: z.number().nonnegative().default(60),
            max_attempts: z.number().int().positive().default(10),
            window_seconds: z.number().positive().default(86400),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    default_harness: z.string().nullable().default(null),
    harnesses: z.record(harnessSchema).default({}),
  })
  .strict();

type FileConfig = z.infer<typeof fileSchema>;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolvePath(value: string | null, fallback: string): string {
  return value === null ? fallback : resolve(expandHome(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readConfigFile(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    throw new ConfigError(`could not read configured YAML file ${path}: ${cause.code ?? cause.name} (${cause.message})`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`could not parse YAML at ${path}: ${(error as Error).message}`);
  }
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`configuration at ${path} must be a mapping`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid configuration at ${path}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

/** Resolve loaded file settings (or defaults) into the frozen runtime shape. */
function resolveConfig(file: FileConfig, configPath: string | null): BridgeConfig {
  if (file.schema_version !== SCHEMA_VERSION) {
    throw new ConfigError(`schema_version must be ${SCHEMA_VERSION}`);
  }
  const stateDir = resolvePath(file.paths.state_dir, defaultStateDirectory());
  // Sessions live directly under the base directory: <base>/<date>-<random>/
  const sessionDir = resolvePath(file.paths.session_dir, stateDir);
  if (parseSize(file.buffers.preview_text_bytes, "buffers.preview_text_bytes") < 4) {
    throw new ConfigError("buffers.preview_text_bytes must be at least 4 for UTF-8 paging");
  }

  const harnesses: Record<string, HarnessConfig> = {};
  const modelIds = new Set<string>();
  const launchCommands: Record<string, string> = {
    codebuddy: file.launch.codebuddy_command,
    codex: file.launch.codex_command,
    agy: file.launch.agy_command,
  };
  for (const [name, harness] of Object.entries(file.harnesses)) {
    const command = harness.command ?? launchCommands[name] ?? null;
    if (command === null) {
      throw new ConfigError(
        `harnesses.${name}.command is required for a harness without a launch.*_command default`,
      );
    }
    const models: ModelConfig[] = harness.models.map((model) => {
      if (modelIds.has(`${name}:${model.id}`)) {
        throw new ConfigError(`duplicate model id ${JSON.stringify(model.id)} in harness ${name}`);
      }
      modelIds.add(`${name}:${model.id}`);
      return {
        id: model.id,
        name: model.name ?? model.id,
        thinkingLevels: model.thinking_levels === null ? null : [...model.thinking_levels],
      };
    });
    harnesses[name] = {
      name,
      command,
      args: [...harness.args],
      env: { ...harness.env },
      models,
      description: harness.description,
    };
  }

  let defaultHarness = file.default_harness;
  if (defaultHarness !== null && !(defaultHarness in harnesses)) {
    throw new ConfigError(`default_harness ${JSON.stringify(defaultHarness)} is not a configured harness`);
  }
  if (defaultHarness === null && Object.keys(harnesses).length === 1) {
    defaultHarness = Object.keys(harnesses)[0] ?? null;
  }

  const resolved: Omit<BridgeConfig, "fingerprint"> = {
    schemaVersion: SCHEMA_VERSION,
    configPath,
    paths: { stateDir, sessionDir },
    server: {
      host: file.server.host,
      port: file.server.port,
      maxBodyBytes: parseSize(file.server.max_body_bytes, "server.max_body_bytes"),
    },
    sessions: {
      maxConcurrency: file.sessions.max_concurrency,
      idleTimeoutSeconds: file.sessions.idle_timeout_seconds,
      reapIntervalSeconds: file.sessions.reap_interval_seconds,
      stallHintSeconds: file.sessions.stall_hint_seconds,
    },
    timeouts: {
      startupTimeoutSeconds: file.timeouts.startup_timeout_seconds,
      requestTimeoutSeconds: file.timeouts.request_timeout_seconds,
      authenticationTimeoutSeconds: file.timeouts.authentication_timeout_seconds,
      inputTimeoutSeconds: file.timeouts.input_timeout_seconds,
      turnTimeoutSeconds: file.timeouts.turn_timeout_seconds,
      turnCancelTimeoutSeconds: file.timeouts.turn_cancel_timeout_seconds,
      terminateGraceSeconds: file.timeouts.terminate_grace_seconds,
      remoteCleanupTimeoutSeconds: file.timeouts.remote_cleanup_timeout_seconds,
    },
    buffers: {
      maxReadBytes: parseSize(file.buffers.max_read_bytes, "buffers.max_read_bytes"),
      previewPageEvents: file.buffers.preview_page_events,
      previewTextBytes: parseSize(file.buffers.preview_text_bytes, "buffers.preview_text_bytes"),
    },
    launch: {
      sshCommand: file.launch.ssh_command,
      dockerCommand: file.launch.docker_command,
      harnessCommands: launchCommands,
      agyModeIds: {
        read: file.launch.agy_read_mode_id,
        edit: file.launch.agy_edit_mode_id,
        auto: file.launch.agy_auto_mode_id,
        yolo: file.launch.agy_yolo_mode_id ?? "yolo",
      },
    },
    authentication: {
      maxConcurrentTargets: file.authentication.max_concurrent_targets,
      // The ledger lives under the state dir by default, alongside the session dirs.
      ledgerPath: resolvePath(file.authentication.ledger_path, join(stateDir, "auth-rate.json")),
      rateLimit: {
        enabled: file.authentication.rate_limit.enabled,
        minIntervalSeconds: file.authentication.rate_limit.min_interval_seconds,
        maxAttempts: file.authentication.rate_limit.max_attempts,
        windowSeconds: file.authentication.rate_limit.window_seconds,
      },
    },
    harnesses,
    defaultHarness,
  };

  const fingerprint = createHash("sha256")
    .update(stableStringify(resolved))
    .digest("hex");
  return Object.freeze({ ...resolved, fingerprint });
}

/**
 * Resolve which configuration file would be used, without reading it.
 *
 * Returns `null` when neither an explicit path, the environment variable, nor the
 * default location applies. Used by the server entrypoint and embedders.
 */
export function resolveConfigPath(explicitPath?: string): string | null {
  if (explicitPath) return resolve(expandHome(explicitPath));
  const fromEnv = process.env[CONFIG_ENV];
  if (fromEnv) return resolve(expandHome(fromEnv));
  const candidate = defaultConfigPath();
  return existsSync(candidate) ? candidate : null;
}

/**
 * Load settings from an explicit path, the `HARNESS_ACP_BRIDGE_CONFIG` environment
 * variable, or the default config location. Missing default config yields defaults;
 * an explicitly requested but missing file is an error.
 */
export function loadConfig(explicitPath?: string): BridgeConfig {
  const path = resolveConfigPath(explicitPath);
  if (path === null) return resolveConfig(fileSchema.parse({}), null);
  if (!existsSync(path)) throw new ConfigError(`configured YAML file does not exist: ${path}`);
  return resolveConfig(readConfigFile(path), path);
}

/** Resolve a harness by name, preferring the configured default. */
export function resolveHarness(config: BridgeConfig, name?: string | null): HarnessConfig {
  const target = name ?? config.defaultHarness;
  if (target === null || target === undefined) {
    throw new ConfigError("no harness selected and no default_harness is configured");
  }
  const harness = config.harnesses[target];
  if (!harness) {
    const known = Object.keys(config.harnesses).sort().join(", ") || "<none>";
    throw new ConfigError(`unknown harness ${JSON.stringify(target)}; configured: ${known}`);
  }
  return harness;
}

/** Look up a configured model, returning `undefined` when it is not listed. */
export function findModel(
  config: BridgeConfig,
  harness: string,
  modelId: string,
): ModelConfig | undefined {
  return config.harnesses[harness]?.models.find((model) => model.id === modelId);
}

/**
 * Declared thinking levels for a configured model: the configured array (which may be empty),
 * or `null` when the configuration does not declare them. Never guesses a level.
 */
export function declaredThinkingLevels(
  config: BridgeConfig,
  harness: string,
  modelId: string,
): string[] | null {
  return findModel(config, harness, modelId)?.thinkingLevels ?? null;
}

/** One configured model's declaration, as reported by `search_harness`. */
export interface HarnessModelInfo {
  id: string;
  name: string;
  /** Declared levels, or `null` when the configuration does not declare them. */
  thinking_levels: string[] | null;
}

/** One configured harness's declaration, as reported by `search_harness`. */
export interface HarnessInfo {
  name: string;
  description: string | null;
  command: string;
  /**
   * Permission modes the built-in adapter can actually route with this configuration. Empty
   * for a configured entry without a built-in adapter.
   */
  permission_modes: PermissionMode[];
  models: HarnessModelInfo[];
}

/** Describe one configured harness from the configuration file only. */
export function describeHarness(config: BridgeConfig, name: string): HarnessInfo {
  const harness = resolveHarness(config, name);
  return {
    name: harness.name,
    description: harness.description,
    command: harness.command,
    permission_modes: supportedPermissionModes(harness.name, config.launch.agyModeIds),
    models: harness.models.map((model) => ({
      id: model.id,
      name: model.name,
      thinking_levels: model.thinkingLevels === null ? null : [...model.thinkingLevels],
    })),
  };
}

/**
 * Describe one configured harness, or every configured harness, from the configuration file
 * only. An explicitly requested unknown harness is an error (see `resolveHarness`).
 */
export function harnessInfo(
  config: BridgeConfig,
  harness?: string | null,
): Record<string, HarnessInfo> {
  const names =
    harness !== undefined && harness !== null ? [harness] : Object.keys(config.harnesses).sort();
  const described: Record<string, HarnessInfo> = {};
  for (const name of names) described[name] = describeHarness(config, name);
  return described;
}
