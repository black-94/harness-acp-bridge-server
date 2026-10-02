/**
 * Launch runtime: local / remote (SSH) / Docker, and process-group supervision.
 *
 * Ports `harness_acp_mcp/supervisor.py`. The reference runs these steps in a separate
 * supervisor process; here the daemon's session owns the same lifecycle directly, which
 * keeps the semantics (prepare -> run -> policy cleanup, remote pid file, metadata echo)
 * while removing a process hop:
 *
 *   prepareContainer   docker run (new) or docker start (reuse), bounded by a timeout
 *   ensureWorkdir      docker exec mkdir -p <container cwd>, best effort
 *   buildTransportArgv the argv the ACP transport spawns: the harness directly, wrapped in
 *                      `docker exec --workdir`, or wrapped in an SSH shell that records a
 *                      remote pid file and kills the remote process group on exit
 *   cleanup            container stop/remove per policy, and remote pid-file cleanup
 *
 * Every value is a discrete argv element; nothing is interpolated into a shell string
 * except the deliberate remote wrapper (which is single-quoted via `shellQuote`).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type CleanupAction = "policy" | "force_remove" | "skip";

export interface DockerMountSpec {
  source: string;
  target: string;
  read_only: boolean;
}

export interface DockerPortSpec {
  host_port: number;
  container_port: number;
  protocol: "tcp" | "udp";
  host_ip: string | null;
}

export interface LaunchSpec {
  launchMode: "local" | "ssh";
  sshHost: string | null;
  sshCommand: string;
  dockerCommand: string;
  /** Working directory: a host path for direct, a container path for docker. */
  cwd: string;
  /** Harness argv (program + adapter arguments). */
  argv: string[];
  harnessEnv: Record<string, string>;
  dockerImage: string | null;
  dockerContainerName: string | null;
  dockerId: string | null;
  dockerMounts: DockerMountSpec[];
  dockerPorts: DockerPortSpec[];
  dockerHostNetwork: boolean;
  containerPolicy: "remove" | "keep";
  reuseContainer: boolean;
  remotePidFile: string | null;
  startupTimeoutSeconds: number;
  terminateGraceSeconds: number;
  remoteCleanupTimeoutSeconds: number;
}

export interface ControlSpec {
  argv: string[];
  env: Record<string, string>;
  cwd: string | null;
}

/** Environment variable carrying the JSON supervisor spec to `src/supervisor.ts`. */
export const SUPERVISOR_SPEC_ENV = "HARNESS_ACP_SUPERVISOR_SPEC";

/**
 * Everything one per-session supervisor needs, as JSON.
 *
 * The supervisor owns container preparation, the harness process group, and cleanup, so the
 * daemon only has to describe the launch.
 */
export interface SupervisorSpec extends LaunchSpec {
  /** Private file the supervisor writes its pids/container id to (mode 0600). */
  metadataPath: string;
  /** Pid of the daemon; once it is gone the supervisor cleans up and exits. */
  daemonPid: number;
}

/** Pids and container facts the supervisor reports back to the daemon. */
export interface SupervisorMetadata {
  supervisor_pid: number;
  transport_pid: number | null;
  transport_pgid: number | null;
  remote_pid_file: string | null;
  docker_id: string | null;
  started_at: string;
}

export interface ContainerInspection {
  image: string;
  mounts: DockerMountSpec[];
  ports: DockerPortSpec[];
  hostNetwork: boolean;
}

export interface TransportTarget {
  argv: string[];
  /** `null` means "inherit", which is required for container/remote launches. */
  cwd: string | null;
  env: Record<string, string>;
}

const DOCKER_ID_RE = /^[0-9a-f]{64}$/;
const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const INSPECT_FORMAT =
  '{"id":{{json .Id}},"image":{{json .Config.Image}},"image_id":{{json .Image}},' +
  '"network_mode":{{json .HostConfig.NetworkMode}},' +
  '"port_bindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}';

export function isDockerId(value: unknown): value is string {
  return typeof value === "string" && DOCKER_ID_RE.test(value);
}

