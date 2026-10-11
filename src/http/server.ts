/** HTTP boundary: route/JSON validation, response envelopes, disconnects, and SSE framing. */
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { BridgeError, errorInfo, isRecord } from "../errors.js";
import { METHODS, HarnessService } from "../logic/service.js";
import { type BridgeConfig } from "../config.js";

const statusOf = (code: string): number => {
  if (code.startsWith("invalid_")) return 400;
  if (["invalid_json", "invalid_param", "invalid_cursor", "unknown_param", "launch_internal", "invalid_option", "invalid_answer"].includes(code)) return 400;
  if (code.endsWith("not_found")) return 404;
  if (["busy", "session_closed", "session_exists", "idempotency_conflict", "no_pending_question"].includes(code)) return 409;
  if (code === "authentication_required") return 403;
  if (code.startsWith("unsupported")) return 501;
  if (code.endsWith("timeout")) return 504;
  if (code === "body_too_large") return 413;
  if (["server_stopping", "session_limit", "state_directory_busy"].includes(code)) return 503;
  return 500;
};
function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body));
}
export class HarnessHttpServer {
  readonly service: HarnessService;
  private server: Server | null = null;
  private requests = new Set<AbortController>();
  constructor(readonly config: BridgeConfig) { this.service = new HarnessService(config); }
  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new BridgeError("already_started", "HTTP server already started");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 0; // Business deadlines and long polling are owned by the service.
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.server.port, this.config.server.host, () => { server.off("error", reject); resolve(); });
    });
    try { this.service.start(); } catch (error) { await this.stop(); throw error; }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP listener has no address");
    return { host: address.address, port: address.port };
  }
  async stop(): Promise<void> {
    for (const controller of this.requests) controller.abort();
    const server = this.server; this.server = null;
    const closed = server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    server?.closeAllConnections();
    await this.service.stop(); await closed;
  }
  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new BridgeError("invalid_param", "Content-Type must be application/json");
    const chunks: Buffer[] = []; let size = 0;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
      const data = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > this.config.server.maxBodyBytes) {
          cleanup(); request.resume(); reject(new BridgeError("body_too_large", "HTTP body exceeds configured limit"));
        } else chunks.push(chunk);
      };
      const end = (): void => { cleanup(); resolve(); };
      const error = (cause: Error): void => { cleanup(); reject(cause); };
      const aborted = (): void => error(new BridgeError("request_aborted", "HTTP request disconnected"));
      request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
    });
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new BridgeError("invalid_json", "request body is not valid JSON"); }
    if (!isRecord(body)) throw new BridgeError("invalid_param", "request body must be a JSON object");
    return body;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController(); this.requests.add(controller);
    const disconnect = (): void => controller.abort(); response.once("close", disconnect);
    try {
      const path = request.url?.split("?")[0] ?? "";
      const method = path.startsWith("/api/") ? path.slice(5) : "";
      if (!METHODS.includes(method as typeof METHODS[number])) { json(response, 404, { ok: false, error: { code: "unsupported_request", message: "unknown HTTP endpoint" } }); return; }
      if (request.method !== "POST") { response.setHeader("allow", "POST"); json(response, 405, { ok: false, error: { code: "method_not_allowed", message: "use POST" } }); return; }
      const params = await this.body(request);
      if (method === "live_output" && request.headers.accept?.includes("text/event-stream")) await this.sse(response, params, controller.signal);
      else {
        const result = await this.service.dispatch(method, params, { signal: controller.signal });
        json(response, 200, { ok: true, data: result });
      }
    } catch (error) {
      const info = errorInfo(error);
      if (response.headersSent) {
        if (!response.destroyed) response.end(`event: error\ndata: ${JSON.stringify({ ok: false, error: info })}\n\n`);
      } else json(response, statusOf(info.code), { ok: false, error: info });
    } finally { this.requests.delete(controller); response.off("close", disconnect); }
  }
  private async sse(response: ServerResponse, params: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    // Validate session/cursor before starting a stream so failures retain JSON responses.
    let page = await this.service.dispatch("live_output", { ...params, wait_ms: params.wait_ms ?? 0 }, { signal });
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
    response.flushHeaders();
    while (!signal.aborted) {
      const frame = `id: ${page.next_cursor}\nevent: output\ndata: ${JSON.stringify({ ok: true, data: page })}\n\n`;
      if (!response.write(frame)) await new Promise<void>(resolve => {
        const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); };
        response.once("drain", done); response.once("close", done);
      });
      if (page.terminal && !page.has_more) { response.end(); return; }
      page = await this.service.dispatch("live_output", { ...params, cursor: page.next_cursor, wait_ms: page.has_more ? 0 : Math.max(1000, Number(params.wait_ms ?? 15000)) }, { signal });
    }
    response.end();
  }
}
