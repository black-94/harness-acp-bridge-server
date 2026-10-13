#!/usr/bin/env node
/**
 * Deterministic fake ACP harness used by the end-to-end tests.
 *
 * It speaks newline-delimited JSON-RPC over stdio and implements just enough of ACP:
 * initialize, session/new, session/set_model, session/prompt, session/cancel, and one
 * permission request plus one information request. Prompt text drives the behaviour:
 *
 *   contains "HOLD"        -> delay completion so a caller can steer/cancel mid-turn
 *   contains "HANG"        -> never complete (drives the bridge's turn timeout)
 *   contains "bad-json"    -> emit a non-JSON stdout line
 *   contains "bad-object"  -> emit valid JSON that is not a JSON-RPC object
 *   contains "bad-rpc"     -> emit an unrecognized JSON-RPC notification
 *   contains "bad-response"-> emit a response for a request id the bridge never sent
 *   contains "oversize-soft" -> emit one line over max_read_bytes
 *   contains "oversize-hard" -> emit one line far over the discard budget
 *   contains "permission"  -> ask for permission and finish only after the answer
 *   contains "info"        -> ask for information and finish only after the answer
 *   contains "elicit-url"  -> request an explicit url-mode elicitation
 *   contains "elicit-form" -> request an explicit form-mode elicitation
 *   contains "elicit"      -> request a legacy (mode-less) form elicitation
 *   otherwise              -> stream `echo:<text>` and complete immediately
 *
 * `--emit-garbage` writes a non-JSON line at startup, before the ACP handshake.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const FLAGS = new Set(process.argv.slice(2));
/** `--auth-hang` accepts `authenticate` but never answers, to test the auth timeout. */
const AUTH_HANG = FLAGS.has("--auth-hang");
/**
 * `--emit-garbage` writes a non-JSON line immediately, so `initialize` can never complete and
 * the bridge must fail the session creation with `invalid_json`.
 */
const EMIT_GARBAGE = FLAGS.has("--emit-garbage");
/**
 * `--auth-required` makes the harness advertise login and report an unauthenticated status.
 * `--auth-hang` implies it (a hanging login only makes sense on a login-gated harness).
 * `--auth-methods` advertises a richer, behaviour-per-method set used by the flow tests.
 */
const AUTH_METHODS = FLAGS.has("--auth-methods");
/**
 * `--external-auth` models a login completed outside the bridge: the status probe starts reporting
 * authenticated after a short delay while the harness session is still unopened.
 */
const EXTERNAL_AUTH = FLAGS.has("--external-auth");
/** `--status-auth-32000` makes the status probe report an explicit ACP -32000 until logged in. */
const STATUS_32000 = FLAGS.has("--status-auth-32000");
const AUTH_REQUIRED = FLAGS.has("--auth-required") || AUTH_HANG || AUTH_METHODS || EXTERNAL_AUTH || STATUS_32000;

// When set, long-lived child in the harness's process group, with its pid recorded so a test
// can assert the whole group is reaped when the daemon dies.
const CHILD_PID_FILE = process.env.FAKE_HARNESS_CHILD_PID_FILE;
if (CHILD_PID_FILE) {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  child.unref();
  writeFileSync(CHILD_PID_FILE, `${child.pid}\n`);
}

if (EMIT_GARBAGE) process.stdout.write("this is not json\n");

let buffer = "";
let sessionId = "fake-1";
const modelArg = process.argv.indexOf("--model");
let model = modelArg >= 0 ? process.argv[modelArg + 1] ?? "fake-model" : "fake-model";
let permissionRequestId = 9000;
let infoRequestId = 9100;
let elicitRequestId = 9200;
let pendingPrompt = null;
let pendingPermission = null;
let pendingInfo = null;
let pendingElicitation = null;
/** In-flight `authenticate` for the `--auth-methods` flow, with its reverse interaction. */
let pendingAuth = null;
let pendingAuthInfo = null;
let authRequestId = 9300;
let authenticated = !AUTH_REQUIRED;
let optionsHang = FLAGS.has("--options-hang");
/**
 * When set, record every received prompt text verbatim. This is the harness's own proof that the
 * bridge delivered the ORIGINAL credential bytes on the wire (before any on-disk redaction).
 */
