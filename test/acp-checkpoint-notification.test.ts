import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";

/**
 * CodeBuddy `_codebuddy.ai/checkpoint` regression tests.
 *
 * CodeBuddy broadcasts a checkpoint notification the first time it writes a file during a
 * turn. The bridge only observes it (advisory `vendorNotification`); it must never fail the
 * turn, drive bridge state, or leak credentials. The wire shape is taken from the frame that
 * previously failed a real session (raw stream, `_codebuddy.ai/checkpoint` with
 * `event: "created"`) and from CodeBuddy's own `CheckpointBroadcastInfo` type.
 */

const clients: AcpClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake ACP harness that emits real checkpoint broadcasts around every lifecycle point. */
function checkpointHarnessSource(label: string): string {
  return `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const label = ${JSON.stringify(label)};
const checkpoint = event => ({jsonrpc:'2.0',method:'_codebuddy.ai/checkpoint',params:{
  sessionId:'test-session',
  event,
  checkpoint:{
    id:'cp-1',
    createdAt:1791134524163,
    label,
    fileChanges:{
      files:[{uri:'/tmp/migrate_sail_core.py', changeType:'created'}],
      totalAdditions:0,
      totalDeletions:0
    }
  }
}});
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send(checkpoint('created'));
    send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});
  } else if (msg.method === 'session/new') {
    send(checkpoint('created'));
    send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'test-session'}});
  } else if (msg.method === 'session/prompt') {
    send(checkpoint('created'));
    send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP_SMOKE_OK'}}}});
    send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'tool_call',toolCallId:'call_1',status:'pending',rawInput:{file_path:'/tmp/migrate_sail_core.py'}}}});
    send(checkpoint('updated'));
    send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});
    send(checkpoint('created'));
  }
});`;
}

function makeCheckpointClient(label = "created /tmp/migrate_sail_core.py"): {
  client: AcpClient;
  notifications: unknown[];
  auth: unknown[];
  updates: unknown[];
} {
  const dir = mkdtempSync(join(tmpdir(), "hab-checkpoint-"));
  dirs.push(dir);
  const client = new AcpClient({
    command: process.execPath,
    cwd: dir,
    args: ["-e", checkpointHarnessSource(label)],
    startupTimeoutMs: 5000,
  });
  clients.push(client);
  const notifications: unknown[] = [];
  const auth: unknown[] = [];
  const updates: unknown[] = [];
  client.on("vendorNotification", (value) => notifications.push(value));
  client.on("authNotification", (value) => auth.push(value));
  client.on("sessionUpdate", (value) => updates.push(value));
  return { client, notifications, auth, updates };
}

function makeNotificationClient(frame: unknown): AcpClient {
  const dir = mkdtempSync(join(tmpdir(), "hab-checkpoint-bad-"));
  dirs.push(dir);
  const script = `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send(${JSON.stringify(frame)});
    send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});
  }
});`;
  const client = new AcpClient({
    command: process.execPath,
    cwd: dir,
    args: ["-e", script],
    startupTimeoutMs: 5000,
  });
  clients.push(client);
  return client;
}

/** Send a hand-written JSON line (so `1e999` stays `Infinity` instead of becoming `null`). */
function rawCheckpointLine(paramsJson: string): string {
  return `{"jsonrpc":"2.0","method":"_codebuddy.ai/checkpoint","params":${paramsJson}}`;
}

function makeRawNotificationClient(rawLine: string): AcpClient {
  const dir = mkdtempSync(join(tmpdir(), "hab-checkpoint-raw-"));
  dirs.push(dir);
  const script = `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(${JSON.stringify(rawLine)}+'\\n');
    send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});
  }
});`;
  const client = new AcpClient({
    command: process.execPath,
    cwd: dir,
    args: ["-e", script],
    startupTimeoutMs: 5000,
  });
  clients.push(client);
  return client;
}

function checkpointParams(): Record<string, unknown> {
  return {
    sessionId: "test-session",
    event: "created",
    checkpoint: {
      id: "cp-1",
      createdAt: 1791134524163,
      fileChanges: {
        files: [{ uri: "/tmp/migrate_sail_core.py", changeType: "created" }],
        totalAdditions: 0,
        totalDeletions: 0,
      },
    },
  };
}

function checkpointFrame(mutate: (params: Record<string, any>) => void = () => {}): Record<string, unknown> {
  const params = checkpointParams() as Record<string, any>;
  mutate(params);
  return { jsonrpc: "2.0", method: "_codebuddy.ai/checkpoint", params };
}

