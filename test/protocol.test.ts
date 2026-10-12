/**
 * Unit coverage for the adapter's protocol edges that the auth review flagged: form-schema
 * validation, URL-elicitation mode gating, `elicitation/complete` notifications vs requests, and
 * the exact vendor-auth notification classification.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { ProtocolAdapter, describeFrame, validateObjectSchema, type Question } from "../src/acp/protocol";

class FakeTransport extends EventEmitter {
  readonly written: Record<string, unknown>[] = [];
  write(raw: Buffer): Promise<void> {
    this.written.push(JSON.parse(raw.toString("utf8")));
    return Promise.resolve();
  }
}

function adapter(): { transport: FakeTransport; protocol: ProtocolAdapter; questions: any[]; stale: string[]; outputs: any[] } {
  const transport = new FakeTransport();
  const protocol = new ProtocolAdapter(transport as any, {} as any);
  const questions: any[] = [];
  const stale: string[] = [];
  const outputs: any[] = [];
  protocol.on("question", question => questions.push(question));
  protocol.on("question_stale", value => stale.push(value.elicitation_id));
  protocol.on("output", event => outputs.push(event));
  return { transport, protocol, questions, stale, outputs };
}

describe("validateObjectSchema", () => {
  it("enforces required, type, enum, and additionalProperties", () => {
    const schema = { type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"], additionalProperties: false };
    expect(() => validateObjectSchema(schema, { opened: true })).not.toThrow();
    expect(() => validateObjectSchema(schema, {})).toThrowError(/opened is required/);
    expect(() => validateObjectSchema(schema, { opened: false })).toThrowError(/not an offered value/);
    expect(() => validateObjectSchema(schema, { opened: true, extra: 1 })).toThrowError(/unsupported answer field/);
  });

  it("enforces string length/pattern and numeric bounds", () => {
    const schema = { type: "object", properties: {
      token: { type: "string", minLength: 8, pattern: "^[A-Z]" },
      count: { type: "integer", minimum: 1, maximum: 5 },
      ratio: { type: "number", exclusiveMinimum: 0 },
    }, required: ["token"] };
    expect(() => validateObjectSchema(schema, { token: "Abcdefgh", count: 3, ratio: 0.5 })).not.toThrow();
    expect(() => validateObjectSchema(schema, { token: "short" })).toThrowError(/shorter than 8/);
    expect(() => validateObjectSchema(schema, { token: "abcdefgh" })).toThrowError(/pattern/);
    expect(() => validateObjectSchema(schema, { token: "Abcdefgh", count: 2.5 })).toThrowError(/integer/);
    expect(() => validateObjectSchema(schema, { token: "Abcdefgh", count: 9 })).toThrowError(/maximum/);
    expect(() => validateObjectSchema(schema, { token: "Abcdefgh", ratio: 0 })).toThrowError(/exclusive minimum/);
  });

  it("handles nested objects, arrays, and allOf/anyOf/oneOf", () => {
    const nested = { type: "object", properties: { user: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }, required: ["user"] };
    expect(() => validateObjectSchema(nested, { user: { id: "u1" } })).not.toThrow();
    expect(() => validateObjectSchema(nested, { user: { id: 1 } })).toThrowError(/must be a string/);

    const array = { type: "object", properties: { tags: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["tags"] };
    expect(() => validateObjectSchema(array, { tags: ["a"] })).not.toThrow();
    expect(() => validateObjectSchema(array, { tags: [] })).toThrowError(/at least 1 items/);
    expect(() => validateObjectSchema(array, { tags: [1] })).toThrowError(/must be a string/);

    expect(() => validateObjectSchema({ type: "object", allOf: [{ required: ["a"] }, { required: ["b"] }] }, { a: 1, b: 2 })).not.toThrow();
    expect(() => validateObjectSchema({ type: "object", allOf: [{ required: ["a"] }, { required: ["b"] }] }, { a: 1 })).toThrowError(/b is required/);
    expect(() => validateObjectSchema({ type: "object", properties: { v: { anyOf: [{ type: "string" }, { type: "integer" }] } }, required: ["v"] }, { v: 3 })).not.toThrow();
    expect(() => validateObjectSchema({ type: "object", properties: { v: { oneOf: [{ type: "string" }, { type: "integer" }] } }, required: ["v"] }, { v: 3 })).not.toThrow();
  });

  it("rejects a schema whose constraints cannot be honored instead of ignoring them", () => {
    expect(() => validateObjectSchema({ type: "object", $ref: "#/x" }, {})).toThrowError(/unsupported keyword \$ref/);
    expect(() => validateObjectSchema({ type: "object", properties: { v: { type: "weird" } }, required: ["v"] }, { v: 1 })).toThrowError(/unsupported question schema type/);
    expect(() => validateObjectSchema({ type: "object", properties: { v: { type: "string", pattern: "(" } }, required: ["v"] }, { v: "x" })).toThrowError(/invalid pattern/);
  });
});

describe("describeFrame", () => {
  it("returns only the exact CodeBuddy auth notification as an auth event", () => {
    const auth = describeFrame({ method: "_codebuddy.ai/authUrl", params: { authUrl: "https://x.test" } });
    expect(auth).toEqual([{ type: "auth", text: JSON.stringify({ authUrl: "https://x.test" }), data: { method: "_codebuddy.ai/authUrl", params: { authUrl: "https://x.test" } } }]);
    // A generic status frame is not silently interpreted as an auth step.
    const status = describeFrame({ method: "_auth/status_update", params: { url: "https://x.test" } });
    expect(status[0]!.type).toBe("unsupported");
  });
});

describe("ProtocolAdapter reverse requests", () => {
  it("populates url/elicitation_id only for an explicit mode:url elicitation", () => {
    const urlMode = adapter();
    urlMode.transport.emit("line", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "elicitation/create",
      params: { mode: "url", url: "https://device.test/activate", elicitationId: "e1", message: "code ABCD" } })));
    expect(urlMode.questions).toHaveLength(1);
    expect(urlMode.questions[0].url).toBe("https://device.test/activate");
    expect(urlMode.questions[0].elicitation_id).toBe("e1");

    // A form elicitation that happens to carry a url field is NOT a browser login.
    const form = adapter();
    form.transport.emit("line", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "elicitation/create",
      params: { mode: "form", url: "https://evil.test", requestedSchema: { type: "object" }, message: "pick" } })));
    expect(form.questions[0].url).toBeNull();
    expect(form.questions[0].elicitation_id).toBeNull();

    // An unknown mode is unsupported, not a browser login.
    const bogus = adapter();
    bogus.transport.emit("line", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "elicitation/create",
      params: { mode: "bogus", url: "https://evil.test", message: "x" } })));
    expect(bogus.questions).toHaveLength(0);
    expect(bogus.transport.written.at(-1)).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it("treats elicitation/complete as a notification, rejecting a request that carries an id", () => {
    const notification = adapter();
    notification.transport.emit("line", Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "elicitation/complete", params: { elicitationId: "e1" } })));
    expect(notification.stale).toEqual(["e1"]);
    expect(notification.transport.written).toHaveLength(0);

    const request = adapter();
    request.transport.emit("line", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "elicitation/complete", params: { elicitationId: "e1" } })));
    expect(request.stale).toHaveLength(0);
    expect(request.transport.written.at(-1)).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("answers a url-mode elicitation with an action only, preserving the original rpc id", () => {
    const { protocol, transport } = adapter();
    const question: Question = { request_id: "1", rpc_id: 41, kind: "elicitation", title: "", message: "", options: [], schema: null, url: "https://x.test", elicitation_id: "e1", raw: {} };
    void protocol.answer(question, "accept", null, { opened: true });
    expect(transport.written.at(-1)).toEqual({ jsonrpc: "2.0", id: 41, result: { action: "accept" } });
  });
});

/**
 * ACP session-setup response separation. `session/new` creates a session and MUST return its id;
 * `session/load` restores the caller-named session and may answer `{}` (or metadata without an id).
 * The requested id — never the response — is the restored protocol session id, so a load can never
 * be reported ready without a valid request id.
 */
