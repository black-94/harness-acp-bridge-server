#!/usr/bin/env node
// Thin CLI for the same daemon IPC used by the ACP tools. No direct harness RPC.
// Requires an already running bridge daemon. Override the two paths for other hosts.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bridgeDir = process.env.BRIDGE_DIR || '/Users/black94/project/harness-acp-bridge-server';
const configPath = process.env.BRIDGE_CONFIG || '/Users/black94/.config/harness-acp-bridge/config.yaml';
const { loadConfig } = await import(pathToFileURL(join(bridgeDir, 'dist/config.js')).href);
const { DaemonClient } = await import(pathToFileURL(join(bridgeDir, 'dist/ipc.js')).href);
const method = process.argv[2];
if (!method) {
    console.error('Usage: node bridge-call.mjs METHOD JSON_PARAMS');
    process.exit(2);
}
const params = JSON.parse(process.argv[3] || '{}');
// Wrapper-only option: read a prompt without shell escaping its entire contents.
if (method === 'send_message' && params.prompt_file) {
    params.text = readFileSync(resolve(params.prompt_file), 'utf8');
    delete params.prompt_file;
}
const config = loadConfig(configPath);
const client = new DaemonClient({
    socketPath: config.server.socketPath,
    lockPath: config.server.lockPath,
    configPath,
    autoStart: false,
});
const timeoutMs = method === 'authenticate'
    ? config.authentication.timeoutSeconds * 1000 + 15000
    : method === 'create_session' ? 120000 : 60000;
try {
    const result = await client.call(method, params, { timeoutMs, autoStart: false });
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(JSON.stringify({ status: 'error', code: error.code, message: error.message }));
    process.exitCode = 1;
}
