/**
 * `create_session` parameter validation.
 *
 * A caller chooses *where* and *how* a harness runs (local/remote, direct/docker, and explicit
 * Docker options) and may now also supply the launch executable itself (`command`/`args`/`env`,
 * plus Docker-only `login_dirs`). The remaining launch plumbing is still server-owned and rejected:
 * the SSH program and its arguments, state/session/metadata paths, buffer bounds, and the Docker
 * control program. A caller-supplied `command` is trusted to be *some* executable, but the ACP
 * identity handshake still verifies it really is the selected harness.
 */
import { assertLaunchArgs, isBuiltinHarness, type ContainerPolicy, type PermissionMode, type Runtime } from "../adapter/adapters.js";
import type { DockerMountSpec, DockerPortSpec } from "../io/runtime.js";

export class ParamError extends Error {
  override name = "ParamError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Keys a create_session caller must never supply; they remain owned by the server.
 *
 * `command`, `args`, and `env` were moved out of this set: the public contract now accepts them as
 * direct session parameters. `login_dirs` is likewise caller-supplied but Docker-only.
 */
export const LAUNCH_INTERNALS: ReadonlySet<string> = new Set([
  "ssh_command",
  "ssh_args",
  "ssh_host",
  "launch_mode",
  "harness_options",
  "max_read_bytes",
  "max_output_bytes",
  "base_dir",
  "session_dir",
  "state_dir",
  "docker_command",
  "entrypoint",
  "container_record_id",
  "resume_record_id",
  "metadata_path",
  "remote_pid_file",
  "proxy_command",
  "identity_file",
  "strict_host_key_checking",
]);

const ALLOWED_KEYS = [
  "harness",
  "command",
  "args",
  "env",
  "cwd",
  "model_id",
  "thinking_level",
  "permission_mode",
  "resume_session_id",
  "session_id",
  "target",
  "remote_host",
  "runtime",
  "container_policy",
  "docker_id",
  "docker_image",
  "login_dirs",
  "mounts",
  "ports",
  "host_network",
] as const;

const DOCKER_ONLY = ["container_policy", "docker_id", "docker_image", "host_network", "login_dirs", "mounts", "ports"];
const DOCKER_ID_RE = /^[0-9a-f]{64}$/;
const MAX_DOCKER_MOUNTS = 64;
const MAX_DOCKER_PORTS = 64;
const PERMISSION_MODES: readonly PermissionMode[] = ["read", "edit", "auto", "yolo"];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CreateSessionParams {
  harness: string | null;
  /** Explicit launch executable, or null to use the harness's built-in command. */
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  modelId: string;
  thinkingLevel: string | null;
  permissionMode: PermissionMode;
  target: "local" | "remote";
  remoteHost: string | null;
  runtime: Runtime;
  dockerId: string | null;
  dockerImage: string | null;
  /** `login_dirs` merged with `mounts` (Docker only); targets are unique and the total is capped. */
  dockerMounts: DockerMountSpec[];
  dockerPorts: DockerPortSpec[];
  dockerHostNetwork: boolean;
  containerPolicy: ContainerPolicy;
  resumeSessionId: string | null;
  sessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ParamError("invalid_param", `${name} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new ParamError("invalid_param", `${name} must not contain NUL`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new ParamError("invalid_param", `${name} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new ParamError("invalid_param", `${name} must not contain NUL`);
  return value.trim();
}

function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ParamError("invalid_param", `${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Pure launch-command normalization shared with template registration.
 *
 * Empty/null/omitted means "use the built-in harness executable". A non-empty value must be an
 * absolute executable path or a single executable name — never a shell command string, an
 * option-leading token, a relative path, or a NUL-bearing string.
 */
export function normalizeCommand(value: unknown, name = "command"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ParamError("invalid_param", `${name} must be a string`);
  const command = value.trim();
  if (!command) return null;
  if (command.includes("\0")) throw new ParamError("invalid_param", `${name} must not contain NUL`);
  if (command.startsWith("-") || (!command.startsWith("/") && /[/\s]/.test(command))) {
    throw new ParamError("invalid_param", `${name} must be an absolute executable path or a single executable name`);
  }
  return command;
}

/** Pure argv validation shared with template registration: a string array without NUL. */
export function normalizeArgs(value: unknown, name = "args"): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ParamError("invalid_param", `${name} must be a list of strings`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new ParamError("invalid_param", `${name}[${index}] must be a string`);
    if (item.includes("\0")) throw new ParamError("invalid_param", `${name}[${index}] must not contain NUL`);
    return item;
  });
}

/** Pure environment validation shared with template registration: valid names mapped to strings. */
export function normalizeEnv(value: unknown, name = "env"): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ParamError("invalid_param", `${name} must be a map of string values`);
  // `env[key] = value` would invoke the inherited `__proto__` setter and silently drop a legal
  // `__proto__` key; `Object.fromEntries` defines every own data property (all ENV_NAME_RE names,
  // including `__proto__`/`constructor`/`toString`) instead of assigning through the prototype.
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_NAME_RE.test(key)) {
      throw new ParamError("invalid_param", `${name} has an invalid environment variable name: ${JSON.stringify(key)}`);
    }
    if (typeof item !== "string") {
      throw new ParamError("invalid_param", `${name}.${key} must be a string`);
    }
    if (item.includes("\0")) throw new ParamError("invalid_param", `${name}.${key} must not contain NUL`);
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

export function assertNoLaunchInternals(params: Record<string, unknown>): void {
  const internals = Object.keys(params).filter((key) => LAUNCH_INTERNALS.has(key));
  if (internals.length > 0) {
    throw new ParamError(
      "launch_internal",
      `launch internals are not accepted from callers: ${internals.sort().join(", ")}`,
    );
  }
}

export function assertAllowedKeys(params: Record<string, unknown>, allowed: readonly string[]): void {
  assertNoLaunchInternals(params);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(params).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new ParamError("unknown_param", `unsupported parameter(s): ${unknown.sort().join(", ")}`);
  }
}

function dockerImageValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ParamError(
      "invalid_param",
      "docker_image is required when runtime=docker creates a new container",
    );
  }
  const image = value.trim();
  if (image.includes("\0")) throw new ParamError("invalid_param", "docker_image must not contain NUL");
  if (image.startsWith("-") || /[,\s]/.test(image)) {
    throw new ParamError(
      "invalid_param",
      "docker_image must be a single image reference without whitespace or commas",
    );
  }
  if (image.length > 255) {
    throw new ParamError("invalid_param", "docker_image must be at most 255 characters");
  }
  return image;
}

/**
 * Type-check `docker_image` regardless of runtime (so a non-string is never silently ignored),
 * normalizing empty/whitespace to "absent" for the neutral default.
 */
function optionalDockerImage(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ParamError("invalid_param", "docker_image must be a string");
  if (value.includes("\0")) throw new ParamError("invalid_param", "docker_image must not contain NUL");
  return value.trim() === "" ? null : value.trim();
}

function mountPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ParamError("invalid_param", `${name} must be a non-empty absolute path`);
  }
  const path = value.trim();
  if (!path.startsWith("/")) {
    throw new ParamError("invalid_param", `${name} must be an absolute path`);
  }
  if (path.includes("\0") || path.includes(",") || /[\t\r\n]/.test(path)) {
    throw new ParamError("invalid_param", `${name} must not contain NUL, a comma, tab, or newline`);
  }
  return path;
}

/**
 * Parse one bind-mount list. The shape/type is validated for every runtime so a malformed value is
 * rejected rather than silently ignored; duplicate targets inside a single list are rejected here,
 * and duplicate targets across the `login_dirs`/`mounts` merge are rejected by the caller.
 */
function parseMountList(value: unknown, name: string): DockerMountSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ParamError("invalid_param", `${name} must be a list of mount objects`);
  if (value.length > MAX_DOCKER_MOUNTS) {
    throw new ParamError("invalid_param", `${name} accepts at most ${MAX_DOCKER_MOUNTS} entries`);
  }
  const mounts: DockerMountSpec[] = [];
  const targets = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) throw new ParamError("invalid_param", `${name}[${index}] must be an object`);
    const unknown = Object.keys(item).filter((key) => !["source", "target", "read_only"].includes(key));
    if (unknown.length > 0) {
      throw new ParamError("invalid_param", `${name}[${index}] has unsupported keys: ${unknown.sort().join(", ")}`);
    }
    const source = mountPath(item.source, `${name}[${index}].source`);
    const target = mountPath(item.target, `${name}[${index}].target`);
    const readOnly = item.read_only ?? false;
    if (typeof readOnly !== "boolean") {
      throw new ParamError("invalid_param", `${name}[${index}].read_only must be boolean`);
    }
    if (targets.has(target)) {
      throw new ParamError("invalid_param", `${name}[${index}].target duplicates another mount target`);
    }
    targets.add(target);
    mounts.push({ source, target, read_only: readOnly });
  });
  return mounts;
}

/** Merge `login_dirs` + `mounts` for a new Docker container: unique targets, bounded total. */
function mergeDockerMounts(loginDirs: DockerMountSpec[], mounts: DockerMountSpec[]): DockerMountSpec[] {
  const merged = [...loginDirs, ...mounts];
  if (merged.length > MAX_DOCKER_MOUNTS) {
    throw new ParamError("invalid_param", `login_dirs and mounts together accept at most ${MAX_DOCKER_MOUNTS} entries`);
  }
  const targets = new Set<string>();
  for (const mount of merged) {
    if (targets.has(mount.target)) {
      throw new ParamError("invalid_param", `mount target duplicates another mount target: ${mount.target}`);
    }
    targets.add(mount.target);
  }
  return merged;
}

function portNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ParamError("invalid_param", `${name} must be an integer between 1 and 65535`);
  }
  return value;
}

/** IPv4/IPv6 literal check without a dependency. */
export function isIpAddress(value: string): boolean {
  if (!value.includes(":")) {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  const groups = value.split("::");
  if (groups.length > 2) return false;
  const expand = (text: string): string[] => (text.length === 0 ? [] : text.split(":"));
  const head = expand(groups[0] ?? "");
  const tail = expand(groups[1] ?? "");
  const all = [...head, ...tail];
  if (all.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  const total = head.length + tail.length;
  return groups.length === 2 ? total <= 7 : total === 8;
}

function parseDockerPorts(value: unknown): DockerPortSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ParamError("invalid_param", "ports must be a list of port objects");
  if (value.length > MAX_DOCKER_PORTS) {
    throw new ParamError("invalid_param", `ports accepts at most ${MAX_DOCKER_PORTS} entries`);
  }
  const ports: DockerPortSpec[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) throw new ParamError("invalid_param", `ports[${index}] must be an object`);
    const unknown = Object.keys(item).filter(
      (key) => !["host_ip", "host_port", "container_port", "protocol"].includes(key),
    );
    if (unknown.length > 0) {
      throw new ParamError("invalid_param", `ports[${index}] has unsupported keys: ${unknown.sort().join(", ")}`);
    }
    const hostPort = portNumber(item.host_port, `ports[${index}].host_port`);
    const containerPort = portNumber(item.container_port, `ports[${index}].container_port`);
    const protocol = item.protocol ?? "tcp";
    if (protocol !== "tcp" && protocol !== "udp") {
      throw new ParamError("invalid_param", `ports[${index}].protocol must be tcp or udp`);
    }
    const hostIpRaw = item.host_ip;
    let hostIp: string | null = null;
    if (hostIpRaw !== undefined && hostIpRaw !== null) {
      if (typeof hostIpRaw !== "string" || !isIpAddress(hostIpRaw)) {
        throw new ParamError(
          "invalid_param",
          `ports[${index}].host_ip must be a valid IPv4 or IPv6 address`,
        );
      }
      hostIp = hostIpRaw;
    }
    ports.push({ host_port: hostPort, container_port: containerPort, protocol, host_ip: hostIp });
  });
  return ports;
}

function parseDockerId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DOCKER_ID_RE.test(value)) {
    throw new ParamError("invalid_param", "docker_id must be a full 64-character Docker container ID");
  }
  return value;
}

/**
 * Validate and normalize `create_session` parameters.
 *
 * Every Docker field is type-checked for every runtime, so an illegal string/object is rejected
 * instead of being silently ignored when `runtime=direct`; only *effective* values (a non-empty
 * mount/port list, a present image/id/policy, `host_network: true`) require `runtime=docker` —
 * neutral defaults (`[]`/`null`/`false`) stay legal so an expanded template can be passed verbatim.
 */
export function normalizeCreateParams(params: Record<string, unknown>): CreateSessionParams {
  assertAllowedKeys(params, ALLOWED_KEYS);

  const harness = optionalString(params, "harness");
  if (harness !== null && !isBuiltinHarness(harness)) {
    throw new ParamError("invalid_param", `harness must be one of: codebuddy, agy, codex (received ${harness})`);
  }
  const command = normalizeCommand(params.command);
  const args = normalizeArgs(params.args);
  const env = normalizeEnv(params.env);
  // Reuse the adapter's launch-argv safety rule (managed flags / detaching arguments) so a caller
  // cannot override `--acp`/`--model`/… or detach the harness from its managed process group.
  try {
    assertLaunchArgs(harness, args);
  } catch (error) {
    throw new ParamError("invalid_param", error instanceof Error ? error.message : String(error));
  }
  const target = oneOf(params.target, "target", ["local", "remote"] as const) ?? "local";
  const runtime = oneOf(params.runtime, "runtime", ["direct", "docker"] as const) ?? "direct";
  const containerPolicy = oneOf(params.container_policy, "container_policy", ["remove", "keep"] as const);
  const dockerId = parseDockerId(params.docker_id);
  const dockerImageInput = optionalDockerImage(params.docker_image);
  const loginDirs = parseMountList(params.login_dirs, "login_dirs");
  const mounts = parseMountList(params.mounts, "mounts");
  const ports = parseDockerPorts(params.ports);

  const rawHostNetwork = params.host_network;
  if (rawHostNetwork !== undefined && typeof rawHostNetwork !== "boolean") {
    throw new ParamError("invalid_param", "host_network must be boolean");
  }
  const hostNetworkRequested = rawHostNetwork === true;

  const effective: Record<string, boolean> = {
    container_policy: containerPolicy !== null,
    docker_id: dockerId !== null,
    docker_image: dockerImageInput !== null,
    host_network: hostNetworkRequested,
    login_dirs: loginDirs.length > 0,
    mounts: mounts.length > 0,
    ports: ports.length > 0,
  };

  if (runtime === "direct") {
    const present = DOCKER_ONLY.filter((name) => effective[name]);
    if (present.length > 0) {
      throw new ParamError("invalid_param", `container options require runtime=docker: ${present.join(", ")}`);
    }
  }

  let dockerImage: string | null = null;
  let dockerMounts: DockerMountSpec[] = [];
  let dockerPorts: DockerPortSpec[] = [];
  let dockerHostNetwork = false;
  if (runtime === "docker") {
    if (dockerId !== null) {
      // A reused container already fixes its image, mounts, ports, and network.
      const conflicting = ["docker_image", "login_dirs", "mounts", "ports", "host_network"].filter((name) => effective[name]);
      if (conflicting.length > 0) {
        throw new ParamError(
          "invalid_param",
          "a reused container (docker_id) already fixes its image, mounts, ports, and network; " +
            `remove ${conflicting.join(", ")}`,
        );
      }
    } else {
      dockerImage = dockerImageValue(dockerImageInput);
      dockerMounts = mergeDockerMounts(loginDirs, mounts);
      dockerPorts = ports;
      dockerHostNetwork = hostNetworkRequested;
      if (dockerHostNetwork && dockerPorts.length > 0) {
        throw new ParamError("invalid_param", "host_network cannot be combined with published ports");
      }
    }
  }

  const permissionMode = oneOf(params.permission_mode, "permission_mode", PERMISSION_MODES) ?? "auto";

  const remoteHost = optionalString(params, "remote_host");
  if (target === "remote" && remoteHost === null) {
    throw new ParamError("invalid_param", "remote_host is required for a remote target");
  }
  if (target === "local" && remoteHost !== null) {
    throw new ParamError("invalid_param", "remote_host is only valid for a remote target");
  }

  const modelId = requiredString(params, "model_id");
  const cwd = requiredString(params, "cwd");
  if (runtime === "docker" && !cwd.startsWith("/")) {
    // For Docker, cwd is the path *inside the container* (used as the exec working
    // directory), never a host bind mount.
    throw new ParamError("invalid_param", "cwd must be an absolute container path when runtime=docker");
  }

  return {
    harness,
    command,
    args,
    env,
    cwd,
    modelId,
    thinkingLevel: optionalString(params, "thinking_level"),
    permissionMode,
    target,
    remoteHost,
    runtime,
    dockerId,
    dockerImage,
    dockerMounts,
    dockerPorts,
    dockerHostNetwork,
    containerPolicy: containerPolicy ?? (dockerId ? "keep" : "remove"),
    resumeSessionId: optionalString(params, "resume_session_id"),
    sessionId: optionalString(params, "session_id"),
  };
}
