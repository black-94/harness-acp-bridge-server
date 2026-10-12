#!/usr/bin/env node
/** `hacpd` entrypoint. Configuration comes from HARNESS_ACP_BRIDGE_CONFIG or defaults. */
import { loadConfig } from "./logic/config.js";
import { HarnessHttpServer } from "./http/server.js";
import { errorInfo } from "./logic/errors.js";

/** Report a startup/shutdown failure the same way every other error leaves the bridge. */
function report(error: unknown): void {
  process.stderr.write(`${JSON.stringify(errorInfo(error))}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const server = new HarnessHttpServer(loadConfig());
  let stopping = false;
  const stop = (): void => {
    if (stopping) return; stopping = true;
    void server.stop().then(() => { process.exitCode = 0; }).catch(report);
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const address = await server.start();
  process.stderr.write(`HTTP server listening at ${address.host}:${address.port}\n`);
}

main().catch(report);
