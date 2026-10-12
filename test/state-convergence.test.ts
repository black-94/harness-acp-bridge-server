/**
 * Focused state-convergence coverage for a running message: the transport channel (stdout) ending,
 * a harness exiting mid-turn, polling that must not fabricate progress, and restart recovery.
 *
 * The on-disk queue/result/session snapshots must agree with the HTTP `message_status` view, with
 * no residual busy slot. These tests drive the real supervisor + fake harness, so a build must
 * precede `vitest run` (imports resolve against `dist/`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/logic/config";
import { HarnessHttpServer } from "../dist/http/server.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-harness.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0)) await operation(); vi.unstubAllEnvs(); });

async function setup(settings: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hab-state-"));
  const path = join(directory, "config.yaml");
  writeFileSync(path, stringify({
    schema_version: 2,
    paths: { state_dir: join(directory, "sessions") },
    server: { host: "127.0.0.1", port: 0 },
    sessions: { max_concurrency: 2, reap_interval_seconds: 0.05, stall_hint_seconds: 120 },
    timeouts: { startup_timeout_seconds: 3, request_timeout_seconds: 1, turn_timeout_seconds: 5, turn_cancel_timeout_seconds: 0.3, terminate_grace_seconds: 0.05, remote_cleanup_timeout_seconds: 0.05, authentication_timeout_seconds: 0.5 },
    authentication: { rate_limit: { enabled: false } },
    default_harness: "codebuddy",
    harnesses: { codebuddy: { models: [{ id: "fake-model", thinking_levels: ["low", "high"] }] } },
    ...settings,
  }));
  const config = loadConfig(path);
  const server = new HarnessHttpServer(config);
  const address = await server.start();
  cleanup.push(async () => { await server.stop(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const body = method === "create_session" ? { command: process.execPath, args: [fixture], ...params } : params;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json() as any) };
  };
  const create = async () => (await request("create_session", { cwd: directory, model_id: "fake-model" })).data.session_id as string;
  const waitTerminal = async (session: string, message: string) => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const response = await request("message_status", { session_id: session, message_id: message });
      if (response.data?.terminal) return response.data;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("message did not become terminal");
  };
  const dir = (session: string) => join(config.paths.sessionDir, session);
  return { server, config, directory, request, create, waitTerminal, dir };
}

describe("running message state convergence", () => {
  it("converges when the ACP stdout channel closes but the process stays alive", async () => {
    const app = await setup();
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "CLOSE_STDOUT" })).data.message_id;
    const status = await app.waitTerminal(session, message);
    expect(status.state).toBe("failed");
    expect(status.error.code).toBe("transport_closed");
    expect(status.finished_at).toBeTruthy();
    // Disk agrees with the HTTP view: queue + result + session, and no residual busy slot.
    const queue = JSON.parse(readFileSync(join(app.dir(session), "queue.json"), "utf8"));
    const record = queue.messages.find((entry: { message_id: string }) => entry.message_id === message);
    expect(record.terminal).toBe(true);
    expect(record.state).toBe("failed");
    expect(record.finished_at).toBeTruthy();
    expect(queue.active_message_id).toBeNull();
    expect(JSON.parse(readFileSync(join(app.dir(session), "results", `${message}.json`), "utf8")).terminal).toBe(true);
    const snapshot = JSON.parse(readFileSync(join(app.dir(session), "session.json"), "utf8"));
    expect(snapshot.state).toBe("failed");
    expect(snapshot.operation).toBe("closed");
    // The paired stdout 'end'/'close' EOF events must not finalize the message twice.
    const raw = readFileSync(join(app.dir(session), "raw.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(raw.filter(event => event.event === "message_finished").length).toBe(1);
    expect((await app.request("send_message", { session_id: session, text: "next" })).error.code).toBe("session_closed");
  });

  it("converges when the harness exits mid-turn", async () => {
    const app = await setup();
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "FORCE_EXIT" })).data.message_id;
    const status = await app.waitTerminal(session, message);
    expect(status.state).toBe("failed");
    expect(status.error.code).toBe("transport_closed");
    expect(status.finished_at).toBeTruthy();
  });

  it("does not overwrite a completed result when the channel closes later", async () => {
    const app = await setup();
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "keep-me" })).data.message_id;
    const first = await app.waitTerminal(session, message);
    expect(first.state).toBe("completed");
    // A later EOF (its own message) closes the session but must leave the finished result intact.
    const second = (await app.request("send_message", { session_id: session, text: "CLOSE_STDOUT" })).data.message_id;
    expect((await app.waitTerminal(session, second)).state).toBe("failed");
    const again = (await app.request("message_status", { session_id: session, message_id: message })).data;
    expect(again.state).toBe("completed");
    expect(again.result).toEqual(first.result);
  });

  it("never advances activity metrics from polling", async () => {
    const app = await setup();
    const session = await app.create();
    // `SILENT_HANG` (unlike `HANG`, which still echoes) emits nothing, so progress must stay null;
    // this keeps the assertion about a never-progressing message deterministic.
    const message = (await app.request("send_message", { session_id: session, text: "SILENT_HANG" })).data.message_id;
    const first = (await app.request("message_status", { session_id: session, message_id: message })).data;
    const anchor = first.activity.last_progress_at;
    await new Promise(resolve => setTimeout(resolve, 60));
    for (let index = 0; index < 5; index++) {
      await app.request("message_status", { session_id: session, message_id: message });
      await app.request("ping");
    }
    const later = (await app.request("message_status", { session_id: session, message_id: message })).data;
    expect(later.activity.last_progress_at).toBe(anchor);
    // Elapsed time is derived at read time, so it grows rather than resetting on each poll.
    expect(later.activity.seconds_since_progress).toBeGreaterThanOrEqual(first.activity.seconds_since_progress);
    await app.request("cancel_message", { session_id: session, message_id: message });
  });

  it("flags a stalled wait and records real phases without inventing a terminal state", async () => {
    const app = await setup({ sessions: { max_concurrency: 2, reap_interval_seconds: 0.05, stall_hint_seconds: 0.05 } });
    const session = await app.create();
    // No output at all: `last_progress_at` stays null, but the stall hint is measured from submission.
    const hang = (await app.request("send_message", { session_id: session, text: "SILENT_HANG" })).data.message_id;
    await new Promise(resolve => setTimeout(resolve, 80));
    const stalled = (await app.request("message_status", { session_id: session, message_id: hang })).data;
    expect(stalled.state).toBe("running");
    expect(stalled.terminal).toBe(false);
    expect(stalled.activity.stalled).toBe(true);
    expect(stalled.activity.last_progress_at).toBeNull();
    expect(stalled.activity.stall_hint_seconds).toBe(0.05);
    expect(stalled.activity.observed_phase).toBeNull();
    await app.request("cancel_message", { session_id: session, message_id: hang });
    // Real tool output is a distinct, readable phase and is the last observed progress.
    const tools = (await app.request("send_message", { session_id: session, text: "reasoning-tools" })).data.message_id;
    const done = await app.waitTerminal(session, tools);
    expect(done.state).toBe("completed");
    expect(done.activity.observed_phase).toBe("tool_use");
    expect(done.result.reasoning).toContain("正在分析问题😀");
  });

  it("converges in-flight messages on restart with a finished_at", async () => {
    const app = await setup();
    const session = await app.create();
    await app.server.stop();
    const dir = app.dir(session);
    // Simulate a crash: a live session with a message that never reached a result file.
    const snapshot = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    writeFileSync(join(dir, "session.json"), JSON.stringify({ ...snapshot, state: "ready" }));
    writeFileSync(join(dir, "queue.json"), JSON.stringify({ version: 2, active_message_id: "pending-message", messages: [
      { session_id: session, message_id: "pending-message", state: "running", terminal: false },
    ], idempotency: {} }));
    const restarted = new HarnessHttpServer(app.config);
    const address = await restarted.start();
    cleanup.push(() => restarted.stop());
    const response = await fetch(`http://127.0.0.1:${address.port}/api/message_status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: session, message_id: "pending-message" }) });
    const data = (await response.json() as any).data;
    expect(data.terminal).toBe(true);
    expect(data.error.code).toBe("session_interrupted");
    expect(data.finished_at).toBeTruthy();
  });

  it("completes a prompt whose final response has no trailing newline before the channel converges", async () => {
    const app = await setup();
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "FINAL_NO_NEWLINE" })).data.message_id;
    const status = await app.waitTerminal(session, message);
    // The newline-less final response is delivered at EOF before the fault, so the prompt settles.
    expect(status.state).toBe("completed");
    expect(status.result.stop_reason).toBe("end_turn");
    const raw = readFileSync(join(app.dir(session), "raw.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(raw.filter(event => event.event === "message_finished").length).toBe(1);
  });

  it("fails a running message on a malformed final frame at EOF", async () => {
    const app = await setup();
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "PARTIAL_JSON" })).data.message_id;
    const status = await app.waitTerminal(session, message);
    expect(status.state).toBe("failed");
    expect(["invalid_json", "transport_closed"]).toContain(status.error.code);
  });

  it("isolates progress per message so a new one does not inherit the previous stale metrics", async () => {
    const app = await setup({ sessions: { max_concurrency: 2, reap_interval_seconds: 0.05, stall_hint_seconds: 0.5 } });
    const session = await app.create();
    const first = (await app.request("send_message", { session_id: session, text: "keep-me" })).data.message_id;
    const firstDone = await app.waitTerminal(session, first);
    expect(firstDone.state).toBe("completed");
    // A gap longer than the stall hint: without per-message isolation the next message would look
    // stalled immediately and could show the previous phase.
    await new Promise(resolve => setTimeout(resolve, 600));
    const second = (await app.request("send_message", { session_id: session, text: "SILENT_HANG" })).data.message_id;
    const initial = (await app.request("message_status", { session_id: session, message_id: second })).data;
    expect(initial.state).toBe("running");
    expect(initial.activity.last_progress_at).toBeNull();
    expect(initial.activity.observed_phase).toBeNull();
    expect(initial.activity.stalled).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect((await app.request("message_status", { session_id: session, message_id: second })).data.activity.stalled).toBe(true);
    // The completed first result keeps its own activity, untouched by the second message.
    const firstAgain = (await app.request("message_status", { session_id: session, message_id: first })).data;
    expect(firstAgain.result).toEqual(firstDone.result);
    expect(firstAgain.activity).toEqual(firstDone.activity);
    await app.request("cancel_message", { session_id: session, message_id: second });
  });

  it("keeps a stall across usage heartbeats and clears it only on real output", async () => {
    const app = await setup({ sessions: { max_concurrency: 2, reap_interval_seconds: 0.05, stall_hint_seconds: 0.05 } });
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "USAGE_THEN_TEXT" })).data.message_id;
    await new Promise(resolve => setTimeout(resolve, 140));
    const mid = (await app.request("message_status", { session_id: session, message_id: message })).data;
    expect(mid.state).toBe("running");
    expect(mid.activity.last_progress_at).toBeNull();
    expect(mid.activity.observed_phase).toBe("usage");
    expect(mid.activity.stalled).toBe(true); // usage beats are metadata, not progress
    const done = await app.waitTerminal(session, message);
    expect(done.state).toBe("completed");
    expect(done.result.text).toContain("real-progress");
    expect(done.activity.last_progress_at).not.toBeNull();
    expect(done.activity.stalled).toBe(false);
  });

  it("reports needs-input, not a stall, while a message waits on the user", async () => {
    const app = await setup({ sessions: { max_concurrency: 2, reap_interval_seconds: 0.05, stall_hint_seconds: 0.05 } });
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "permission" })).data.message_id;
    let status: any;
    for (let index = 0; index < 50; index++) {
      status = (await app.request("message_status", { session_id: session, message_id: message })).data;
      if (status.questions?.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(status.state).toBe("waiting_input");
    expect(status.activity.observed_phase).toBe("waiting_input");
    expect(status.activity.stalled).toBe(false);
    expect(status.terminal).toBe(false);
    await app.request("answer_question", { session_id: session, message_id: message, request_id: status.questions[0].request_id, option_id: "allow_once" });
    expect((await app.waitTerminal(session, message)).state).toBe("completed");
  });
});
