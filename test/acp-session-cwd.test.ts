import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";

describe("ACP session working directory", () => {
  it.each([false, true])("sends the target cwd without using it to spawn the local transport (resume=%s)", async resume => {
    const localCwd = mkdtempSync(join(tmpdir(), "hab-local-cwd-"));
    const targetCwd = "/remote-only/container/workspace";
    const script = `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line', line => {
 const msg = JSON.parse(line);
 if (msg.method === 'initialize') send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});
 else if (msg.method === 'session/new' || msg.method === 'session/load') {
  if (process.cwd() !== ${JSON.stringify(realpathSync(localCwd))} || msg.params.cwd !== ${JSON.stringify(targetCwd)})
   send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'wrong cwd'}});
  else send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'cwd-session'}});
 }
});`;
    const client = new AcpClient({ command: process.execPath, args: ["-e", script], cwd: localCwd, sessionCwd: targetCwd });
    try {
      await client.start();
      expect(await client.openSession(resume ? "cwd-session" : undefined)).toBe("cwd-session");
    } finally {
      await client.close();
      rmSync(localCwd, { recursive: true, force: true });
    }
  });
});
