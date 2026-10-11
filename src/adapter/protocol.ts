/** ACP JSON-RPC and harness extensions. No scheduling, deadlines, or persistence. */
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { BridgeError, isRecord } from "../errors.js";
import { type AdapterClient, type HarnessAdapter } from "../adapters.js";
import { StdioTransport } from "../transport/stdio.js";

export const CLIENT_VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export type RpcId = string | number;
export interface RequestTicket {
  id: number;
  promise: Promise<Record<string, unknown>>;
  abandon(error: Error): void;
}
interface Pending {
  method: string;
  params: Record<string, unknown>;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}
export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  readonly detail: { raw: string; frame: Record<string, unknown> };
  constructor(frame: Record<string, unknown>, raw?: string) {
    const error = isRecord(frame.error) ? frame.error : {};
    super(typeof error.message === "string" ? error.message : "harness RPC error");
    this.code = typeof error.code === "number" ? error.code : -32603;
    this.detail = { raw: raw ?? JSON.stringify(frame), frame };
  }
}
/** Only deterministic envelope repairs; never rewrite the stored wire bytes. */
export function decodeLine(raw: Buffer): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw).trim(); }
  catch { throw new BridgeError("invalid_json", "invalid UTF-8 ACP JSONL", { raw_base64: raw.toString("base64") }); }
  text = text.replace(/^\uFEFF/, "").replace(/^(?:\x1b\[[0-?]*[ -/]*[@-~])+/, "").replace(/(?:\x1b\[[0-?]*[ -/]*[@-~])+$/, "").trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new BridgeError("invalid_json", "unrepairable ACP JSONL", { raw: raw.toString("utf8") }); }
}
export interface OutputEvent {
  type: "reasoning" | "answer" | "user" | "tool_call" | "tool_output" | "question" | "auth" | "session_options" | "unsupported";
  text: string;
  data?: unknown;
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("\n");
  if (!isRecord(content)) return "";
  if (typeof content.text === "string") return content.text;
  if (content.content !== undefined) return contentText(content.content);
  return JSON.stringify(content);
}
/** Shared semantic interpretation; preview invokes this directly from the raw journal. */
export function describeFrame(frame: unknown): OutputEvent[] {
  if (!isRecord(frame)) return [{ type: "unsupported", text: JSON.stringify(frame) }];
  if (frame.method === "session/update" && isRecord(frame.params?.update)) {
    const update = frame.params.update;
    const kind = update.sessionUpdate;
    if (["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(kind)) {
      return [{ type: kind === "agent_thought_chunk" ? "reasoning" : kind === "user_message_chunk" ? "user" : "answer", text: contentText(update.content) }];
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const events: OutputEvent[] = [];
      const data = { tool_call_id: update.toolCallId,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.content !== undefined ? { content: update.content } : {}),
        ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}) };
      events.push({ type: "tool_call", text: `${update.title ?? update.toolCallId ?? "Tool"}${update.status ? ` [${update.status}]` : ""}${update.rawInput !== undefined ? `\n${JSON.stringify(update.rawInput)}` : ""}`, data });
      if (update.content !== undefined || update.rawOutput !== undefined) {
        events.push({ type: "tool_output", text: contentText(update.content) || JSON.stringify(update.rawOutput), data });
      }
      return events;
    }
    if (["config_option_update", "current_mode_update", "available_commands_update", "plan", "usage_update", "session_info_update"].includes(kind)) {
      return [{ type: "session_options", text: JSON.stringify(update), data: update }];
    }
    return [{ type: "unsupported", text: JSON.stringify(frame) }];
  }
  if (["session/request_permission", "session/request_information", "elicitation/create"].includes(frame.method)) {
    return [{ type: "question", text: contentText(frame.params?.message ?? frame.params?.title ?? "Input required"), data: frame.params }];
  }
  if (frame.method === "_codebuddy.ai/authUrl") {
    // Only the exact CodeBuddy device/browser-login notification is an auth interaction; other
    // vendor/auth frames stay explicit unsupported traffic rather than being interpreted.
    return [{ type: "auth", text: JSON.stringify(frame.params), data: { method: frame.method, params: frame.params } }];
  }
  if (["_codebuddy.ai/command", "_codebuddy.ai/checkpoint"].includes(frame.method)) {
    return [{ type: "session_options", text: JSON.stringify(frame.params), data: frame.params }];
  }
  if (typeof frame.method === "string") return [{ type: "unsupported", text: JSON.stringify(frame) }];
  if ((typeof frame.id === "number" || typeof frame.id === "string") && ("result" in frame || "error" in frame)) return [];
  return [{ type: "unsupported", text: JSON.stringify(frame) }];
}

