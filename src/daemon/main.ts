#!/usr/bin/env node
/**
 * Daemon entrypoint.
 *
 * Usage: harness-acp-bridge-daemon [--config <path>]
 *
 * Starts the Unix-socket daemon, then exits on SIGTERM/SIGINT after closing every session.
 * The MCP stdio client auto-starts this process when the socket is missing.
 */
import { configArgument, loadConfig, resolveConfigPath } from "../config.js";
import { HarnessDaemon } from "./server.js";

async function main(): Promise<void> {
  const explicit = configArgument(process.argv.slice(2));
  const config = loadConfig(explicit);
  const configPath = resolveConfigPath(explicit);
  const daemon = new HarnessDaemon({ config, configPath });
  await daemon.start();

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`harness-acp-bridge daemon: received ${signal}, shutting down\n`);
    // Never hang on shutdown: session cleanup is best effort and bounded.
    setTimeout(() => process.exit(0), 5000).unref();
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`harness-acp-bridge daemon failed to start: ${message}\n`);
  process.exit(1);
});
