/**
 * `create_session` parameter validation. Port of `daemon.py:_session_config`.
 *
 * A caller can choose *where* and *how* a harness runs (local/remote, direct/docker, and
 * explicit Docker options) but can never inject launch internals: the command, its
 * arguments, the environment, the SSH program, or any directory the bridge writes to. Those
 * come from the configuration file only.
 */
import { isBuiltinHarness, type ContainerPolicy, type PermissionMode, type Runtime } from "./adapters.js";
import type { DockerMountSpec, DockerPortSpec } from "./runtime.js";

export class ParamError extends Error {
  override name = "ParamError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Keys a caller must never supply; they are owned by the configuration file. */
export const LAUNCH_INTERNALS: ReadonlySet<string> = new Set([
  "command",
  "args",
  "env",
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
  "cwd",
  "model_id",
  "thinking_level",
  "permission_mode",
  "resume_session_id",
  "authenticate",
  "session_id",
  "target",
  "remote_host",
  "runtime",
  "container_policy",
  "docker_id",
  "docker_image",
  "mounts",
  "ports",
  "host_network",
] as const;

const DOCKER_ONLY = ["container_policy", "docker_id", "docker_image", "host_network", "mounts", "ports"];
const DOCKER_ID_RE = /^[0-9a-f]{64}$/;
const MAX_DOCKER_MOUNTS = 64;
const MAX_DOCKER_PORTS = 64;
const PERMISSION_MODES: readonly PermissionMode[] = ["read", "edit", "auto", "yolo"];

export interface CreateSessionParams {
  harness: string | null;
  cwd: string;
  modelId: string;
  thinkingLevel: string | null;
  permissionMode: PermissionMode;
  target: "local" | "remote";
  remoteHost: string | null;
  runtime: Runtime;
  dockerId: string | null;
  dockerImage: string | null;
  dockerMounts: DockerMountSpec[];
  dockerPorts: DockerPortSpec[];
  dockerHostNetwork: boolean;
  containerPolicy: ContainerPolicy;
  resumeSessionId: string | null;
  authenticate: string | null;
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
  return value.trim();
}

function optionalString(params: Record<string, unknown>, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new ParamError("invalid_param", `${name} must be a non-empty string`);
  }
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

function mountPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ParamError("invalid_param", `${name} must be a non-empty absolute path`);
  }
  const path = value.trim();
  if (!path.startsWith("/")) {
    throw new ParamError("invalid_param", `${name} must be an absolute path`);
  }
  if (path.includes(",") || /[\t\r\n]/.test(path)) {
    throw new ParamError("invalid_param", `${name} must not contain a comma, tab, or newline`);
  }
  return path;
}

function parseDockerMounts(value: unknown): DockerMountSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ParamError("invalid_param", "mounts must be a list of mount objects");
  if (value.length > MAX_DOCKER_MOUNTS) {
    throw new ParamError("invalid_param", `mounts accepts at most ${MAX_DOCKER_MOUNTS} entries`);
  }
  const mounts: DockerMountSpec[] = [];
  const targets = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) throw new ParamError("invalid_param", `mounts[${index}] must be an object`);
    const unknown = Object.keys(item).filter((key) => !["source", "target", "read_only"].includes(key));
    if (unknown.length > 0) {
      throw new ParamError(
        "invalid_param",
        `mounts[${index}] has unsupported keys: ${unknown.sort().join(", ")}`,
      );
    }
    const source = mountPath(item.source, `mounts[${index}].source`);
    const target = mountPath(item.target, `mounts[${index}].target`);
    const readOnly = item.read_only ?? false;
    if (typeof readOnly !== "boolean") {
      throw new ParamError("invalid_param", `mounts[${index}].read_only must be boolean`);
    }
    if (targets.has(target)) {
      throw new ParamError("invalid_param", `mounts[${index}].target duplicates another mount target`);
    }
    targets.add(target);
    mounts.push({ source, target, read_only: readOnly });
  });
  return mounts;
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

/**
 * Validate and normalize `create_session` parameters.
 *
 * Mirrors the reference rules, including the mutually exclusive combinations: docker-only
 * options require `runtime=docker`; a reused container (`docker_id`) fixes its own image,
 * mounts, ports, and network, so supplying them is rejected instead of silently ignored.
 */
export function normalizeCreateParams(params: Record<string, unknown>): CreateSessionParams {
  assertAllowedKeys(params, ALLOWED_KEYS);

  const harness = optionalString(params, "harness");
  if (harness !== null && !isBuiltinHarness(harness)) {
    throw new ParamError("invalid_param", `harness must be one of: codebuddy, agy, codex (received ${harness})`);
  }
  const target = oneOf(params.target, "target", ["local", "remote"] as const) ?? "local";
  const runtime = oneOf(params.runtime, "runtime", ["direct", "docker"] as const) ?? "direct";
  const containerPolicy = oneOf(params.container_policy, "container_policy", ["remove", "keep"] as const);

  const rawDockerId = params.docker_id;
  let dockerId: string | null = null;
  if (rawDockerId !== undefined && rawDockerId !== null) {
    if (typeof rawDockerId !== "string" || !DOCKER_ID_RE.test(rawDockerId)) {
      throw new ParamError("invalid_param", "docker_id must be a full 64-character Docker container ID");
    }
    dockerId = rawDockerId;
  }

  const rawHostNetwork = params.host_network;
  if (rawHostNetwork !== undefined && typeof rawHostNetwork !== "boolean") {
    throw new ParamError("invalid_param", "host_network must be boolean");
  }
  const hostNetworkRequested = rawHostNetwork === true;

  const dockerOptions: Record<string, boolean> = {
    container_policy: containerPolicy !== null,
    docker_id: dockerId !== null,
    docker_image: params.docker_image !== undefined && params.docker_image !== null,
    host_network: hostNetworkRequested,
    mounts: Array.isArray(params.mounts) && params.mounts.length > 0,
    ports: Array.isArray(params.ports) && params.ports.length > 0,
  };
  if (runtime === "direct") {
    // ``docker_image``, ``mounts``, ``ports``, and ``host_network`` are call-level choices;
    // they are never read from the configuration file.
    const present = DOCKER_ONLY.filter((name) => dockerOptions[name]);
    if (present.length > 0) {
      throw new ParamError(
        "invalid_param",
        `container options require runtime=docker: ${present.join(", ")}`,
      );
    }
  }

  let dockerImage: string | null = null;
  let dockerMounts: DockerMountSpec[] = [];
  let dockerPorts: DockerPortSpec[] = [];
  let dockerHostNetwork = false;
  if (runtime === "docker") {
    if (dockerId !== null) {
      const conflicting = ["docker_image", "mounts", "ports", "host_network"].filter(
        (name) => dockerOptions[name],
      );
      if (conflicting.length > 0) {
        throw new ParamError(
          "invalid_param",
          "a reused container (docker_id) already fixes its image, mounts, ports, and network; " +
            `remove ${conflicting.join(", ")}`,
        );
      }
    } else {
      dockerImage = dockerImageValue(params.docker_image);
      dockerMounts = parseDockerMounts(params.mounts);
      dockerPorts = parseDockerPorts(params.ports);
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
    authenticate: optionalString(params, "authenticate"),
    sessionId: optionalString(params, "session_id"),
  };
}
