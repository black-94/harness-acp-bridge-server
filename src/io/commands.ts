/** Executable resolution is performed on the actual local/SSH/container target. */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { BridgeError } from "../logic/errors.js";
import { containerControlArgv, runControl, shellJoin, type LaunchSpec } from "./runtime.js";

export function resolveLocalCommand(command: string, env: Record<string, string> = {}, cwd = process.cwd()): string {
  const candidates = command.includes("/") ? [resolve(cwd, command)] :
    (env.PATH ?? process.env.PATH ?? "").split(delimiter).map(directory => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. Explicit paths never fall back. */ }
  }
  throw new BridgeError("command_not_found", `harness executable is missing or not executable: ${command}`);
}

export async function resolveTargetCommand(spec: LaunchSpec, signal?: AbortSignal): Promise<string> {
  const command = spec.argv[0]!;
  if (spec.launchMode === "local" && !spec.dockerContainerName) return resolveLocalCommand(command, spec.harnessEnv, spec.cwd);
  // A positional argument, not interpolated shell code. Explicit paths are checked in place;
  // bare names are resolved using the target's PATH. Never invoke the candidate in this probe.
  const script = 'p=$(command -v "$1") || exit 127; [ -f "$p" ] && [ -x "$p" ] || exit 127; printf "%s\\n" "$p"';
  const probe = ["/bin/sh", "-c", script, "harness-command-check", command];
  let argv: string[];
  if (spec.dockerContainerName) {
    const args = ["exec", "--workdir", spec.cwd];
    for (const [key, value] of Object.entries(spec.harnessEnv)) args.push("--env", `${key}=${value}`);
    argv = containerControlArgv(spec, [...args, spec.dockerContainerName, ...probe]);
  } else {
    const env = Object.entries(spec.harnessEnv).map(([key, value]) => `${key}=${value}`);
    const remote = `cd ${shellJoin([spec.cwd])} && ${shellJoin(["env", ...env, ...probe])}`;
    argv = [spec.sshCommand, "--", spec.sshHost!, remote];
  }
  const result = await runControl({ argv, env: {}, cwd: null }, spec.startupTimeoutSeconds * 1000, signal);
  if (result.aborted) throw new BridgeError("request_aborted", "harness command check aborted");
  if (result.timedOut) throw new BridgeError("command_check_timeout", "harness command check timed out");
  const path = result.stdout.trim();
  if (result.code !== 0 || !path || path.includes("\n")) {
    throw new BridgeError("command_not_found", `harness executable is unavailable on the execution target: ${command}`);
  }
  // command -v may return a relative PATH entry; the launch runs in this same directory.
  return path;
}
