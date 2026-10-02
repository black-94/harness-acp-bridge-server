#!/usr/bin/env node
/**
 * Mock `ssh` CLI for integration tests.
 *
 * Invoked as `ssh -- <host> <command>`. Records the invocation in `$MOCK_SSH_LOG` and runs
 * the remote command string through `/bin/sh -c` locally, with inherited stdio. That makes
 * the generated remote wrapper genuinely execute: `set -m`, the pid file, the EXIT trap, and
 * the process-group kill all run for real, without any network or real SSH account.
 *
 * `missing-host` fails like an unreachable host so failure paths can be tested.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const host = separator >= 0 ? argv[separator + 1] : undefined;
const command = separator >= 0 ? argv[separator + 2] : argv[1];

const logPath = process.env.MOCK_SSH_LOG;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ host, command })}\n`);
}

if (!command) {
  process.stderr.write("mock-ssh: missing remote command\n");
  process.exit(255);
}
if (host === "missing-host") {
  process.stderr.write("ssh: Could not resolve hostname missing-host\n");
  process.exit(255);
}

const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on("error", (error) => {
  process.stderr.write(`mock-ssh: ${error.message}\n`);
  process.exit(255);
});