/** Python `shlex.quote` equivalent. */
export function shellQuote(value: string): string {
  if (value.length > 0 && SAFE_SHELL_WORD.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Python `shlex.join` equivalent. */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function newRemotePidFile(): string {
  return `harness-acp-${randomUUID().replace(/-/g, "")}.pid`;
}

/** Wrap a docker control command in SSH when the target is remote. */
export function containerControlArgv(spec: LaunchSpec, args: string[]): string[] {
  const command = [spec.dockerCommand, ...args];
  if (spec.launchMode === "ssh") {
    return [spec.sshCommand, "--", spec.sshHost as string, shellJoin(command)];
  }
  return command;
}

export function containerCleanupArgs(spec: LaunchSpec, action: CleanupAction = "policy"): string[] {
  const name = spec.dockerContainerName as string;
  if (action === "force_remove") return ["rm", "-f", name];
  if (action === "skip") return [];
  return spec.containerPolicy === "keep" ? ["stop", "-t", "0", name] : ["rm", "-f", name];
}

/**
 * Which cleanup to apply when the session ends.
 *
 * If container preparation never completed, a reused container was never entered and must
 * be left exactly as the caller supplied it; a container this session tried to create may
 * be half-created and is force-removed.
 */
export function containerAction(preparedOk: boolean, reuseContainer: boolean): CleanupAction {
  if (preparedOk) return "policy";
  return reuseContainer ? "skip" : "force_remove";
}

/** `docker run` arguments from validated options; `cwd` is never bind-mounted. */
export function dockerRunArgs(spec: LaunchSpec): string[] {
  const args = ["run", "--detach", "--init", "--name", spec.dockerContainerName as string];
  for (const mount of spec.dockerMounts) {
    let option = `type=bind,src=${mount.source},dst=${mount.target}`;
    if (mount.read_only) option += ",readonly";
    args.push("--mount", option);
  }
  for (const port of spec.dockerPorts) {
    let bind = "";
    if (port.host_ip) {
      // Docker requires IPv6 bind addresses to be bracketed: [addr]:host:container.
      bind = port.host_ip.includes(":") ? `[${port.host_ip}]:` : `${port.host_ip}:`;
    }
    args.push("-p", `${bind}${port.host_port}:${port.container_port}/${port.protocol}`);
  }
  if (spec.dockerHostNetwork) args.push("--network", "host");
  args.push("--entrypoint", "/bin/sh", spec.dockerImage as string, "-c", "while :; do sleep 3600; done");
  return args;
}

/**
 * The harness argv as carried inside the container.
 *
 * For Docker the harness runs in the container via `docker exec -i --workdir`, and this is
 * then either spawned directly (local) or wrapped by the SSH remote command (remote), so the
 * container is entered on the remote host rather than on ours.
 */
export function dockerExecArgv(spec: LaunchSpec): string[] {
  if (!spec.dockerContainerName) return spec.argv;
  return [
    spec.dockerCommand,
    "exec",
    "-i",
    "--workdir",
    spec.cwd,
    spec.dockerContainerName,
    ...spec.argv,
  ];
}

/**
 * The remote shell wrapper: run the harness in the background, record its pid/pgid, and kill
 * the whole remote process group (plus the container) on exit.
 *
 * For Docker the `cwd` is a container path and the harness enters the container via
 * `docker exec --workdir`, so the wrapper must not `cd` to it on the host.
 */
export function remoteCommand(spec: LaunchSpec, program: string[] = dockerExecArgv(spec)): string {
  const programParts: string[] = [];
  const remoteEnv = spec.harnessEnv ?? {};
  if (Object.keys(remoteEnv).length > 0) {
    programParts.push("env", ...Object.entries(remoteEnv).map(([key, value]) => `${key}=${value}`));
  }
  programParts.push(...program);
  const programText = shellJoin(programParts);
  const pidFile = shellQuote(spec.remotePidFile as string);
  const grace = spec.terminateGraceSeconds;
  let dockerCleanup = "";
  if (spec.dockerContainerName) {
    dockerCleanup = `${shellJoin([spec.dockerCommand, ...containerCleanupArgs(spec)])} >/dev/null 2>&1 || true; `;
  }
  const cleanup =
    'if [ -n "$harness_pgid" ]; then ' +
    'kill -TERM -"$harness_pgid" 2>/dev/null || true; ' +
    `sleep ${grace}; ` +
    'kill -KILL -"$harness_pgid" 2>/dev/null || true; ' +
    "fi; " +
    dockerCleanup +
    'rm -f "$pid_file"';

  const preamble: string[] = [];
  if (!spec.dockerContainerName) preamble.push(`cd ${shellQuote(spec.cwd)} || exit 1`);

  return [
    ...preamble,
    "umask 077",
    'remote_tmp="${TMPDIR:-/tmp}"',
    `pid_file="$remote_tmp"/${pidFile}`,
    "harness_pid=''",
    "harness_pgid=''",
    `trap ${shellQuote(cleanup)} EXIT`,
    "trap 'exit 143' HUP TERM INT",
    "set -m || exit 1",
    `${programText} &`,
    "harness_pid=$!",
    'harness_pgid=$(ps -o pgid= -p "$harness_pid" 2>/dev/null | tr -d " ")',
    // With job control, this single-command job leads its own process group. Some
    // restricted hosts deny ps even for a process we just launched.
    'if [ -z "$harness_pgid" ]; then harness_pgid="$harness_pid"; fi',
    'case "$harness_pgid" in ""|*[!0-9]*) exit 1 ;; esac',
    'printf "%s %s\\n" "$harness_pid" "$harness_pgid" > "$pid_file"',
    'wait "$harness_pid"',
  ].join("\n");
}

/** Remote cleanup: kill the recorded process group, remove the pid file, drop the container. */
export function remoteCleanupCommand(spec: LaunchSpec, action: CleanupAction = "policy"): string {
  const pidName = shellQuote(spec.remotePidFile as string);
  const grace = spec.terminateGraceSeconds;
  let dockerCleanup = "";
  if (action !== "skip" && spec.dockerContainerName) {
    dockerCleanup = `${shellJoin([spec.dockerCommand, ...containerCleanupArgs(spec, action)])} >/dev/null 2>&1 || true; `;
  }
  return (
    'remote_tmp="${TMPDIR:-/tmp}"; ' +
    `pid_file="$remote_tmp"/${pidName}; ` +
    'if [ -r "$pid_file" ]; then ' +
    'read harness_pid harness_pgid < "$pid_file"; ' +
    'case "$harness_pgid" in ""|*[!0-9]*) harness_pgid="" ;; esac; ' +
    'if [ -n "$harness_pgid" ]; then ' +
    'kill -TERM -"$harness_pgid" 2>/dev/null || true; ' +
    `sleep ${grace}; ` +
    'kill -KILL -"$harness_pgid" 2>/dev/null || true; ' +
    'fi; rm -f "$pid_file"; fi; ' +
    dockerCleanup
  );
}

/** Build the argv/cwd/env the ACP transport should spawn. */
export function buildTransportTarget(spec: LaunchSpec): TransportTarget {
  const env = { ...spec.harnessEnv };
  const program = dockerExecArgv(spec);
  if (spec.launchMode === "ssh") {
    return {
      argv: [spec.sshCommand, "--", spec.sshHost as string, remoteCommand(spec, program)],
      cwd: null,
      env,
    };
  }
  // A Docker harness enters the container, so the local supervisor must not chdir to a
  // container path.
  return { argv: program, cwd: spec.dockerContainerName ? null : spec.cwd, env };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Run a control command (local or SSH-wrapped), bounded by a timeout and abortable. */
export async function runControl(
  control: ControlSpec,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(control.argv[0] as string, control.argv.slice(1), {
      cwd: control.cwd ?? undefined,
      env: { ...process.env, ...control.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const killGroup = (signalName: NodeJS.Signals): void => {
      const pid = child.pid;
      if (process.platform !== "win32" && typeof pid === "number") {
        try {
          process.kill(-pid, signalName);
          return;
        } catch {
          // Fall through to a direct kill.
        }
      }
      try {
        child.kill(signalName);
      } catch {
        // Already gone.
      }
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: child.exitCode, stdout, stderr, timedOut, aborted });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const onAbort = (): void => {
      aborted = true;
      killGroup("SIGKILL");
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += String(error.message);
      finish();
    });
    child.on("close", () => finish());
  });
}

/** Prepare a Docker container (create or reuse) and return its full container id. */
export async function prepareContainer(spec: LaunchSpec, signal?: AbortSignal): Promise<string> {
  const name = spec.dockerContainerName as string;
  const args = spec.reuseContainer ? ["start", name] : dockerRunArgs(spec);
  const result = await runControl(
    { argv: containerControlArgv(spec, args), env: {}, cwd: null },
    spec.startupTimeoutSeconds * 1000,
    signal,
  );
  if (result.timedOut) throw new Error("failed to prepare Docker container: timed out");
  if (result.code !== 0) {
    throw new Error(`failed to prepare Docker container: ${result.stderr.trim().slice(-500)}`);
  }
  const dockerId = spec.reuseContainer ? spec.dockerId : result.stdout.trim();
  if (!isDockerId(dockerId)) throw new Error("Docker did not return a full container ID");
  return dockerId;
}

/** Create the container working directory (inside the container only, best effort). */
export async function ensureContainerWorkdir(spec: LaunchSpec, signal?: AbortSignal): Promise<void> {
  if (!spec.dockerContainerName) return;
  await runControl(
    { argv: containerControlArgv(spec, ["exec", spec.dockerContainerName, "mkdir", "-p", spec.cwd]), env: {}, cwd: null },
    spec.startupTimeoutSeconds * 1000,
    signal,
  ).catch(() => undefined);
}

export async function cleanupContainer(spec: LaunchSpec, action: CleanupAction): Promise<void> {
  if (action === "skip" || !spec.dockerContainerName) return;
  const args = containerCleanupArgs(spec, action);
  if (args.length === 0) return;
  await runControl(
    { argv: containerControlArgv(spec, args), env: {}, cwd: null },
    spec.remoteCleanupTimeoutSeconds * 1000,
  ).catch(() => undefined);
}

export async function cleanupRemote(spec: LaunchSpec, action: CleanupAction): Promise<void> {
  const argv = [spec.sshCommand, "--", spec.sshHost as string, remoteCleanupCommand(spec, action)];
  await runControl(
    { argv, env: {}, cwd: null },
    spec.remoteCleanupTimeoutSeconds * 1000,
  ).catch(() => undefined);
}

/** Read back a retained container's real configuration for `launch_info`. */
export async function inspectContainer(
  spec: LaunchSpec,
  timeoutMs: number,
): Promise<ContainerInspection> {
  const result = await runControl(
    {
      argv: containerControlArgv(spec, [
        "inspect",
        "--type",
        "container",
        "--format",
        INSPECT_FORMAT,
        spec.dockerId as string,
      ]),
      env: {},
      cwd: null,
    },
    timeoutMs,
  );
  if (result.timedOut) throw new Error("Docker container inspection timed out");
  if (result.code !== 0) {
    throw new Error(
      `Docker container does not exist or is unavailable: ${result.stderr.trim().slice(-300)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Docker container inspection returned malformed data");
  }
  if (!isRecord(data) || data.id !== spec.dockerId) {
    throw new Error("Docker container does not exist or is unavailable");
  }
  return {
    image: inspectImage(data),
    mounts: inspectMounts(data.mounts),
    ports: inspectPorts(data.port_bindings),
    hostNetwork: data.network_mode === "host",
  };
}

function inspectImage(data: Record<string, unknown>): string {
  const reference = data.image;
  if (typeof reference === "string" && reference.trim()) return reference.trim();
  const imageId = data.image_id;
  if (typeof imageId === "string" && imageId.trim()) return imageId.trim();
  throw new Error("Docker container inspection did not report an image");
}

function inspectReadOnly(item: Record<string, unknown>): boolean {
  if (typeof item.RW === "boolean") return !item.RW;
  const mode = item.Mode;
  return typeof mode === "string" && mode.split(",").includes("ro");
}

function inspectMounts(raw: unknown): DockerMountSpec[] {
  // Named volumes and tmpfs are skipped: the `mounts` option is bind-only, so representing
  // them in the same {source,target,read_only} shape would be wrong.
  if (!Array.isArray(raw)) return [];
  const mounts: DockerMountSpec[] = [];
  for (const item of raw) {
    if (!isRecord(item) || item.Type !== "bind") continue;
    const source = item.Source;
    const target = item.Destination;
    if (typeof source !== "string" || !source.trim()) continue;
    if (typeof target !== "string" || !target.trim()) continue;
    mounts.push({ source: source.trim(), target: target.trim(), read_only: inspectReadOnly(item) });
  }
  return mounts;
}

function inspectPorts(raw: unknown): DockerPortSpec[] {
  if (!isRecord(raw)) return [];
  const ports: DockerPortSpec[] = [];
  for (const [key, bindings] of Object.entries(raw)) {
    const slash = key.lastIndexOf("/");
    if (slash < 0) continue;
    const containerText = key.slice(0, slash);
    const protocol = key.slice(slash + 1);
    if (protocol !== "tcp" && protocol !== "udp") continue;
    if (!/^\d+$/.test(containerText)) continue;
    const containerPort = Number.parseInt(containerText, 10);
    if (!(containerPort >= 1 && containerPort <= 65535) || !Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (!isRecord(binding)) continue;
      const hostText = binding.HostPort;
      if (typeof hostText !== "string" || !/^\d+$/.test(hostText)) continue;
      const hostPort = Number(hostText);
      if (!(hostPort >= 1 && hostPort <= 65535)) continue;
      const hostIp = typeof binding.HostIp === "string" ? binding.HostIp.trim() : "";
      ports.push({
        host_port: hostPort,
        container_port: containerPort,
        protocol,
        host_ip: hostIp || null,
      });
    }
  }
  ports.sort(
    (a, b) =>
      a.container_port - b.container_port ||
      a.protocol.localeCompare(b.protocol) ||
      a.host_port - b.host_port ||
      (a.host_ip ?? "").localeCompare(b.host_ip ?? ""),
  );
  return ports;
}
