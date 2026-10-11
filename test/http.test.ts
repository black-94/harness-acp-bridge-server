import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig, type BridgeConfig } from "../src/config";
import { HarnessHttpServer } from "../dist/http/server.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-harness.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0)) await operation(); vi.unstubAllEnvs(); });
async function setup(settings: Record<string, unknown> = {}, flags: string[] = [], harness = "codebuddy") {
  const directory = mkdtempSync(join(tmpdir(), "hab-http-"));
  const path = join(directory, "config.yaml");
  writeFileSync(path, stringify({ schema_version: 2, paths: { state_dir: join(directory, "sessions") },
    server: { host: "127.0.0.1", port: 0 }, sessions: { max_concurrency: 4, reap_interval_seconds: 0.05 },
    timeouts: { startup_timeout_seconds: 3, request_timeout_seconds: 1, turn_timeout_seconds: 5, turn_cancel_timeout_seconds: 0.3, terminate_grace_seconds: 0.05, remote_cleanup_timeout_seconds: 0.05, authentication_timeout_seconds: 0.5 },
    authentication: { rate_limit: { enabled: false } },
    default_harness: harness, harnesses: { [harness]: { command: process.execPath, args: [fixture, ...flags], models: [{ id: "fake-model", thinking_levels: ["low", "high"] }, { id: "fake-model-2", thinking_levels: ["low"] }] } }, ...settings }));
  const config = loadConfig(path);
  const server = new HarnessHttpServer(config);
  const address = await server.start();
  cleanup.push(async () => { await server.stop(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
    return { status: response.status, ...(await response.json() as any) };
  };
  const create = async () => {
    const response = await request("create_session", { cwd: directory, model_id: "fake-model" });
    expect(response.ok, JSON.stringify(response)).toBe(true); return response.data.session_id as string;
  };
  const createRaw = (params: Record<string, unknown> = {}) => request("create_session", { cwd: directory, model_id: "fake-model", ...params });
  const complete = async (session: string, message: string) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const response = await request("message_status", { session_id: session, message_id: message });
      if (response.data?.terminal) return response.data;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("message did not become terminal");
  };
  return { server, config, directory, base, request, create, createRaw, complete };
}
/** A full auth timeouts block wide enough for multi-round interactive login tests. */
const AUTH_TIMEOUTS = {
  startup_timeout_seconds: 3, request_timeout_seconds: 2, turn_timeout_seconds: 5,
  authentication_timeout_seconds: 5, input_timeout_seconds: 4,
  turn_cancel_timeout_seconds: 0.3, terminate_grace_seconds: 0.05, remote_cleanup_timeout_seconds: 0.05,
};
/** Poll `auth_status` until `predicate` holds, returning the final snapshot. */
async function waitAuth(request: (method: string, params?: Record<string, unknown>) => Promise<any>, session: string, predicate: (snapshot: any) => boolean) {
  const end = Date.now() + 4000;
  let snapshot: any;
  while (Date.now() < end) {
    snapshot = (await request("auth_status", { session_id: session })).data;
    if (snapshot && predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`auth never satisfied predicate: ${JSON.stringify(snapshot)}`);
}
/** The method-selection question of a flow snapshot. */
const methodQuestion = (snapshot: any) => (snapshot.questions ?? []).find((question: any) => question.schema?.properties?.method_id);
/** Wait for the next non-selection auth question (a token/browser reverse request). */
async function nextAuthQuestion(request: (method: string, params?: Record<string, unknown>) => Promise<any>, session: string) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const snapshot = (await request("auth_status", { session_id: session })).data;
    const question = (snapshot.questions ?? []).find((candidate: any) => !candidate.schema?.properties?.method_id);
    if (question) return question;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("no auth question arrived");
}
describe("HTTP server contract and session state machine", () => {
  it("accepts only POST JSON and searches configuration without starting a harness", async () => {
    const app = await setup();
    const ping = await app.request("ping"); expect(ping.data.sessions).toBe(0); expect(ping.data.protocol_version).toBe(3);
    const found = await app.request("search_harness"); expect(found.data.harnesses.codebuddy.models[0].id).toBe("fake-model");
    expect((await app.request("ping")).data.sessions).toBe(0);
    expect((await fetch(`${app.base}/api/ping`)).status).toBe(405);
    const invalid = await fetch(`${app.base}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(invalid.status).toBe(400); expect((await invalid.json() as any).error.code).toBe("invalid_json");
    expect((await app.request("set_config")).status).toBe(404);
    expect((await app.request("send_message", { session_id: "../../escape", text: "x" })).ok).toBe(false);
  });
  it("submits asynchronously, records exact raw traffic, writes only the new layout, and returns completed results", async () => {
    const app = await setup(); const session = await app.create();
    const submitted = await app.request("send_message", { session_id: session, text: "reasoning-tools 中文😀", idempotency_key: "a" });
    expect(Object.keys(submitted.data)).toEqual(["message_id"]);
    const result = await app.complete(session, submitted.data.message_id);
    expect(result.state).toBe("completed"); expect(result.result.text).toBe("echo:reasoning-tools 中文😀");
    expect(result.result.reasoning).toBe("正在分析问题😀"); expect(result.result.tool_calls[0].output).toEqual({ value: 42 });
    expect(result.result.tool_calls[0].title).toBe("Read file"); expect(result.result.tool_calls[0].content[0].content.text).toBe("工具输出结果");
    expect((await app.request("send_message", { session_id: session, text: "reasoning-tools 中文😀", idempotency_key: "a" })).data.message_id).toBe(submitted.data.message_id);
    expect((await app.request("send_message", { session_id: session, text: "different", idempotency_key: "a" })).error.code).toBe("idempotency_conflict");
    await app.request("close_session", { session_id: session });
    const dir = join(app.config.paths.sessionDir, session);
    expect(readdirSync(dir).sort()).toEqual(["queue.json", "raw.jsonl", "results", "session.json"]);
    const raw = readFileSync(join(dir, "raw.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const stdin = raw.filter(event => event.stream === "stdin").map(event => Buffer.from(event.raw, "base64").toString("utf8")).join("");
    expect(stdin).toContain("reasoning-tools 中文😀");
    expect(raw.some(event => event.event === "message_finished")).toBe(true);
    expect(raw.map(event => event.seq)).toEqual(raw.map((_, index) => index + 1));
    expect((await app.request("message_status", { session_id: session, message_id: submitted.data.message_id })).data.result).toEqual(result.result);
  });
  it("rejects busy operations and permits cancel then send for steering", async () => {
    const app = await setup(); const session = await app.create();
    const first = (await app.request("send_message", { session_id: session, text: "HANG" })).data.message_id;
    expect((await app.request("send_message", { session_id: session, text: "later" })).error.code).toBe("busy");
    expect((await app.request("set_session_options", { session_id: session, model_id: "fake-model-2" })).error.code).toBe("busy");
    const cancelled = await app.request("cancel_message", { session_id: session, message_id: first });
    expect(cancelled.data.state).toBe("cancelled");
    const second = (await app.request("send_message", { session_id: session, text: "after-cancel" })).data.message_id;
    expect((await app.complete(session, second)).result.text).toBe("echo:after-cancel");
  });
  it.each(["bad-json", "oversize-soft", "oversize-hard"])("cancels %s, preserves raw bytes, and remains usable after confirmed cancellation", async text => {
    const app = await setup({ buffers: { max_read_bytes: "8KiB" } }); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text })).data.message_id;
    const result = await app.complete(session, message);
    expect(result.state).toBe("failed"); expect(result.error.code).toBe(text === "bad-json" ? "invalid_json" : "line_too_large");
    const raw = readFileSync(join(app.config.paths.sessionDir, session, "raw.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const stdout = Buffer.concat(raw.filter(event => event.stream === "stdout").map(event => Buffer.from(event.raw, "base64"))).toString("utf8");
    expect(stdout).toContain(text === "bad-json" ? "this is not json\n" : `${(text === "oversize-soft" ? "s" : "h").repeat(text === "oversize-soft" ? 20 * 1024 : 256 * 1024)}\n`);
    const next = (await app.request("send_message", { session_id: session, text: "next" })).data.message_id;
    expect((await app.complete(session, next)).state).toBe("completed");
  });
  it("reports unsupported traffic with original content while continuing subsequent events", async () => {
    const app = await setup(); const session = await app.create();
    for (const text of ["unknown-notice", "unknown-request"]) {
      const message = (await app.request("send_message", { session_id: session, text })).data.message_id;
      const result = await app.complete(session, message);
      expect(result.state).toBe("completed");
      // An unrecognized frame does not stop the turn; the following answer chunk still lands.
      expect(result.result.text).toContain("after-");
    }
    const stdout = readFileSync(join(app.config.paths.sessionDir, session, "raw.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.stream === "stdout").map(event => Buffer.from(event.raw, "base64").toString("utf8")).join("");
    // The on-disk copy redacts the sensitive `token` field, but keeps every ordinary byte of the
    // unrecognized frame (method name, the Chinese `value`) so the journal stays diagnosable.
    expect(stdout).not.toContain("raw-original-token");
    expect(stdout).toContain("vendor/notice");
    expect(stdout).toContain("通知原文");
    expect(stdout).toContain("[REDACTED]");
    const message = (await app.request("send_message", { session_id: session, text: "unsupported-result" })).data.message_id;
    const result = await app.complete(session, message);
    // The real wire is never rewritten: the unsupported-response error carries the original frame.
    expect(result.error.code).toBe("unsupported_response"); expect(result.error.detail.raw).toContain("vendorFinal");
  });
  it("repairs BOM/ANSI envelopes while recording original bytes", async () => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "repair-json" })).data.message_id;
    expect((await app.complete(session, message)).result.text).toContain("repaired😀");
    const raw = readFileSync(join(app.config.paths.sessionDir, session, "raw.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(raw.filter(event => event.stream === "stdout").some(event => Buffer.from(event.raw, "base64").toString("utf8").startsWith("\ufeff\x1b[32m"))).toBe(true);
  });
  it("validates permission options and routes the original request id", async () => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "permission" })).data.message_id;
    let status: any;
    for (let index = 0; index < 50; index++) {
      status = (await app.request("message_status", { session_id: session, message_id: message })).data;
      if (status.questions.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const question = status.questions[0]; expect(status.state).toBe("waiting_input");
    const params = { session_id: session, message_id: message, request_id: question.request_id, option_id: "not-offered" };
    expect((await app.request("answer_question", params)).error.code).toBe("invalid_option");
    expect((await app.request("answer_question", { ...params, option_id: "allow_once" })).ok).toBe(true);
    expect((await app.complete(session, message)).result.text).toContain("[allowed:allow_once]");
    expect((await app.request("answer_question", { ...params, option_id: "allow_once" })).ok).toBe(false);
  });
  it.each(["info", "elicit-form"])("routes %s reverse questions and their JSON answers", async text => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text })).data.message_id;
    let question: any;
    for (let index = 0; index < 50; index++) {
      question = (await app.request("message_status", { session_id: session, message_id: message })).data.questions[0];
      if (question) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(question).toBeDefined();
    const answer = await app.request("answer_question", { session_id: session, message_id: message, request_id: question.request_id, content: { value: "回答😀" } });
    expect(answer.ok).toBe(true); expect((await app.complete(session, message)).result.text).toContain("回答😀");
  });
  it.each(["codebuddy", "codex", "agy"])("routes session model/thinking/permission options for %s", async harness => {
    const app = await setup({}, [], harness); const session = await app.create();
    const result = await app.request("set_session_options", { session_id: session, model_id: "fake-model-2", thinking_level: "low", permission_mode: "yolo" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.options).toEqual({ model_id: "fake-model-2", thinking_level: "low", permission_mode: "yolo" });
    expect((await app.request("set_session_options", { session_id: session, model_id: "fake-model-2", thinking_level: "high" })).error.code).toBe("unsupported_request");
  });
  it("closes the session when cancellation cannot be confirmed", async () => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "HANG IGNORE_CANCEL" })).data.message_id;
    const result = await app.request("cancel_message", { session_id: session, message_id: message });
    expect(result.data.terminal).toBe(true); expect(result.data.error.code).toBe("cancel_timeout");
    expect((await app.request("send_message", { session_id: session, text: "next" })).error.code).toBe("session_closed");
  });
  it("removed the public live_output endpoint", async () => {
    const app = await setup(); const session = await app.create();
    const response = await app.request("live_output", { session_id: session, cursor: "0", limit: 2 });
    expect(response.status).toBe(404);
    expect(response.error.code).toBe("unsupported_request");
    await app.request("close_session", { session_id: session });
  });
  it("exposes a bounded sanitized progress snapshot while a message runs", async () => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "HANG" })).data.message_id;
    let snapshot: any;
    for (let index = 0; index < 200; index++) {
      snapshot = (await app.request("message_status", { session_id: session, message_id: message })).data;
      if (snapshot.progress?.text?.includes("echo:HANG")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(snapshot.terminal).toBe(false);
    expect(snapshot.progress.text).toContain("echo:HANG");
    expect(snapshot.progress).toHaveProperty("reasoning");
    expect(Array.isArray(snapshot.progress.tool_calls)).toBe(true);
    await app.request("cancel_message", { session_id: session, message_id: message });
    await app.request("close_session", { session_id: session });
  });
  it("times out a message by cancelling it, and enforces question deadlines", async () => {
    for (const settings of [{ turn_timeout_seconds: 0.05 }, { input_timeout_seconds: 0.05 }]) {
      const app = await setup({ timeouts: { ...settings, turn_cancel_timeout_seconds: 0.3, terminate_grace_seconds: 0.05 } });
      const session = await app.create();
      const text = settings.turn_timeout_seconds ? "HANG" : "permission";
      const message = (await app.request("send_message", { session_id: session, text })).data.message_id;
      const result = await app.complete(session, message);
      expect(result.error.code).toBe(settings.turn_timeout_seconds ? "message_timeout" : "input_timeout");
      const next = (await app.request("send_message", { session_id: session, text: "usable" })).data.message_id;
      expect((await app.complete(session, next)).state).toBe("completed");
    }
  });
  it("bounds handshake, authentication, and ordinary request waits", async () => {
    const handshake = await setup({ timeouts: { startup_timeout_seconds: 0.15, terminate_grace_seconds: 0.05 } }, ["--handshake-hang"]);
    expect((await handshake.request("create_session", { cwd: handshake.directory, model_id: "fake-model" })).error.code).toBe("handshake_timeout");
    const auth = await setup({ timeouts: { ...AUTH_TIMEOUTS, authentication_timeout_seconds: 0.3 } }, ["--auth-hang"]);
    const created = await auth.createRaw();
    const session = created.error.detail.session_id as string;
    const started = await auth.request("authenticate", { session_id: session });
    const answered = await auth.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "api-key" } });
    expect(answered.data.state).toBe("authenticating");
    // The auth deadline closes the half-authenticated session, which can never be reused.
    let closed = false;
    for (let index = 0; index < 200; index++) {
      if ((await auth.request("send_message", { session_id: session, text: "x" })).error?.code === "session_closed") { closed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(closed).toBe(true);
    const app = await setup({ timeouts: { request_timeout_seconds: 0.1, terminate_grace_seconds: 0.05 } }, [], "codex");
    const other = await app.create();
    const message = (await app.request("send_message", { session_id: other, text: "arm-options-hang" })).data.message_id;
    await app.complete(other, message);
    expect((await app.request("set_session_options", { session_id: other, model_id: "fake-model-2" })).error.code).toBe("request_timeout");
    expect((await app.request("send_message", { session_id: other, text: "x" })).error.code).toBe("session_closed");
  });
  it("reports unknown auth probes as unsupported, and drives a live flow to ready", async () => {
    const unknown = await setup({}, [], "codex"); const session = await unknown.create();
    const status = await unknown.request("auth_status", { session_id: session });
    expect(status.status).toBe(501); expect(status.error.code).toBe("unsupported_response"); expect(status.error.detail.raw.raw).toContain("unsupported");
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-required"]);
    const created = await app.createRaw();
    expect(created.status).toBe(403);
    expect(created.error.code).toBe("authentication_required");
    const other = created.error.detail.session_id as string;
    expect(created.error.detail.next_action).toEqual({ method: "authenticate", params: { session_id: other } });
    // create_session keeps the session alive; it is only reported as unauthenticated.
    const before = await app.request("auth_status", { session_id: other });
    expect(before.data.authenticated).toBe(false);
    const started = await app.request("authenticate", { session_id: other });
    expect(started.data.state).toBe("waiting_input");
    expect(started.data.terminal).toBe(false);
    const answered = await app.request("answer_question", { session_id: other, request_id: methodQuestion(started.data).request_id, content: { method_id: "api-key" } });
    expect(answered.data.state).toBe("authenticating");
    const ready = await waitAuth(app.request, other, snapshot => snapshot.state === "ready");
    expect(ready.authenticated).toBe(true);
    expect(ready.terminal).toBe(true);
    expect((await app.request("auth_status", { session_id: other })).data.authenticated).toBe(true);
  });
  it("closes an unauthenticated session without blocking on login", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-required"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const closed = await app.request("close_session", { session_id: session });
    expect(closed.ok).toBe(true);
    expect(closed.data.state).toBe("closed");
    expect((await app.request("authenticate", { session_id: session })).error.code).toBe("session_closed");
  });
  it("restarts a finished flow instead of replaying it, without duplicating questions", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-required"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const first = await app.request("authenticate", { session_id: session });
    const cancelled = await app.request("answer_question", { session_id: session, request_id: methodQuestion(first.data).request_id, answer: "cancel" });
    expect(cancelled.data.state).toBe("cancelled");
    expect(cancelled.data.terminal).toBe(true);
    const again = await app.request("authenticate", { session_id: session });
    expect(again.data.state).toBe("waiting_input");
    expect(methodQuestion(again.data).request_id).not.toBe(methodQuestion(first.data).request_id);
  });
  it("requires an explicit method choice and lists unsupported candidates", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    const candidates = started.data.candidates;
    expect(candidates.map((candidate: any) => candidate.id)).toEqual(["api-key", "token", "approve", "device", "browser", "codes", "client-code"]);
    const unsupported = candidates.find((candidate: any) => candidate.id === "client-code");
    expect(unsupported.supported).toBe(false);
    expect(unsupported.type).toBe("client");
    expect(unsupported.description).toContain("Not supported in harness_acp_bridge");
    const question = methodQuestion(started.data);
    expect(question.schema.properties.method_id.enum).toEqual(["api-key", "token", "approve", "device", "browser", "codes"]);
    expect((await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { method_id: "client-code" } })).error.code).toBe("unsupported_authentication");
    expect((await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { method_id: "nope" } })).error.code).toBe("invalid_option");
    expect((await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { method_id: "api-key" } })).data.state).toBe("authenticating");
    await waitAuth(app.request, session, snapshot => snapshot.state === "ready");
  });
  it("completes a multi-round information/token login only on real harness success", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "token" } });
    const first = await nextAuthQuestion(app.request, session);
    expect(first.title).toBe("Choose account");
    // schema validation is enforced before the answer reaches the harness
    expect((await app.request("answer_question", { session_id: session, request_id: first.request_id, content: {} })).error.code).toBe("invalid_answer");
    await app.request("answer_question", { session_id: session, request_id: first.request_id, content: { account: "me" } });
    const second = await nextAuthQuestion(app.request, session);
    expect(second.title).toBe("Enter token");
    await app.request("answer_question", { session_id: session, request_id: second.request_id, content: { token: "a-secret-token" } });
    const ready = await waitAuth(app.request, session, snapshot => snapshot.state === "ready");
    expect(ready.authenticated).toBe(true);
  });
  it("adapts a Codex device-code URL elicitation into a browser question", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"], "codex");
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "device" } });
    const question = await nextAuthQuestion(app.request, session);
    // Both the machine code (from the harness message) and the full verification URL are present.
    expect(question.message).toContain("ABCD-1234");
    expect(question.message).toContain("https://example.test/device");
    expect(question.schema.properties.opened.enum).toEqual([true]);
    await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { opened: true } });
    expect((await waitAuth(app.request, session, snapshot => snapshot.state === "ready")).authenticated).toBe(true);
  });
  it("adapts an Agy stderr login URL and keeps a confirmation from faking success", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"], "agy");
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "browser" } });
    const question = await nextAuthQuestion(app.request, session);
    expect(question.message).toBe("https://example.test/oauth");
    expect(question.schema.properties.opened.enum).toEqual([true]);
    const acked = await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { opened: true } });
    // Acknowledging the browser step is not the login; the harness has not confirmed yet.
    expect(acked.data.state).toBe("authenticating");
    expect(acked.data.terminal).toBe(false);
    expect((await waitAuth(app.request, session, snapshot => snapshot.state === "ready")).authenticated).toBe(true);
  });
  it("runs a permission-then-information auth loop, answering the permission with an option and no content", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "approve" } });
    const permission = await nextAuthQuestion(app.request, session);
    expect(permission.kind).toBe("permission");
    // An unoffered option is rejected and the question stays pending.
    expect((await app.request("answer_question", { session_id: session, request_id: permission.request_id, option_id: "not-offered" })).error.code).toBe("invalid_option");
    expect((await app.request("auth_status", { session_id: session })).data.questions).toHaveLength(1);
    // The permission is answered with an offered option and NO content.
    const answered = await app.request("answer_question", { session_id: session, request_id: permission.request_id, option_id: "allow_once" });
    expect(answered.ok, JSON.stringify(answered)).toBe(true);
    const info = await nextAuthQuestion(app.request, session);
    expect(info.title).toBe("Choose account");
    await app.request("answer_question", { session_id: session, request_id: info.request_id, content: { account: "me" } });
    expect((await waitAuth(app.request, session, snapshot => snapshot.state === "ready")).authenticated).toBe(true);
  });
  it("opens an externally completed login without a credential write or a rate charge", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--external-auth"]);
    const authFile = join(app.directory, "auth-calls.txt");
    vi.stubEnv("FAKE_HARNESS_AUTH_FILE", authFile);
    const created = await app.createRaw();
    expect(created.error.code).toBe("authentication_required");
    const session = created.error.detail.session_id as string;
    // The login completes outside the bridge (status probe flips to authenticated); no session yet.
    await new Promise(resolve => setTimeout(resolve, 350));
    expect((await app.request("auth_status", { session_id: session })).data.authenticated).toBe(true);
    const started = await app.request("authenticate", { session_id: session });
    expect(started.data.state).toBe("authenticating");
    // No method question: the credentials already exist, only the session is opened.
    expect(started.data.questions).toEqual([]);
    expect((await waitAuth(app.request, session, snapshot => snapshot.state === "ready")).authenticated).toBe(true);
    // The harness `authenticate` RPC (the credential write) was never called.
    expect(existsSync(authFile)).toBe(false);
  });
  it("keeps auth answer values exact on the wire but never persists them", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"]);
    const answerFile = join(app.directory, "answers.jsonl");
    vi.stubEnv("FAKE_HARNESS_ANSWER_FILE", answerFile);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "codes" } });
    const question = await nextAuthQuestion(app.request, session);
    expect(question.title).toBe("Credential codes");
    // Schema constraints are enforced before the answer reaches the harness.
    expect((await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { code: "xy" } })).error.code).toBe("invalid_answer");
    expect((await app.request("answer_question", { session_id: session, request_id: question.request_id, content: { code: "CODE-123456", bogus: "x" } })).error.code).toBe("invalid_answer");
    const sentinels = { code: "CODE-SENTINEL-AAAA", response: "RESP-SENTINEL-BBBB", answer: "ANS-SENTINEL-CCCC" };
    await app.request("answer_question", { session_id: session, request_id: question.request_id, content: sentinels });
    await waitAuth(app.request, session, snapshot => snapshot.state === "ready");
    await new Promise(resolve => setTimeout(resolve, 40));
    // The harness received the ORIGINAL bytes.
    const received = readFileSync(answerFile, "utf8");
    for (const value of Object.values(sentinels)) expect(received).toContain(value);
    // No snapshot retains the answers.
    const snapshot = JSON.stringify((await app.request("auth_status", { session_id: session })).data);
    for (const value of Object.values(sentinels)) expect(snapshot).not.toContain(value);
    // The on-disk journal is masked by value.
    const journal = readFileSync(join(app.config.paths.sessionDir, session, "raw.jsonl"), "utf8");
    for (const value of Object.values(sentinels)) expect(journal).not.toContain(value);
  });
  it("refuses a nonstandard authenticate result instead of reporting success", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-required", "--auth-result-false"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "api-key" } });
    const failed = await waitAuth(app.request, session, snapshot => snapshot.terminal === true);
    expect(failed.state).toBe("failed");
    expect(failed.error.code).toBe("authentication_failed");
    expect((await app.request("send_message", { session_id: session, text: "x" })).error.code).toBe("authentication_required");
  });
  it("attaches the real session_id and next_action to a synchronous adapter auth error", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--set-model-auth-32000"]);
    const session = await app.create();
    const result = await app.request("set_session_options", { session_id: session, model_id: "fake-model-2" });
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("authentication_required");
    expect(result.error.detail.session_id).toBe(session);
    expect(result.error.detail.next_action).toEqual({ method: "authenticate", params: { session_id: session } });
  });
  it("keeps an initialized harness usable when the setup auth probe reports ACP -32000", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--status-auth-32000"]);
    const created = await app.createRaw();
    expect(created.status).toBe(403);
    expect(created.error.code).toBe("authentication_required");
    const session = created.error.detail.session_id as string;
    expect(session).toBeTruthy();
    // The session stayed initialized (not closed): authenticate can finish it.
    const started = await app.request("authenticate", { session_id: session });
    expect(started.data.state).toBe("waiting_input");
    await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, content: { method_id: "api-key" } });
    expect((await waitAuth(app.request, session, snapshot => snapshot.state === "ready")).authenticated).toBe(true);
  });
  it("exposes a terminal flow or a clear session_closed after a flow ends, never a stale input loop", async () => {
    const app = await setup({ timeouts: AUTH_TIMEOUTS }, ["--auth-methods"]);
    const created = await app.createRaw(); const session = created.error.detail.session_id as string;
    const started = await app.request("authenticate", { session_id: session });
    const cancelled = await app.request("answer_question", { session_id: session, request_id: methodQuestion(started.data).request_id, answer: "cancel" });
    expect(cancelled.data.terminal).toBe(true);
    const status = await app.request("auth_status", { session_id: session });
    expect(status.ok).toBe(true);
    expect(status.data.terminal).toBe(true);
    expect(status.data.questions).toEqual([]);
    // After a hard close the same contract holds: terminal flow if still available, else session_closed.
    await app.request("close_session", { session_id: session });
    const after = await app.request("auth_status", { session_id: session });
    if (after.ok) { expect(after.data.terminal).toBe(true); expect(after.data.questions).toEqual([]); }
    else expect(after.error.code).toBe("session_closed");
  });
  it("reaps only idle sessions and applies a live-session concurrency bound", async () => {
    // A wider idle window keeps the setup round trips from racing the reaper on a loaded machine;
    // the assertions (busy session survives, idle session is reaped) are unchanged.
    const app = await setup({ sessions: { max_concurrency: 1, idle_timeout_seconds: 0.4, reap_interval_seconds: 0.05 } });
    const session = await app.create();
    expect((await app.request("create_session", { cwd: app.directory, model_id: "fake-model" })).error.code).toBe("session_limit");
    const message = (await app.request("send_message", { session_id: session, text: "HANG" })).data.message_id;
    await new Promise(resolve => setTimeout(resolve, 700));
    expect((await app.request("message_status", { session_id: session, message_id: message })).data.state).toBe("running");
    await app.request("cancel_message", { session_id: session, message_id: message });
    await new Promise(resolve => setTimeout(resolve, 700));
    expect((await app.request("send_message", { session_id: session, text: "after-idle" })).error.code).toBe("session_closed");
  });
  it("returns a JSON 413 for oversized HTTP bodies", async () => {
    const app = await setup({ server: { host: "127.0.0.1", port: 0, max_body_bytes: 32 } });
    const result = await app.request("ping", { value: "x".repeat(1000) });
    expect(result.status).toBe(413); expect(result.error.code).toBe("body_too_large");
  });
  it("closes safely when journaling cancellation fails instead of leaving a busy session", async () => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "HANG" })).data.message_id;
    const object = app.server.service.sessions.get(session)!;
    const record = object.store.event.bind(object.store);
    vi.spyOn(object.store, "event").mockImplementation((name, data) => {
      if (name === "message_cancel_requested") throw new Error("disk full");
      return record(name, data);
    });
    expect((await app.request("cancel_message", { session_id: session, message_id: message })).error.code).toBe("storage_error");
    const result = await app.complete(session, message); expect(result.state).toBe("failed"); expect(result.error.code).toBe("storage_error");
    expect((await app.request("send_message", { session_id: session, text: "unsafe-reuse" })).error.code).toBe("session_closed");
  });
  it("does not send a prompt when acceptance snapshot writing fails", async () => {
    const app = await setup(); const session = await app.create();
    const object = app.server.service.sessions.get(session)!;
    vi.spyOn(object.store, "queue").mockImplementationOnce(() => { throw new Error("snapshot write failed"); });
    expect((await app.request("send_message", { session_id: session, text: "must-not-be-sent" })).error.code).toBe("storage_error");
    await object.close();
    const stdin = readFileSync(object.store.rawPath, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.stream === "stdin").map(event => Buffer.from(event.raw, "base64").toString("utf8")).join("");
    expect(stdin).not.toContain("must-not-be-sent");
    expect((await app.request("send_message", { session_id: session, text: "unsafe-reuse" })).error.code).toBe("session_closed");
  });
  it("keeps completed results after restart, recovers in-flight records, and repairs a partial journal tail", async () => {
    const app = await setup(); const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "persisted" })).data.message_id;
    const result = await app.complete(session, message); await app.server.stop();
    const dir = join(app.config.paths.sessionDir, session);
    const snapshot = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")); snapshot.state = "ready";
    writeFileSync(join(dir, "session.json"), JSON.stringify(snapshot));
    writeFileSync(join(dir, "queue.json"), JSON.stringify({ version: 2, active_message_id: "pending-message", messages: [
      { session_id: session, message_id: message, terminal: false, state: "running" },
      { session_id: session, message_id: "pending-message", terminal: false, state: "running" },
    ], idempotency: {} }));
    const rawPath = join(dir, "raw.jsonl");
    const seq = JSON.parse(readFileSync(rawPath, "utf8").trim().split("\n").at(-1)!).seq;
    appendFileSync(rawPath, JSON.stringify({ version: 1, seq: seq + 1, timestamp: "now", session_id: session, message_id: null, type: "lifecycle", event: "large", data: "x".repeat(2 * 1024 * 1024) }) + "\n{incomplete");
    const restarted = new HarnessHttpServer(app.config); const address = await restarted.start(); cleanup.push(() => restarted.stop());
    const call = async (id: string) => (await (await fetch(`http://127.0.0.1:${address.port}/api/message_status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: session, message_id: id }) })).json() as any).data;
    expect((await call(message)).result).toEqual(result.result);
    expect((await call("pending-message")).error.code).toBe("session_interrupted");
    const raw = readFileSync(rawPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(raw.at(-1).seq).toBe(seq + 2); expect(raw.at(-1).event).toBe("session_interrupted");
    expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).state).toBe("interrupted");
  });
  it("rejects another listener using the same session directory without altering the live server", async () => {
    const app = await setup(); const session = await app.create();
    const second = new HarnessHttpServer(app.config);
    await expect(second.start()).rejects.toThrow("another server owns");
    await second.stop();
    expect((await app.request("ping")).data.sessions).toBe(1);
    const message = (await app.request("send_message", { session_id: session, text: "still-live" })).data.message_id;
    expect((await app.complete(session, message)).state).toBe("completed");
  });
  it.each([{ target: "local", runtime: "docker" }, { target: "remote", runtime: "direct" }, { target: "remote", runtime: "docker" }])("exercises supervisor launch and cleanup via local shims: $target/$runtime", async launch => {
    const docker = fileURLToPath(new URL("./fixtures/mock-docker.mjs", import.meta.url));
    const ssh = fileURLToPath(new URL("./fixtures/mock-ssh.mjs", import.meta.url));
    const app = await setup({ launch: { docker_command: docker, ssh_command: ssh }, timeouts: { remote_cleanup_timeout_seconds: 2, terminate_grace_seconds: 0.05 } });
    const log = join(app.directory, "docker.jsonl"); const sshLog = join(app.directory, "ssh.jsonl");
    vi.stubEnv("MOCK_DOCKER_LOG", log); vi.stubEnv("MOCK_SSH_LOG", sshLog);
    const created = await app.request("create_session", { cwd: app.directory, model_id: "fake-model", ...launch,
      ...(launch.target === "remote" ? { remote_host: "mock-host" } : {}),
      ...(launch.runtime === "docker" ? { docker_image: "mock/image:1", container_policy: "remove" } : {}) });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const session = created.data.session_id;
    const message = (await app.request("send_message", { session_id: session, text: "shim-ready" })).data.message_id;
    expect((await app.complete(session, message)).result.text).toBe("echo:shim-ready");
    await app.request("close_session", { session_id: session });
    if (launch.runtime === "docker") {
      const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).argv[0]);
      expect(commands).toContain("run"); expect(commands).toContain("exec"); expect(commands).toContain("rm");
    }
    if (launch.target === "remote") expect(readFileSync(sshLog, "utf8")).toContain("mock-host");
  });
  // Linux `/bin/sh` is dash, which refuses job control without a tty and would otherwise hand
  // the backgrounded harness `/dev/null` as stdin, detaching the ACP channel at creation time.
  // macOS `/bin/sh` is bash, so the shim has to be pinned to a real dash to cover it.
  const dashShell = existsSync("/bin/dash") ? "/bin/dash" : null;
  it.skipIf(dashShell === null)("keeps the remote ACP channel on a shell without job control (dash)", async () => {
    const ssh = fileURLToPath(new URL("./fixtures/mock-ssh.mjs", import.meta.url));
    const app = await setup({ launch: { ssh_command: ssh }, timeouts: { remote_cleanup_timeout_seconds: 2, terminate_grace_seconds: 0.05 } });
    const sshLog = join(app.directory, "ssh.jsonl");
    vi.stubEnv("MOCK_SSH_LOG", sshLog);
    vi.stubEnv("MOCK_SSH_SHELL", dashShell as string);
    const created = await app.request("create_session", { cwd: app.directory, model_id: "fake-model", target: "remote", remote_host: "mock-host" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const session = created.data.session_id;
    const message = (await app.request("send_message", { session_id: session, text: "dash-ready" })).data.message_id;
    expect((await app.complete(session, message)).result.text).toBe("echo:dash-ready");
    await app.request("close_session", { session_id: session });
    expect(readFileSync(sshLog, "utf8")).toContain("mock-host");
  });
});
