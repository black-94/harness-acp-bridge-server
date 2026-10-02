/**
 * Turn settlement safety at the ACP transport boundary.
 *
 * Covers the `cancelTurn()` contract: the JSON-RPC `session/prompt` settlement is the only
 * safe turn boundary. A harness that honours the cancel keeps the session reusable; a
 * harness that ignores `session/cancel` past the cancel timeout desynchronizes the stream,
 * so the transport is fatally closed and the client becomes unusable; a late response
 * arriving after the settlement (or after the fatal close) must never be misattributed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AcpClient } from "../src/acp";

type FakeMode = "honour-cancel" | "ignore-cancel" | "ignore-cancel-late-response" | "duplicate-response";

/**
 * A minimal newline-delimited JSON-RPC harness with scriptable prompt settlement.
 *
 * - `honour-cancel`: replies to `session/prompt` shortly after `session/cancel`.
 * - `ignore-cancel`: never replies to `session/prompt` (the cancel is swallowed).
 * - `ignore-cancel-late-response`: ignores the cancel and only settles the prompt long
 *   after the client's cancel timeout has already expired.
 * - `duplicate-response`: settles the prompt normally, then re-sends the same response.
 */
function harnessScript(mode: FakeMode): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
const mode = ${JSON.stringify(mode)};
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [] } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-harness-session" } });
  } else if (msg.method === "session/prompt") {
    promptId = msg.id;
    if (mode === "duplicate-response") {
      const response = { jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } };
      send(response);
      setTimeout(() => send(response), 50);
    }
  } else if (msg.method === "session/cancel") {
    if (mode === "honour-cancel" && promptId !== null) {
      setTimeout(() => send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } }), 30);
    }
    if (mode === "ignore-cancel-late-response" && promptId !== null) {
      setTimeout(() => send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }), 700);
    }
    // ignore-cancel: the cancel is swallowed and the prompt never settles.
  }
});
`;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeClient(mode: FakeMode, cancelTimeoutMs = 250): AcpClient {
  const dir = mkdtempSync(join(tmpdir(), "hab-acp-settle-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new AcpClient({
    command: process.execPath,
    cwd: dir,
    args: ["-e", harnessScript(mode)],
    cancelTimeoutMs,
    startupTimeoutMs: 10_000,
  });
}

async function startTurn(mode: FakeMode, cancelTimeoutMs = 250): Promise<AcpClient> {
  const client = makeClient(mode, cancelTimeoutMs);
  cleanups.push(() => client.close().catch(() => undefined));
  await client.start();
  await client.openSession();
  await client.beginTurn("hello");
  return client;
}

describe("AcpClient turn settlement", () => {
  it("keeps the session reusable when the harness settles the prompt after session/cancel", async () => {
    const client = await startTurn("honour-cancel");
    await client.cancelTurn();
    expect(client.running).toBe(true);
    expect(client.turnActive).toBe(false);
    // A new turn can begin: the previous prompt request was settled.
    await client.beginTurn("second turn");
    expect(client.turnActive).toBe(true);
  });

  it("fatally closes the transport when the harness ignores session/cancel past the timeout", async () => {
    const client = await startTurn("ignore-cancel", 250);
    await client.cancelTurn();
    // Drain microtasks: the fatal rejection reaches the turn's settled flag through the
    // async `request()` wrapper a few ticks later.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The prompt never settled: the transport must be gone and the client unusable,
    // never cleared-and-continued.
    expect(client.running).toBe(false);
    expect(client.turnActive).toBe(false);
    await expect(client.beginTurn("next")).rejects.toThrow();
    await expect(client.setModel("any-model")).rejects.toThrow();
  });

  it("ignores a late prompt response arriving after the cancel timeout closed the transport", async () => {
    const client = await startTurn("ignore-cancel-late-response", 250);
    await client.cancelTurn();
    expect(client.running).toBe(false);
    // The harness sends the response 700ms in, well past the 250ms cancel timeout: it must
    // be dropped by the broken transport instead of resurrecting or misattributing state.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(client.running).toBe(false);
    expect(client.turnActive).toBe(false);
    await expect(client.beginTurn("next")).rejects.toThrow();
  });

  it("fatally closes the transport on a duplicate (late) response for a settled request id", async () => {
    const client = await startTurn("duplicate-response");
    const event = await client.waitForTurnEvent(5000);
    expect(event.kind).toBe("complete");
    // The duplicate response arrives ~50ms after the settlement.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.running).toBe(false);
    await expect(client.beginTurn("next")).rejects.toThrow();
  });
});