const PROMPT_FILE = process.env.FAKE_HARNESS_PROMPT_FILE;
/** Records every `authenticate` method id, proving the bridge did not write credentials. */
const AUTH_FILE = process.env.FAKE_HARNESS_AUTH_FILE;
/** Records the exact auth answer content the harness received (the original wire bytes). */
const ANSWER_FILE = process.env.FAKE_HARNESS_ANSWER_FILE;
/** Harness-side proof of proxy-env delivery; the shim does not connect to a live proxy. */
if (process.env.FAKE_HARNESS_PROXY_FILE) {
  writeFileSync(process.env.FAKE_HARNESS_PROXY_FILE, JSON.stringify({
    http_proxy: process.env.http_proxy ?? "", https_proxy: process.env.https_proxy ?? "", no_proxy: process.env.no_proxy ?? "",
  }));
}

// An externally completed login: the status probe starts reporting authenticated shortly after
// startup, while the harness session is still unopened.
if (EXTERNAL_AUTH) {
  const timer = setTimeout(() => { authenticated = true; }, 200);
  timer.unref?.();
}

const AVAILABLE_MODELS = [
  { modelId: "fake-model", name: "Fake Model" },
  { modelId: "fake-model-2", name: "Fake Model 2" },
];

/** Advertise per-model capabilities without relying on bridge YAML candidate lists. */
function liveThinkingOptions() {
  return [
    { id: "model", currentValue: model, options: AVAILABLE_MODELS.map(entry => ({ value: entry.modelId, name: entry.name })) },
    ...["thought_level", "reasoning_effort", "thinking_level"].map(id => ({
      id, currentValue: "low",
      options: (model === "fake-model-2" ? ["low"] : ["low", "high"]).map(value => ({ value })),
    })),
  ];
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function update(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { update } });
}
function chunk(text) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}
function finishPrompt(promptId, stopReason) {
  if (pendingPrompt && pendingPrompt.id === promptId) pendingPrompt.done = true;
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason } });
}