export interface Question {
  request_id: string;
  rpc_id: RpcId;
  kind: "permission" | "information" | "elicitation";
  title: string;
  message: string;
  options: Array<Record<string, unknown>>;
  schema: Record<string, unknown> | null;
  /** URL-mode elicitation target, when the harness asked for a `mode: "url"` elicitation. */
  url: string | null;
  /** `elicitation/create`'s `elicitationId`, used to revoke a stale question on completion. */
  elicitation_id: string | null;
  raw: Record<string, unknown>;
}
export class ProtocolAdapter extends EventEmitter {
  private nextId = 0;
  private pending = new Map<RpcId, Pending>();
  private ignored = new Set<RpcId>();
  sessionId: string | null = null;
  initializeResponse: Record<string, unknown> = {};
  options: Array<Record<string, unknown>> | null = null;
  modelId: string | null = null;
  reasoningEffort: string | null = null;
  constructor(readonly transport: StdioTransport, readonly harness: HarnessAdapter) {
    super();
    transport.on("line", raw => this.receive(raw));
    transport.on("exit", () => this.failAll(new BridgeError("transport_closed", "harness exited")));
  }
  client(execute: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>): AdapterClient {
    return { sessionId: () => this.sessionId, initializeResponse: () => this.initializeResponse,
      configOptions: () => this.options, modelId: () => this.modelId, reasoningEffort: () => this.reasoningEffort,
      request: execute };
  }
  beginRequest(method: string, params: Record<string, unknown>): RequestTicket {
    const id = ++this.nextId;
    let reject!: (error: Error) => void;
    const promise = new Promise<Record<string, unknown>>((resolve, rejectPromise) => {
      reject = rejectPromise;
      this.pending.set(id, { method, params, resolve, reject });
    });
    void promise.catch(() => undefined);
    void this.send({ jsonrpc: "2.0", id, method, params }).catch(error => {
      this.pending.delete(id); reject(error);
    });
    return { id, promise, abandon: error => { if (this.pending.delete(id)) { this.ignored.add(id); reject(error); } } };
  }
  send(frame: Record<string, unknown>): Promise<void> {
    return this.transport.write(Buffer.from(`${JSON.stringify(frame)}\n`));
  }
  notify(method: string, params: Record<string, unknown>): Promise<void> { return this.send({ jsonrpc: "2.0", method, params }); }
  failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private unsupported(raw: Buffer, frame: unknown, kind = "unsupported_response"): void {
    this.emit("unsupported", { code: kind, raw: raw.toString("utf8"), frame });
  }
  private receive(raw: Buffer): void {
    let frame: unknown;
    try { frame = decodeLine(raw); }
    catch (error) { this.emit("fault", error); return; }
    if (frame === null) return;
    if (!isRecord(frame)) { this.unsupported(raw, frame); return; }
    const id = frame.id;
    if ((typeof id === "string" || typeof id === "number") && ("result" in frame || "error" in frame) && !frame.method) {
      if (this.ignored.delete(id)) return;
      const pending = this.pending.get(id);
      if (!pending) { this.unsupported(raw, frame); return; }
      this.pending.delete(id);
      if ("error" in frame) {
        if (!isRecord(frame.error) || "result" in frame) pending.reject(new BridgeError("unsupported_response", "unsupported RPC error response", { raw: raw.toString("utf8") }));
        else pending.reject(new RpcError(frame, raw.toString("utf8")));
        return;
      }
      const result = frame.result;
      if (frame.jsonrpc !== "2.0" || !isRecord(result) || (pending.method === "initialize" && result.protocolVersion !== 1) ||
          (["session/new", "session/load"].includes(pending.method) && typeof result.sessionId !== "string") ||
          (pending.method === "session/prompt" && typeof result.stopReason !== "string")) {
        pending.reject(new BridgeError("unsupported_response", `unsupported response to ${pending.method}`, { raw: raw.toString("utf8") }));
        return;
      }
      if (pending.method === "initialize") this.initializeResponse = frame;
      if (["session/new", "session/load"].includes(pending.method)) this.sessionId = result.sessionId;
      if (pending.method === "session/set_model" || (pending.method === "session/set_config_option" && pending.params.configId === "model")) {
        this.options = null; this.reasoningEffort = null;
        this.modelId = String(pending.params.modelId ?? pending.params.value);
      }
      if (Array.isArray(result.configOptions)) this.options = result.configOptions.filter(isRecord);
      if (typeof result.modelId === "string") this.modelId = result.modelId;
      if (typeof result.models?.currentModelId === "string") this.modelId = result.models.currentModelId;
      this.readOptions();
      pending.resolve(frame);
      return;
    }
    if (typeof frame.method !== "string") { this.unsupported(raw, frame); return; }
    if (frame.method === "elicitation/complete") {
      // A completion is a NOTIFICATION. A request carrying an id is unexpected and must be rejected
      // (never silently treated as a notification, which would hang the harness).
      if (typeof id === "number" || typeof id === "string") {
        this.unsupported(raw, frame, "unsupported_request");
        void this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported request", data: { raw: raw.toString("utf8") } } }).catch(error => this.emit("fault", error));
        return;
      }
      // The harness signals a URL elicitation it raised earlier is done; any still-pending
      // question for that id is stale and must be withdrawn, never answered.
      const elicitationId = isRecord(frame.params) && typeof frame.params.elicitationId === "string" ? frame.params.elicitationId : null;
      if (elicitationId) this.emit("question_stale", { elicitation_id: elicitationId });
      return;
    }
    if (typeof id === "number" || typeof id === "string") {
      const kind = frame.method === "session/request_permission" ? "permission" : frame.method === "session/request_information" ? "information" : frame.method === "elicitation/create" ? "elicitation" : null;
      const mode = kind === "elicitation" && isRecord(frame.params) && typeof frame.params.mode === "string" ? frame.params.mode : "form";
      if (!kind || !isRecord(frame.params) || (kind === "elicitation" && mode !== "form" && mode !== "url")) {
        this.unsupported(raw, frame, "unsupported_request");
        void this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported request", data: { raw: raw.toString("utf8") } } }).catch(error => this.emit("fault", error));
        return;
      }
      const params = frame.params;
      const urlMode = kind === "elicitation" && mode === "url";
      this.emit("question", { request_id: String(id), rpc_id: id, kind,
        title: contentText(params.title ?? params.toolCall?.title ?? "Input required"), message: contentText(params.message ?? ""),
        options: Array.isArray(params.options) ? params.options.filter(isRecord) : [],
        schema: isRecord(params.requestedSchema) ? params.requestedSchema : null,
        // `url`/`elicitation_id` are populated ONLY for an explicit `mode: "url"` elicitation, so a
        // form elicitation that happens to carry a url is never mistaken for a browser login.
        url: urlMode && typeof params.url === "string" ? params.url : null,
        elicitation_id: urlMode && typeof params.elicitationId === "string" ? params.elicitationId : null,
        raw: frame } satisfies Question);
      return;
    }
    const events = describeFrame(frame);
    for (const event of events) {
      if (event.type === "unsupported") this.unsupported(raw, frame, "unsupported_notification");
      else this.emit("output", event);
    }
    if (frame.method === "session/update" && frame.params?.update?.sessionUpdate === "config_option_update") {
      this.options = frame.params.update.configOptions ?? this.options; this.readOptions();
    }
  }
  private readOptions(): void {
    for (const option of this.options ?? []) {
      if ((option.id ?? option.configId) === "model" && typeof option.currentValue === "string") this.modelId = option.currentValue;
      if ((option.id ?? option.configId) === "reasoning_effort" && typeof option.currentValue === "string") this.reasoningEffort = option.currentValue;
    }
  }
  answer(question: Question, answer: string, optionId: string | null, content: Record<string, unknown> | null): Promise<void> {
    let result: Record<string, unknown>;
    if (question.kind === "permission") {
      if (answer === "accept") {
        if (!optionId || !question.options.some(option => option.optionId === optionId)) throw new BridgeError("invalid_option", "option_id is not offered by the harness");
        result = { outcome: { outcome: "selected", optionId } };
      } else if (answer === "reject") {
        const reject = question.options.find(option => String(option.kind).startsWith("reject"));
        result = reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
      } else result = { outcome: { outcome: "cancelled" } };
    } else if (question.kind === "elicitation" && question.elicitation_id !== null) {
      // URL-mode elicitation carries no form data: only the action is echoed back (the harness is
      // still waiting for the out-of-band browser round-trip to finish before login completes).
      result = { action: answer === "accept" ? "accept" : answer === "reject" ? "decline" : "cancel" };
    } else {
      if (answer === "accept" && !content) throw new BridgeError("invalid_answer", "content must be an object");
      if (answer === "accept" && question.schema) validateObjectSchema(question.schema, content!);
      result = { ...(question.kind === "elicitation" ? { action: answer === "accept" ? "accept" : answer === "reject" ? "decline" : "cancel" } : {}), content: content ?? {} };
    }
    return this.send({ jsonrpc: "2.0", id: question.rpc_id, result });
  }
}

