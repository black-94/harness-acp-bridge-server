import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";

const clients: AcpClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeClient(notification?: Record<string, unknown>): AcpClient {
  const dir = mkdtempSync(join(tmpdir(), "hab-auth-notify-"));
  dirs.push(dir);
  const script = `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send(${JSON.stringify(notification ?? { jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind: "none", label: "Not logged in" } } })});
    send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,authMethods:[{id:'test-login'}]}});
  } else if (msg.method === 'authenticate') {
    send({jsonrpc:'2.0',method:'_codebuddy.ai/authUrl',params:{authUrl:'https://example.test/login',provider:'external',apiKey:'secret-test-key'}});
    send({jsonrpc:'2.0',id:msg.id,result:{}});
  } else if (msg.method === 'session/new') {
    send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'test-session'}});
  } else if (msg.method === 'session/prompt') {
    send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP_SMOKE_OK'}}}});
    send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});
  }
});`;
  const client = new AcpClient({ command: process.execPath, cwd: dir, args: ["-e", script], startupTimeoutMs: 5000 });
  clients.push(client);
  return client;
}

describe("ACP authentication notifications", () => {
  it("accepts Codex status and CodeBuddy auth URL notifications without disrupting RPC or turns", async () => {
    const client = makeClient();
    const notifications: unknown[] = [];
    client.on("authNotification", value => notifications.push(value));
    await client.start();
    await client.authenticate("test-login");
    await client.openSession();
    await client.beginTurn("hello");
    expect((await client.waitForTurnEvent(5000)).kind).toBe("complete");
    expect(client.running).toBe(true);
    expect(notifications).toHaveLength(2);
    expect(JSON.stringify(notifications)).not.toContain("secret-test-key");
    expect(JSON.stringify(notifications)).toContain("https://example.test/login");
  });

  it("records CodeBuddy UI command notifications as advisory data without executing actions", async () => {
    const client = makeClient({ jsonrpc: "2.0", method: "_codebuddy.ai/command", params: {
      sessionId: "test-session", action: "workspace_info", params: { isGitWorkspace: false },
    } });
    const notifications: unknown[] = [];
    client.on("vendorNotification", value => notifications.push(value));
    await client.start();
    await client.openSession();
    expect(client.running).toBe(true);
    expect(notifications).toHaveLength(1);
  });

  it.each([
    { jsonrpc: "2.0", method: "_codebuddy.ai/command", params: { action: "workspace_info" } },
    { jsonrpc: "2.0", method: "_auth/status_update", params: {} },
    { jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind: 1 } } },
    { jsonrpc: "2.0", method: "_codebuddy.ai/authUrl", params: { authUrl: 1 } },
    { jsonrpc: "1.0", method: "_auth/status_update", params: { authStatus: { kind: "none" } } },
    { jsonrpc: "2.0", id: null, method: "_auth/status_update", params: { authStatus: { kind: "none" } } },
    { jsonrpc: "2.0", method: "bogus/notification", params: {} },
  ])("still rejects malformed or unknown notification %j", async notification => {
    await expect(makeClient(notification).start()).rejects.toThrow("unrecognized ACP JSON-RPC message");
  });
});