function startPrompt(id, text) {
  pendingPrompt = { id, text, done: false, timer: null };
  if (PROMPT_FILE) appendFileSync(PROMPT_FILE, `${text}\n`);
  // Close the ACP read channel but keep the process alive: the bridge must converge on stdout
  // EOF rather than waiting for a process exit. (Must run before any stdout write.)
  if (text.includes("CLOSE_STDOUT")) {
    setInterval(() => {}, 1000);
    process.stdout.end();
    return;
  }
  // Final prompt response written WITHOUT a trailing newline, then the channel closes while the
  // process stays alive: only the daemon's EOF delivery can parse it.
  if (text.includes("FINAL_NO_NEWLINE")) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    setInterval(() => {}, 1000);
    process.stdout.end();
    return;
  }
  // A truncated JSON tail at EOF: the malformed-final-frame contract must fail the message.
  if (text.includes("PARTIAL_JSON")) {
    process.stdout.write(`{"jsonrpc":"2.0","id":${id},"result":{"stopReason"`);
    setInterval(() => {}, 1000);
    process.stdout.end();
    return;
  }
  // Usage/idle heartbeats with no model progress, then a real answer chunk and completion.
  if (text.includes("USAGE_THEN_TEXT")) {
    let beats = 0;
    const timer = setInterval(() => {
      update({ sessionUpdate: "usage_update", used: 1, size: 100 });
      if (++beats >= 6) { clearInterval(timer); chunk(" real-progress"); finishPrompt(id, "end_turn"); }
    }, 50);
    timer.unref?.();
    return;
  }
  if (text.includes("FORCE_EXIT")) process.exit(3);
  // Never emit anything and never finish: a running message with zero observed progress.
  if (text.includes("SILENT_HANG")) return;
  if (text.includes("arm-options-hang")) optionsHang = true;
  const echo = `echo:${text}`;
  const middle = Math.ceil(echo.length / 2);
  chunk(echo.slice(0, middle));
  chunk(echo.slice(middle));

  if (text.includes("unknown-notice")) {
    send({ jsonrpc: "2.0", method: "vendor/notice", params: { token: "raw-original-token", value: "通知原文" } });
    chunk(" after-unknown"); finishPrompt(id, "end_turn"); return;
  }
  if (text.includes("unknown-request")) {
    send({ jsonrpc: "2.0", id: 9400, method: "vendor/request", params: { custom: true } });
    chunk(" after-request"); finishPrompt(id, "end_turn"); return;
  }
  if (text.includes("reasoning-tools")) {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "正在分析问题😀" } });
    update({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file", status: "in_progress", rawInput: { path: "example.ts" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: { value: 42 }, content: [{ type: "content", content: { type: "text", text: "工具输出结果" } }] });
    finishPrompt(id, "end_turn"); return;
  }
  if (text.includes("repair-json")) {
    const frame = { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "repaired😀" } } } };
    process.stdout.write("\ufeff\x1b[32m" + JSON.stringify(frame) + "\x1b[0m\r\n");
    finishPrompt(id, "end_turn"); return;
  }
  if (text.includes("unsupported-result")) {
    send({ jsonrpc: "2.0", id, result: { vendorFinal: true } }); return;
  }
  // A structure carrying every sensitive-field shape (string/number/null/object/array), plus
  // non-sensitive neighbours that must survive (public_key, max_tokens, token_count, ids) and an
  // embedded PEM, an escaped-JSON body credential, and a plain UTF-8/emoji/BOM field.
  //
  // The opaque children (`label`, `other`, `cookie` items) are deliberately NOT sensitive-named:
  // masking must follow the sensitive PARENT key and replace the whole subtree, not just children
  // whose own names happen to look sensitive.
  if (text.includes("privacy-fields")) {
    send({ jsonrpc: "2.0", method: "vendor/privacy", params: {
      password: "pw-sentinel-aaa",
      token: 424242,
      secret: null,
      credentials: { label: "api-sentinel-ddd", nested: { other: "rt-sentinel-bbb" } },
      cookie: ["at-sentinel-ccc"],
      list: [{ note: "ordinary text" }],
      public_key: "public-key-value-kept",
      max_tokens: 100,
      token_count: 5,
      session_id: "sess-keep-1",
      body: "prefix {\"token\":\"escaped-body-token-987654\"} suffix 😀",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpem-body-SENTINEL-eee\n-----END RSA PRIVATE KEY-----",
      value: "普通正文😀 \ufeff"
    } });
    chunk(" done-privacy");
    finishPrompt(id, "end_turn"); return;
  }
  // An unsupported response whose credential lives in a sensitive field: the persisted error
  // detail must be redacted while the non-sensitive marker survives.
  if (text.includes("privacy-error")) {
    send({ jsonrpc: "2.0", id, result: { vendorFinal: true, token: "err-sentinel-fff" } }); return;
  }
  if (text.includes("HOLD")) {
    pendingPrompt.timer = setTimeout(() => {
      if (pendingPrompt && pendingPrompt.id === id && !pendingPrompt.done) {
        finishPrompt(id, "end_turn");
      }
    }, 3000);
    pendingPrompt.timer.unref?.();
    return;
  }

  if (text.includes("HANG")) {
    // Never answer: the bridge's turn timeout must fire.
    return;
  }

  if (text.includes("bad-json")) {
    process.stdout.write("this is not json\n");
    return;
  }

  if (text.includes("bad-object")) {
    process.stdout.write("42\n");
    return;
  }

  if (text.includes("bad-rpc")) {
    send({ jsonrpc: "2.0", method: "bogus/notification", params: {} });
    return;
  }

  if (text.includes("bad-response")) {
    // A response for an id the bridge never sent: a residual/unrelated frame.
    send({ jsonrpc: "2.0", id: 424242, result: {} });
    return;
  }

  if (text.includes("oversize-soft")) {
    // Over max_read_bytes but within the discard budget: one discarded line.
    process.stdout.write(`${"s".repeat(20 * 1024)}\n`);
    return;
  }

  if (text.includes("oversize-hard")) {
    // Far over the discard budget: the transport must give up.
    process.stdout.write(`${"h".repeat(256 * 1024)}\n`);
    return;
  }

  if (text.includes("permission")) {
    const requestId = permissionRequestId++;
    pendingPermission = { requestId, promptId: id };
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        message: "Allow this action?",
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny_once", name: "Deny", kind: "reject_once" },
        ],
        toolCall: {
          toolCallId: "tool-1",
          title: "do a thing",
          rawInput: { path: "/tmp/example" },
          _meta: { "codebuddy.ai/toolName": "do_thing" },
        },
      },
    });
    return;
  }

  if (text.includes("info")) {
    const requestId = infoRequestId++;
    pendingInfo = { requestId, promptId: id };
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_information",
      params: {
        sessionId,
        title: "Need information",
        message: "What value?",
        requestedSchema: { type: "object" },
      },
    });
    return;
  }

  if (text.includes("elicit-url")) {
    const requestId = elicitRequestId++;
    pendingElicitation = { requestId, promptId: id };
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "elicitation/create",
      params: {
        sessionId,
        mode: "url",
        elicitationId: `elicit-${requestId}`,
        url: "https://example.test/authorize",
        message: "Open the URL to continue",
      },
    });
    return;
  }

  if (text.includes("elicit-form")) {
    const requestId = elicitRequestId++;
    pendingElicitation = { requestId, promptId: id };
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "elicitation/create",
      params: {
        sessionId,
        mode: "form",
        message: "Pick a value",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    return;
  }

  if (text.includes("elicit")) {
    // Legacy/MCP-style request without the stabilized explicit `mode`.
    const requestId = elicitRequestId++;
    pendingElicitation = { requestId, promptId: id };
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "elicitation/create",
      params: {
        sessionId,
        title: "Need input",
        message: "Pick a value",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    return;
  }

  finishPrompt(id, "end_turn");
}

// --- interactive authentication (`--auth-methods`) ---------------------------
// Each advertised method drives a different real login shape so the bridge's normalization
// (method selection, URL elicitation, token input, stderr URL) can be exercised deterministically.

function finishAuth(success) {
  if (!pendingAuth) return;
  authenticated = success;
  const id = pendingAuth.id;
  pendingAuth = null; pendingAuthInfo = null;
  reply(id, { authenticated: success });
}
function sendAuthInfo(stage) {
  const requestId = authRequestId++;
  let schema, title, message;
  if (stage === 1 || stage === 4) { schema = { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false }; title = "Choose account"; message = "Which account?"; }
  else if (stage === 2) { schema = { type: "object", properties: { token: { type: "string", minLength: 8 } }, required: ["token"], additionalProperties: false }; title = "Enter token"; message = "Paste the token"; }
  else {
    // Credential-shaped fields proving values named code/response/answer are never persisted, while
    // the exact bytes still reach the harness.
    schema = { type: "object", properties: {
      code: { type: "string", minLength: 4 },
      response: { type: "string" },
      answer: { type: "string" },
      retries: { type: "integer", minimum: 0, maximum: 5 },
    }, required: ["code"], additionalProperties: false };
    title = "Credential codes"; message = "Provide the credential fields";
  }
  pendingAuthInfo = { requestId, stage };
  send({ jsonrpc: "2.0", id: requestId, method: "session/request_information",
    params: { sessionId, title, message, requestedSchema: schema } });
}
function startAuth(methodId) {
  if (methodId === "token") { sendAuthInfo(1); return; }
  if (methodId === "approve") {
    // A permission question must be answerable with an offered option and NO content, followed by
    // an information question (the permission-then-information auth loop).
    const requestId = authRequestId++;
    if (pendingAuth) pendingAuth.permRequestId = requestId;
    send({ jsonrpc: "2.0", id: requestId, method: "session/request_permission",
      params: { sessionId, message: "Allow the login helper?", options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny_once", name: "Deny", kind: "reject_once" } ] } });
    return;
  }
  if (methodId === "codes") { sendAuthInfo(3); return; }
  if (methodId === "device") {
    const requestId = authRequestId++;
    if (pendingAuth) pendingAuth.elicitRequestId = requestId;
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "elicitation/create",
      params: { sessionId, mode: "url", elicitationId: "device-1", url: "https://example.test/device",
        message: "Sign in to ChatGPT and enter this code: ABCD-1234" },
    });
    return;
  }
  if (methodId === "browser") {
    // The Agy-style loopback login: URL on stderr, then the login completes later. The delay
    // proves that acknowledging the browser step is not itself success.
    process.stderr.write("Open the following link to authenticate the ACP server: https://example.test/oauth\n");
    const timer = setTimeout(() => finishAuth(true), 600);
    timer.unref?.();
    return;
  }
  // `api-key` (and any unknown method) succeed immediately.
  finishAuth(true);
}

function handle(message) {
  if (message.method === "initialize") {
    if (FLAGS.has("--handshake-hang")) return;
    if (FLAGS.has("--initialize-auth-required")) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "login required before initialize" } });
      return;
    }
    const authMethods = !AUTH_REQUIRED ? [] : AUTH_METHODS
      ? [
          { id: "api-key", name: "API key", description: "Use an API key" },
          { id: "token", name: "Token" },
          { id: "approve", name: "Approve" },
          { id: "device", name: "Device code" },
          { id: "browser", name: "Browser" },
          { id: "codes", name: "Credential codes" },
          { id: "client-code", name: "Client code", type: "client" },
        ]
      : [{ id: "api-key", name: "API key" }];
    reply(message.id, {
      protocolVersion: 1,
      ...(FLAGS.has("--null-agent-info") ? { agentInfo: null } : !FLAGS.has("--no-agent-info")
        ? { agentInfo: { name: process.argv.find(arg => arg.startsWith("--fake-agent="))?.split("=")[1] ?? "codebuddy", version: "test" } } : {}),
      // A real loadSession-capable harness advertises the capability the bridge restores against.
      agentCapabilities: { loadSession: true },
      authMethods,
      models: { currentModelId: model, availableModels: AVAILABLE_MODELS },
    });
    return;
  }
  if (message.method === "authenticate") {
    if (AUTH_FILE) appendFileSync(AUTH_FILE, `${message.params?.methodId ?? "?"}\n`);
    if (AUTH_HANG) return; // never reply: the bridge's authentication timeout must fire
    if (FLAGS.has("--auth-result-false")) { reply(message.id, { success: false }); return; }
    if (!AUTH_METHODS) {
      authenticated = true;
      reply(message.id, { authenticated: true });
      return;
    }
    pendingAuth = { id: message.id, methodId: message.params?.methodId, elicitRequestId: null, permRequestId: null };
    startAuth(message.params?.methodId);
    return;
  }
  // Auth-status probes: the base adapter uses `authentication/status`, CodeBuddy uses its
  // own `_codebuddy.ai/getUserInfo`. Both report the real login state.
  if (message.method === "authentication/status") {
    if (!AUTH_REQUIRED) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
      return;
    }
    if (STATUS_32000 && !authenticated) {
      // A genuine auth-required at session setup, expressed as ACP -32000 rather than a status.
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "authentication required", data: { code: "authentication_required" } } });
      return;
    }
    reply(message.id, { authenticated, kind: authenticated ? "api-key" : "none" });
    return;
  }
  if (message.method === "_codebuddy.ai/getUserInfo") {
    reply(message.id, {
      userInfo: authenticated
        ? { userId: "u-1", email: "user@example.com", name: "Test User", token: "live-secret-token" }
        : {},
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    if (optionsHang) return;
    if (message.params?.configId === "model") {
      model = message.params.value;
      reply(message.id, { configOptions: [
        { id: "model", currentValue: model, options: AVAILABLE_MODELS.map(entry => ({ value: entry.modelId, name: entry.name })) },
        { id: "reasoning_effort", currentValue: "low", options: (model === "fake-model-2" ? ["low"] : ["low", "high"]).map(value => ({ value })) },
      ] });
    } else {
      reply(message.id, { configId: message.params?.configId, value: message.params?.value });
    }
    return;
  }
  if (message.method === "session/set_mode") {
    reply(message.id, { modeId: message.params?.modeId });
    return;
  }
  if (message.method === "session/new") {
    reply(message.id, { sessionId, ...(FLAGS.has("--live-thinking-options") ? { configOptions: liveThinkingOptions() } : {}) });
    return;
  }
  if (message.method === "session/load") {
    // ACP `session/load` adopts the requested session and answers with a canonical, id-less result
    // (`{}`). The bridge must take the restored id from its own request, not this response.
    sessionId = message.params?.sessionId ?? sessionId;
    reply(message.id, {});
    return;
  }
  if (message.method === "session/set_model") {
    // A synchronous adapter RPC that reports an explicit auth-required via ACP -32000.
    if (FLAGS.has("--set-model-auth-32000")) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "authentication required", data: { code: "authentication_required" } } });
      return;
    }
    model = message.params?.modelId ?? model;
    reply(message.id, { modelId: model, ...(FLAGS.has("--live-thinking-options") ? { configOptions: liveThinkingOptions() } : {}) });
    return;
  }
  if (message.method === "session/prompt") {
    startPrompt(message.id, message.params?.prompt?.[0]?.text ?? "");
    return;
  }
  if (message.method === "session/cancel") {
    if (pendingPrompt?.text?.includes("IGNORE_CANCEL")) return;
    if (pendingPrompt && !pendingPrompt.done) {
      clearTimeout(pendingPrompt.timer);
      finishPrompt(pendingPrompt.id, "cancelled");
    }
    pendingPrompt = null;
    pendingPermission = null;
    pendingInfo = null;
    pendingElicitation = null;
    pendingAuth = null;
    pendingAuthInfo = null;
    return;
  }

  // Response to an auth token/account/credential information request (`--auth-methods`).
  if (pendingAuthInfo && message.id === pendingAuthInfo.requestId) {
    const stage = pendingAuthInfo.stage;
    pendingAuthInfo = null;
    if (stage === 3) {
      // The harness's own proof it received the ORIGINAL answer bytes on the wire.
      if (ANSWER_FILE) appendFileSync(ANSWER_FILE, `${JSON.stringify(message.result?.content ?? {})}\n`);
      finishAuth(true);
      return;
    }
    if (stage === 1) sendAuthInfo(2);
    else finishAuth(true);
    return;  }

  // Response to the auth permission question: an offered option id, then the info step.
  if (pendingAuth && pendingAuth.permRequestId === message.id) {
    const optionId = message.result?.outcome?.optionId ?? null;
    if (optionId === "allow_once") sendAuthInfo(4);
    else finishAuth(false);
    return;
  }

  // Response to the device-code URL elicitation: accepting continues the login, declining fails it.
  if (pendingAuth && pendingAuth.elicitRequestId === message.id) {
    finishAuth(message.result?.action === "accept");
    return;
  }

  // Response to our permission request.
  if (pendingPermission && message.id === pendingPermission.requestId) {
    const outcome = message.result?.outcome ?? {};
    const promptId = pendingPermission.promptId;
    pendingPermission = null;
    if (outcome.outcome === "cancelled") {
      chunk(" [permission-cancelled]");
      finishPrompt(promptId, "cancelled");
      return;
    }
    const optionId = outcome.optionId ?? "unknown";
    chunk(optionId.startsWith("deny") ? ` [denied:${optionId}]` : ` [allowed:${optionId}]`);
    finishPrompt(promptId, "end_turn");
    return;
  }

  // Response to our information request.
  if (pendingInfo && message.id === pendingInfo.requestId) {
    const content = message.result?.content ?? {};
    const promptId = pendingInfo.promptId;
    pendingInfo = null;
    chunk(` [info:${JSON.stringify(content)}]`);
    finishPrompt(promptId, "end_turn");
    return;
  }

  // Response to our elicitation request: accept carries content, decline refuses this one
  // request, and cancel withdraws the whole elicitation (the turn ends cancelled).
  if (pendingElicitation && message.id === pendingElicitation.requestId) {
    const action = message.result?.action ?? "unknown";
    const promptId = pendingElicitation.promptId;
    pendingElicitation = null;
    if (action === "accept") {
      chunk(` [elicited:${JSON.stringify(message.result?.content ?? {})}]`);
      finishPrompt(promptId, "end_turn");
      return;
    }
    if (action === "decline") {
      chunk(" [elicit-declined]");
      finishPrompt(promptId, "end_turn");
      return;
    }
    chunk(" [elicit-cancelled]");
    finishPrompt(promptId, "cancelled");
    return;
  }

  if (typeof message.id === "number" && message.method) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unknown method ${message.method}` },
    });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (input) => {
  buffer += input;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