/**
 * Deterministic validator for the object schemas ACP uses for form questions.
 *
 * It validates the constraints the bridge understands (object/string/number/integer/boolean/array
 * types, required, additionalProperties, enum/const, minLength/maxLength/pattern, numeric bounds,
 * items/min/maxItems, and allOf/anyOf/oneOf). A schema using a constraint it cannot honor is
 * rejected explicitly, so an invalid manual answer is never silently emitted to the harness.
 */
const UNSUPPORTED_SCHEMA_KEYS = ["$ref", "$defs", "definitions", "not", "if", "then", "else", "dependentSchemas", "patternProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "contains"];
export function validateObjectSchema(schema: Record<string, unknown>, content: Record<string, unknown>): void {
  checkSchema(schema, content, "content");
}
function checkSchema(schema: Record<string, unknown>, value: unknown, path: string): void {
  if (!isRecord(schema)) throw new BridgeError("unsupported_request", "question schema must be an object");
  for (const key of UNSUPPORTED_SCHEMA_KEYS) if (schema[key] !== undefined) throw new BridgeError("unsupported_request", `question schema uses unsupported keyword ${key}`);
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) checkSchema(sub as Record<string, unknown>, value, path);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(sub => matchesSchema(sub, value))) throw new BridgeError("invalid_answer", `${path} does not match any allowed shape`);
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(sub => matchesSchema(sub, value)).length !== 1) throw new BridgeError("invalid_answer", `${path} does not match exactly one allowed shape`);
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) throw new BridgeError("invalid_option", `${path} is not an offered value`);
  if ("const" in schema && !Object.is(schema.const, value)) throw new BridgeError("invalid_option", `${path} is not the required value`);
  const type = schema.type;
  if (type !== undefined && typeof type !== "string") throw new BridgeError("unsupported_request", "question schema type must be a string");
  const objectish = type === "object" || (type === undefined && ("properties" in schema || "required" in schema || "additionalProperties" in schema));
  if (objectish) {
    if (!isRecord(value)) throw new BridgeError("invalid_answer", `${path} must be an object`);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
    for (const name of required) if (!(name in value)) throw new BridgeError("invalid_answer", `${name} is required`);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).filter(name => !(name in properties));
      if (unknown.length) throw new BridgeError("invalid_answer", `unsupported answer field(s): ${unknown.join(", ")}`);
    }
    for (const [name, item] of Object.entries(value)) {
      const rule = properties[name];
      if (rule !== undefined) checkSchema(rule as Record<string, unknown>, item, name);
    }
    return;
  }
  if (type === undefined) return;
  switch (type) {
    case "array": {
      if (!Array.isArray(value)) throw new BridgeError("invalid_answer", `${path} must be an array`);
      if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new BridgeError("invalid_answer", `${path} needs at least ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new BridgeError("invalid_answer", `${path} allows at most ${schema.maxItems} items`);
      if (schema.items !== undefined) for (const item of value) checkSchema(schema.items as Record<string, unknown>, item, `${path}[]`);
      return;
    }
    case "string": {
      if (typeof value !== "string") throw new BridgeError("invalid_answer", `${path} must be a string`);
      if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new BridgeError("invalid_answer", `${path} is shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new BridgeError("invalid_answer", `${path} is longer than ${schema.maxLength}`);
      if (typeof schema.pattern === "string") {
        let pattern: RegExp;
        try { pattern = new RegExp(schema.pattern); }
        catch { throw new BridgeError("unsupported_request", `${path} has an invalid pattern`); }
        if (!pattern.test(value)) throw new BridgeError("invalid_answer", `${path} does not match the required pattern`);
      }
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new BridgeError("invalid_answer", `${path} must be a number`);
      if (type === "integer" && !Number.isInteger(value)) throw new BridgeError("invalid_answer", `${path} must be an integer`);
      if (typeof schema.minimum === "number" && value < schema.minimum) throw new BridgeError("invalid_answer", `${path} is below the minimum`);
      if (typeof schema.maximum === "number" && value > schema.maximum) throw new BridgeError("invalid_answer", `${path} is above the maximum`);
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) throw new BridgeError("invalid_answer", `${path} must be above the exclusive minimum`);
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) throw new BridgeError("invalid_answer", `${path} must be below the exclusive maximum`);
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") throw new BridgeError("invalid_answer", `${path} must be a boolean`);
      return;
    }
    case "null": {
      if (value !== null) throw new BridgeError("invalid_answer", `${path} must be null`);
      return;
    }
    default: throw new BridgeError("unsupported_request", `unsupported question schema type: ${type}`);
  }
}
function matchesSchema(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  try { checkSchema(schema, value, "value"); return true; } catch { return false; }
}