describe("CodeBuddy checkpoint notifications", () => {
  it("accepts a real created checkpoint around initialize/session/prompt without breaking responses or turn completion", async () => {
    const { client, notifications } = makeCheckpointClient();
    await client.start();
    expect(client.running).toBe(true);
    await expect(client.openSession()).resolves.toBe("test-session");

    await client.beginTurn("hello");
    const event = await client.waitForTurnEvent(5000);
    expect(event.kind).toBe("complete");
    if (event.kind !== "complete") return;
    expect(event.result.status).toBe("completed");
    expect(event.result.text).toBe("ACP_SMOKE_OK");
    expect(client.running).toBe(true);

    // initialize + session/new + before/after prompt each produced a checkpoint
    expect(notifications.length).toBeGreaterThanOrEqual(4);
    expect(new Set(notifications.map((value) => (value as { method?: unknown }).method))).toEqual(
      new Set(["_codebuddy.ai/checkpoint"]),
    );
  });

  it("runs a second turn after session/update tool_call and the session/prompt response", async () => {
    const { client } = makeCheckpointClient();
    await client.start();
    await client.openSession();

    await client.beginTurn("first");
    const first = await client.waitForTurnEvent(5000);
    expect(first.kind).toBe("complete");

    // A checkpoint is emitted after the first prompt response too; the transport stays usable.
    await client.beginTurn("second");
    const second = await client.waitForTurnEvent(5000);
    expect(second.kind).toBe("complete");
    if (second.kind !== "complete") return;
    expect(second.result.text).toBe("ACP_SMOKE_OK");
    expect(client.running).toBe(true);
  });

  it("exposes checkpoints only on the advisory channel, redacted and never executed", async () => {
    const { client, notifications, auth, updates } = makeCheckpointClient(
      "checkpoint token=secret-checkpoint-value",
    );
    await client.start();
    await client.openSession();
    await client.beginTurn("hello");
    const event = await client.waitForTurnEvent(5000);
    expect(event.kind).toBe("complete");
    if (event.kind !== "complete") return;

    // Not an auth notification, and never folded into final text / tool_calls.
    expect(auth).toHaveLength(0);
    expect(event.result.text).toBe("ACP_SMOKE_OK");
    expect(JSON.stringify(event.result.toolCalls)).not.toContain("checkpoint");
    expect(JSON.stringify(event.result)).not.toContain("secret-checkpoint-value");

    // Credentials in the advisory payload are still redacted; the checkpoint is data only.
    const serialized = JSON.stringify(notifications);
    expect(serialized).not.toContain("secret-checkpoint-value");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("/tmp/migrate_sail_core.py");
    // Checkpoints never surface as session updates.
    expect(JSON.stringify(updates)).not.toContain("checkpoint");
  });

  const invalidFrames: Array<{ name: string; frame: unknown }> = [
    {
      name: "non-2.0 version",
      frame: { jsonrpc: "1.0", method: "_codebuddy.ai/checkpoint", params: checkpointParams() },
    },
    {
      name: "null id",
      frame: { jsonrpc: "2.0", id: null, method: "_codebuddy.ai/checkpoint", params: checkpointParams() },
    },
    { name: "missing params", frame: { jsonrpc: "2.0", method: "_codebuddy.ai/checkpoint" } },
    {
      name: "non-object params",
      frame: { jsonrpc: "2.0", method: "_codebuddy.ai/checkpoint", params: "nope" },
    },
    {
      name: "non-string sessionId",
      frame: checkpointFrame((params) => {
        params.sessionId = 123;
      }),
    },
    {
      name: "missing event",
      frame: checkpointFrame((params) => {
        delete params.event;
      }),
    },
    {
      name: "non-string event",
      frame: checkpointFrame((params) => {
        params.event = 123;
      }),
    },
    {
      name: "missing checkpoint",
      frame: checkpointFrame((params) => {
        delete params.checkpoint;
      }),
    },
    {
      name: "non-object checkpoint",
      frame: checkpointFrame((params) => {
        params.checkpoint = "nope";
      }),
    },
    {
      name: "non-string checkpoint.id",
      frame: checkpointFrame((params) => {
        params.checkpoint.id = 1;
      }),
    },
    {
      name: "non-number checkpoint.createdAt",
      frame: checkpointFrame((params) => {
        params.checkpoint.createdAt = "now";
      }),
    },
    {
      name: "missing fileChanges",
      frame: checkpointFrame((params) => {
        delete params.checkpoint.fileChanges;
      }),
    },
    {
      name: "files not an array",
      frame: checkpointFrame((params) => {
        params.checkpoint.fileChanges.files = {};
      }),
    },
    {
      name: "totalAdditions not a number",
      frame: checkpointFrame((params) => {
        params.checkpoint.fileChanges.totalAdditions = "0";
      }),
    },
    {
      name: "totalDeletions not a number",
      frame: checkpointFrame((params) => {
        params.checkpoint.fileChanges.totalDeletions = "0";
      }),
    },
    {
      name: "file entry missing uri",
      frame: checkpointFrame((params) => {
        params.checkpoint.fileChanges.files = [{ changeType: "created" }];
      }),
    },
    {
      name: "file entry missing changeType",
      frame: checkpointFrame((params) => {
        params.checkpoint.fileChanges.files = [{ uri: "/tmp/migrate_sail_core.py" }];
      }),
    },
    {
      name: "unknown _codebuddy.ai/* notification",
      frame: { jsonrpc: "2.0", method: "_codebuddy.ai/checkpoint/list", params: checkpointParams() },
    },
    {
      name: "unknown notification method",
      frame: { jsonrpc: "2.0", method: "bogus/notification", params: {} },
    },
  ];

  it.each(invalidFrames)("still rejects malformed or unknown notification: $name", async ({ frame }) => {
    await expect(makeNotificationClient(frame).start()).rejects.toThrow(
      "unrecognized ACP JSON-RPC message",
    );
  });

  const nonFiniteParams: Record<string, string> = {
    createdAt:
      '{"sessionId":"test-session","event":"created","checkpoint":{"id":"cp-1","createdAt":1e999,"fileChanges":{"files":[{"uri":"/tmp/x","changeType":"created"}],"totalAdditions":0,"totalDeletions":0}}}',
    totalAdditions:
      '{"sessionId":"test-session","event":"created","checkpoint":{"id":"cp-1","createdAt":1791134524163,"fileChanges":{"files":[{"uri":"/tmp/x","changeType":"created"}],"totalAdditions":1e999,"totalDeletions":0}}}',
    totalDeletions:
      '{"sessionId":"test-session","event":"created","checkpoint":{"id":"cp-1","createdAt":1791134524163,"fileChanges":{"files":[{"uri":"/tmp/x","changeType":"created"}],"totalAdditions":0,"totalDeletions":1e999}}}',
  };

  it.each(Object.entries(nonFiniteParams))(
    "rejects the required numeric field %s when it is non-finite (1e999 -> Infinity)",
    async (_field, paramsJson) => {
      await expect(makeRawNotificationClient(rawCheckpointLine(paramsJson)).start()).rejects.toThrow(
        "unrecognized ACP JSON-RPC message",
      );
    },
  );

  it("treats an id-bearing checkpoint frame as a request and answers -32601, never a notification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hab-checkpoint-req-"));
    dirs.push(dir);
    const frame = { ...checkpointFrame(), id: 999 };
    const script = `
const rl = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let unsupportedReply = null;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send(${JSON.stringify(frame)});
    send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});
  } else if (msg.id !== undefined && msg.error) {
    unsupportedReply = msg;
  } else if (msg.method === 'session/new') {
    send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'test-session'}});
  } else if (msg.method === 'session/prompt') {
    send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'UNSUPPORTED_REPLY='+JSON.stringify(unsupportedReply)}}}});
    send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});
  }
});`;
    const client = new AcpClient({
      command: process.execPath,
      cwd: dir,
      args: ["-e", script],
      startupTimeoutMs: 5000,
    });
    clients.push(client);
    const notifications: unknown[] = [];
    client.on("vendorNotification", (value) => notifications.push(value));

    const init = await client.start();
    expect(init.result).toBeDefined();
    await client.openSession();
    await client.beginTurn("check");
    const event = await client.waitForTurnEvent(5000);
    expect(event.kind).toBe("complete");
    if (event.kind !== "complete") return;

    // The harness observed a JSON-RPC error response for id 999 with code -32601, i.e. the
    // frame went down the reverse-request path (unsupported method), not the notification one.
    expect(event.result.text).toContain('"id":999');
    expect(event.result.text).toContain("-32601");
    expect(event.result.text).not.toContain("UNSUPPORTED_REPLY=null");
    expect(notifications).toHaveLength(0);
  });
});