describe("ProtocolAdapter session/new vs session/load responses", () => {
  function respond(method: string, params: Record<string, unknown>, frame: (id: unknown) => Record<string, unknown>) {
    const { protocol, transport } = adapter();
    const ticket = protocol.beginRequest(method, params);
    const id = transport.written.at(-1)!.id;
    transport.emit("line", Buffer.from(JSON.stringify(frame(id))));
    return { protocol, transport, ticket };
  }
  const loadParams = (sessionId?: unknown) => ({ cwd: "/tmp", mcpServers: [], ...(sessionId === undefined ? {} : { sessionId }) });

  it("requires a returned id from session/new", async () => {
    const ok = respond("session/new", { cwd: "/tmp", mcpServers: [] }, id => ({ jsonrpc: "2.0", id, result: { sessionId: "fresh-1" } }));
    await expect(ok.ticket.promise).resolves.toBeDefined();
    expect(ok.protocol.sessionId).toBe("fresh-1");

    const missing = respond("session/new", { cwd: "/tmp", mcpServers: [] }, id => ({ jsonrpc: "2.0", id, result: {} }));
    await expect(missing.ticket.promise).rejects.toMatchObject({ code: "unsupported_response" });
    expect(missing.protocol.sessionId).toBeNull();
  });

  it("accepts a void {} response from session/load and keeps the requested id", async () => {
    const { protocol, ticket } = respond("session/load", loadParams("sess-void"), id => ({ jsonrpc: "2.0", id, result: {} }));
    await expect(ticket.promise).resolves.toMatchObject({ result: {} });
    expect(protocol.sessionId).toBe("sess-void");
  });

  it("accepts real load metadata without an id and keeps options/model readback", async () => {
    const { protocol, ticket } = respond("session/load", loadParams("sess-meta"), id => ({ jsonrpc: "2.0", id,
      result: { models: { currentModelId: "fake-model-2" }, configOptions: [
        { id: "model", currentValue: "fake-model-2" },
        { id: "reasoning_effort", currentValue: "high" },
      ] } }));
    await expect(ticket.promise).resolves.toBeDefined();
    expect(protocol.sessionId).toBe("sess-meta");
    expect(protocol.modelId).toBe("fake-model-2");
    expect(protocol.reasoningEffort).toBe("high");
    expect(protocol.options).toEqual([{ id: "model", currentValue: "fake-model-2" }, { id: "reasoning_effort", currentValue: "high" }]);
  });

  it.each([undefined, ""])("never becomes ready when the load request id is %s", async sessionId => {
    const { protocol, ticket } = respond("session/load", loadParams(sessionId), id => ({ jsonrpc: "2.0", id, result: {} }));
    await expect(ticket.promise).rejects.toMatchObject({ code: "unsupported_response" });
    expect(protocol.sessionId).toBeNull();
  });

  it("carries the original requested id into a subsequent request", async () => {
    const { protocol, transport, ticket } = respond("session/load", loadParams("sess-next"), id => ({ jsonrpc: "2.0", id, result: {} }));
    await ticket.promise;
    protocol.beginRequest("session/prompt", { sessionId: protocol.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(protocol.sessionId).toBe("sess-next");
    expect(transport.written.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: "sess-next" } });
  });

  it("accepts a legacy echoed id only when it matches the request, and rejects a conflict", async () => {
    const match = respond("session/load", loadParams("sess-echo"), id => ({ jsonrpc: "2.0", id, result: { sessionId: "sess-echo" } }));
    await expect(match.ticket.promise).resolves.toBeDefined();
    expect(match.protocol.sessionId).toBe("sess-echo");

    const conflict = respond("session/load", loadParams("sess-wanted"), id => ({ jsonrpc: "2.0", id, result: { sessionId: "sess-other" } }));
    await expect(conflict.ticket.promise).rejects.toMatchObject({ code: "unsupported_response" });
    expect(conflict.protocol.sessionId).toBeNull();
  });

  it("still rejects malformed results and RPC errors for session/load", async () => {
    const nonObject = respond("session/load", loadParams("s1"), id => ({ jsonrpc: "2.0", id, result: "nope" }));
    await expect(nonObject.ticket.promise).rejects.toMatchObject({ code: "unsupported_response" });
    const badEnvelope = respond("session/load", loadParams("s2"), id => ({ jsonrpc: "1.0", id, result: {} }));
    await expect(badEnvelope.ticket.promise).rejects.toMatchObject({ code: "unsupported_response" });
    const error = respond("session/load", loadParams("s3"), id => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } }));
    await expect(error.ticket.promise).rejects.toMatchObject({ code: -32000 });
    expect(error.protocol.sessionId).toBeNull();
  });
});
