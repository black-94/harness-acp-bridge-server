#!/usr/bin/env node
/**
 * Mock `docker` CLI for integration tests.
 *
 * Records every invocation as one JSON line in `$MOCK_DOCKER_LOG` and implements just enough
 * of the docker surface the bridge uses:
 *
 *   run    --detach ...            -> print a 64-hex container id
 *   start  <name>                  -> exit 0
 *   exec   -i --workdir <dir> ...  -> run the remaining argv locally (a stand-in "container")
 *   inspect --format <tpl> <id>    -> print the projected JSON for that container
 *   rm -f <name> | stop -t 0 <name>-> exit 0
 *
 * The `exec` passthrough keeps the ACP conversation real: the harness argv is executed with
 * inherited stdio exactly as `docker exec -i` would attach it.
 */
import { appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const CONTAINER_ID = "a".repeat(64);
const argv = process.argv.slice(2);

function record(extra) {
  const logPath = process.env.MOCK_DOCKER_LOG;
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ argv, ...extra })}\n`);
}

function projected(id) {
  return {
    id,
    image: "mock/image:1",
    image_id: `sha256:${"b".repeat(64)}`,
    network_mode: "host",
    port_bindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] },
    mounts: [{ Type: "bind", Source: "/host/data", Destination: "/data", RW: false }],
  };
}

const command = argv[0];
record({});

if (command === "run") {
  process.stdout.write(`${CONTAINER_ID}\n`);
  process.exit(0);
}

if (command === "start") {
  process.exit(0);
}

if (command === "exec") {
  // Strip the flags the bridge uses, then execute the remainder locally.
  const rest = argv.slice(1);
  while (rest.length > 0) {
    const head = rest[0];
    if (head === "-i" || head === "-t" || head === "--interactive") {
      rest.shift();
      continue;
    }
    if (head === "--workdir") {
      rest.shift();
      rest.shift();
      continue;
    }
    break;
  }
  rest.shift(); // container name
  const [program, ...programArgs] = rest;
  const child = spawn(program, programArgs, { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(127);
  });
} else if (command === "inspect") {
  const id = argv[argv.length - 1];
  if (!/^[0-9a-f]{64}$/.test(id ?? "")) {
    process.stderr.write(`No such object: ${id}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(projected(id))}\n`);
  process.exit(0);
} else if (command === "rm" || command === "stop") {
  process.exit(0);
} else if (command === "mkdir") {
  const result = spawnSync("mkdir", ["-p", ...argv.slice(1)], { stdio: "ignore" });
  process.exit(result.status ?? 0);
} else {
  process.exit(0);
}
