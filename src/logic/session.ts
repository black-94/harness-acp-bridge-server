/** Session state machine, operation serialization, error policy, and all ACP deadlines. */
import { createHash, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_VERSION, ProtocolAdapter, type OutputEvent, type Question, type RequestTicket } from "../acp/protocol.js";
import { AuthStatusUnsupported, getAdapter, authMethods, type AdapterConfig, type AuthInfo, type AuthInteraction } from "../adapter/adapters.js";
import { authTargetKey, type AuthCandidate, type AuthPrompt } from "./auth.js";
import { declaredThinkingLevels, resolveHarness, type BridgeConfig } from "./config.js";
import { type CreateSessionParams } from "./create-params.js";
import { authenticationRequired, BridgeError, deadline, errorInfo, isRecord, normalizeError } from "./errors.js";
import { readJsonFileSafe, SessionStore } from "../io/persistence.js";
import { Redactor, collectSecrets } from "../redact/redact.js";
import { StdioTransport } from "../transport/stdio.js";
import { inspectContainer, newRemotePidFile, type LaunchSpec } from "../io/runtime.js";
import { resolveLocalCommand } from "../io/commands.js";
import { assertHarnessIdentity, HARNESS_COMMANDS, type LaunchTemplate } from "./templates.js";

export type MessageState = "running" | "waiting_input" | "cancelling" | "completed" | "failed" | "cancelled";
interface Message {
  id: string;
  state: MessageState;
  text: string;
  reasoning: string;
  tools: Map<string, Record<string, unknown>>;
  submittedAt: string;
  finishedAt: string | null;
  questions: Map<string, Question>;
  ticket: RequestTicket | null;
  done: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  inputTimer?: ReturnType<typeof setTimeout>;
  cancellation?: Promise<void>;
  cancelRequested: boolean;
  failure?: ReturnType<typeof errorInfo>;
  response?: unknown;
  stopReason?: string;
  persisted?: boolean;
  unsupported: unknown[];
}
const terminal = (state: MessageState): boolean => ["completed", "failed", "cancelled"].includes(state);
const iso = (): string => new Date().toISOString();
export class HarnessSession {
  readonly store: SessionStore;
  readonly transport: StdioTransport;
  readonly protocol: ProtocolAdapter;
  readonly sessionId: string;
  private readonly adapter;
  private adapterConfig: AdapterConfig;
  private readonly spec: LaunchSpec;
  private readonly metadataPath: string;
  private launchInfo: Record<string, unknown> | null = null;
  private readonly createdAt = iso();
  private state = "starting";
  private operation = "starting";
  private modelId: string;
  private thinkingLevel: string | null;
  private permissionMode: CreateSessionParams["permissionMode"];
  private authenticated = false;
  private auth: AuthInfo | null = null;
  private unsupportedAuth: unknown = null;
  private authQuestionSink: ((prompt: AuthPrompt) => boolean) | null = null;
  /** Auth questions awaiting revoke, keyed by the harness `elicitationId`. */
  private readonly authPrompts = new Map<string, AuthPrompt>();
  private stderrBuffer = "";
  private readonly redactor: Redactor;
  private messages = new Map<string, Message>();
  private idempotency: Record<string, { hash: string; message_id: string }> = {};
  private active: Message | null = null;
  private unsupported: unknown[] = [];
  private closePromise: Promise<void> | null = null;
  lastActivity = Date.now();
  /**
   * Real harness progress, moved only by ACP output and reverse questions — never by polling
   * (`message_status`/`ping`), lifecycle journaling, persistence, or the idle
   * reaper. `lastTransportEventAt` tracks any complete stdout frame (including RPC responses);
   * `lastProgressAt` tracks only frames that carry model output or ask for input.
   */
  private lastTransportEventAt: number | null = null;
  private lastProgressAt: number | null = null;
  private observedPhase: string | null = null;
  constructor(readonly config: BridgeConfig, readonly params: CreateSessionParams, sessionId: string, redactor?: Redactor, private readonly template: LaunchTemplate | null = null) {
    const harness = resolveHarness(config, params.harness);
    this.sessionId = sessionId;
    this.adapter = getAdapter(harness.name);
    this.modelId = params.modelId; this.thinkingLevel = params.thinkingLevel; this.permissionMode = params.permissionMode;
    this.assertThinkingLevel(params.modelId, params.thinkingLevel);
    const env = template?.env ?? {};
    let command = template?.command || HARNESS_COMMANDS[harness.name];
    if (!command) throw new BridgeError("invalid_harness_command", "no built-in executable for selected harness");
    if (params.target === "local" && params.runtime === "direct") command = resolveLocalCommand(command, env, params.cwd);
    this.adapterConfig = {
      harness: harness.name, cwd: params.cwd, modelId: params.modelId,
      command, args: template?.args ?? [], env,
      launchMode: params.target === "remote" ? "ssh" : "local", runtime: params.runtime,
      permissionMode: params.permissionMode, acpModeId: config.launch.agyModeIds[params.permissionMode] ?? null,
      sshHost: params.remoteHost, dockerImage: params.dockerImage, reuseContainer: Boolean(params.dockerId),
    };
    this.adapter.validate(this.adapterConfig);
    this.spec = {
      launchMode: this.adapterConfig.launchMode, sshHost: params.remoteHost,
      sshCommand: config.launch.sshCommand, dockerCommand: config.launch.dockerCommand,
      cwd: params.cwd, argv: this.adapter.buildArgv(this.adapterConfig), harnessEnv: env,
      dockerImage: params.dockerImage, dockerContainerName: params.runtime === "docker" ? params.dockerId ?? `harness-acp-${randomUUID().replaceAll("-", "")}` : null,
      dockerId: params.dockerId, dockerMounts: params.dockerMounts, dockerPorts: params.dockerPorts,
      dockerHostNetwork: params.dockerHostNetwork, containerPolicy: params.containerPolicy,
      reuseContainer: Boolean(params.dockerId), remotePidFile: params.target === "remote" ? newRemotePidFile() : null,
      startupTimeoutSeconds: config.timeouts.startupTimeoutSeconds,
      terminateGraceSeconds: config.timeouts.terminateGraceSeconds,
      remoteCleanupTimeoutSeconds: config.timeouts.remoteCleanupTimeoutSeconds,
    };
    this.redactor = redactor ?? new Redactor(collectSecrets(process.env, { launch: { env } }));
    this.store = new SessionStore(config.paths.sessionDir, sessionId, this.redactor);
    this.metadataPath = join(tmpdir(), `harness-acp-${randomUUID()}.json`);
    this.transport = new StdioTransport(this.store, config.buffers.maxReadBytes);
    this.protocol = new ProtocolAdapter(this.transport, this.adapter);
    this.transport.on("fault", error => this.onFault(error));
    this.protocol.on("fault", error => this.onFault(error));
    // Any complete frame from the harness is transport activity; this never edits message state.
    this.transport.on("line", () => { this.lastTransportEventAt = Date.now(); });
    this.transport.on("exit", () => {
      if (!this.closePromise) void this.close(new BridgeError("transport_closed", "harness exited unexpectedly")).catch(() => undefined);
    });
    this.protocol.on("question", question => this.onQuestion(question));
    this.protocol.on("question_stale", value => this.onQuestionStale(value));
    this.protocol.on("output", event => this.onOutput(event));
    this.transport.on("stderr", text => this.onStderr(text));
    this.protocol.on("unsupported", value => {
      this.unsupported.push(value); if (this.unsupported.length > 64) this.unsupported.shift();
      if (this.active) { this.active.unsupported.push(value); if (this.active.unsupported.length > 64) this.active.unsupported.shift(); }
      this.journal("unsupported", value); this.persist();
    });
    this.journal("session_created", { harness: harness.name, cwd: params.cwd, options: this.options() });
    this.persist();
  }
  get isClosed(): boolean { return ["closed", "failed", "interrupted"].includes(this.state); }
  get isIdle(): boolean { return !this.isClosed && this.operation === "idle"; }
  private client() { return this.protocol.client((method, params) => this.request(method, params)); }
  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ticket = this.protocol.beginRequest(method, params);
    const seconds = method === "initialize" ? this.config.timeouts.startupTimeoutSeconds : method === "authenticate" ? this.config.timeouts.authenticationTimeoutSeconds : this.config.timeouts.requestTimeoutSeconds;
    try { return await deadline(ticket.promise, seconds, method === "initialize" ? "handshake_timeout" : method === "authenticate" ? "authentication_timeout" : "request_timeout"); }
    catch (error) {
      // Normalize at the session boundary so every explicit auth failure (ACP -32000 / vendor code)
      // carries the real session_id and a next_action, whatever adapter operation produced it.
      const normalized = normalizeError(error, this.sessionId);
      const failure = normalized instanceof Error ? normalized : new Error(String(normalized));
      ticket.abandon(failure);
      if (failure instanceof BridgeError && failure.code.endsWith("timeout")) await this.close(failure);
      throw failure;
    }
  }
  async initialize(): Promise<void> {
    let identityValidated = false;
    try {
      if (this.spec.reuseContainer) await inspectContainer(this.spec, this.config.timeouts.startupTimeoutSeconds * 1000);
      this.transport.start({ ...this.spec, metadataPath: this.metadataPath, daemonPid: process.pid });
      await this.request("initialize", { protocolVersion: 1,
        // `elicitation.form`/`elicitation.url` must be present (non-null) for harnesses such as
        // codex-acp to surface form questions and the ChatGPT device-code URL elicitation.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          auth: { terminal: false }, elicitation: { form: {}, url: {} } },
        clientInfo: { name: "harness-acp-bridge", version: CLIENT_VERSION } });
      assertHarnessIdentity(this.adapter.name, this.protocol.initializeResponse);
      identityValidated = true;
      const methods = authMethods(this.protocol.initializeResponse);
      if (methods.length) {
        const info = await this.refreshAuthInfo();
        if (info?.authenticated) await this.openSession();
        else this.state = "authentication_required";
      } else await this.openSession();
      this.operation = "idle";
      this.journal(this.state === "ready" ? "session_ready" : "authentication_required", this.snapshot());
      this.persist();
    } catch (error) {
      let normalized = normalizeError(error, this.sessionId);
      if (!identityValidated && normalized instanceof BridgeError && normalized.code === "authentication_required") {
        normalized = new BridgeError("invalid_harness_command", "cannot validate harness identity: initialize requires authentication");
      }
      // A genuine auth-required during setup keeps the initialized harness alive for `authenticate`;
      // an unrecoverable handshake/transport failure closes it so it is never advertised as usable.
      if (normalized instanceof BridgeError && normalized.code === "authentication_required") {
        this.authenticated = false; this.state = "authentication_required"; this.operation = "idle";
        this.journal("authentication_required", this.snapshot()); this.persist();
        return;
      }
      await this.close(normalized instanceof Error ? normalized : new Error(String(normalized)));
      const launchError = this.launchInfo?.launch_error;
      if (isRecord(launchError) && typeof launchError.code === "string" && typeof launchError.message === "string") {
        throw new BridgeError(launchError.code, launchError.message);
      }
      throw normalized;
    }
  }
  private async openSession(): Promise<void> {
    if (this.protocol.sessionId) { this.state = "ready"; this.authenticated = true; return; }
    try {
      await this.request(this.params.resumeSessionId ? "session/load" : "session/new", {
        cwd: this.params.cwd, mcpServers: [], ...(this.params.resumeSessionId ? { sessionId: this.params.resumeSessionId } : {}),
      });
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized instanceof BridgeError && normalized.code === "authentication_required") {
        this.state = "authentication_required"; this.authenticated = false; return;
      }
      throw normalized;
    }
    if (this.isClosed) throw new BridgeError("session_closed", "session closed during initialization");
    await this.adapter.setMode(this.client(), this.adapterConfig, this.protocol.sessionId!);
    if (this.adapter.name !== "codebuddy") await this.adapter.setModel(this.client(), this.modelId);
    this.modelId = this.protocol.modelId ?? this.modelId;
    if (this.thinkingLevel) await this.adapter.setThinkingLevel(this.client(), this.protocol.sessionId!, this.modelId, this.thinkingLevel, this.protocol.options);
    this.authenticated = true; this.state = "ready";
  }
  options(): Record<string, unknown> { return { model_id: this.modelId, thinking_level: this.thinkingLevel, permission_mode: this.permissionMode }; }
  snapshot(): Record<string, unknown> {
    this.launchInfo = readJsonFileSafe(this.metadataPath) ?? this.launchInfo;
    return { version: 2, session_id: this.sessionId, harness: this.adapter.name, template: this.template?.name ?? null, state: this.state,
      operation: this.operation, created_at: this.createdAt, updated_at: iso(), last_activity_at: new Date(this.lastActivity).toISOString(),
      activity: this.activity(),
      cwd: this.params.cwd, target: this.params.target, runtime: this.params.runtime,
      remote_host: this.params.remoteHost, container_policy: this.params.containerPolicy,
      harness_session_id: this.protocol.sessionId, options: this.options(), auth: this.authInfo(),
      launch_info: this.launchInfo, unsupported: this.unsupported };
  }
  private persist(): void {
    try {
      this.store.session(this.snapshot());
      this.store.queue({ version: 2, active_message_id: this.active?.id ?? null,
        messages: [...this.messages.values()].map(message => ({ session_id: this.sessionId, message_id: message.id,
          state: message.state, terminal: terminal(message.state), submitted_at: message.submittedAt,
          finished_at: message.finishedAt, error: message.failure ?? null })), idempotency: this.idempotency });
    } catch (error) { throw this.storageError(error); }
  }
  private storageError(cause: unknown): BridgeError {
    const error = new BridgeError("storage_error", `session persistence failed: ${String(cause)}`);
    if (!this.closePromise) void this.close(error).catch(() => undefined);
    return error;
  }
  private journal(event: string, data?: unknown): void {
    try { this.store.event(event, data); } catch (error) { throw this.storageError(error); }
  }
  private assertOpen(): void { if (this.isClosed || this.closePromise) throw new BridgeError("session_closed", "session is closed"); }
  private assertIdle(): void { this.assertOpen(); if (this.operation !== "idle") throw new BridgeError("busy", `session is ${this.operation}`); }
  private touch(): void { this.lastActivity = Date.now(); }
  /**
   * Observed harness activity for a UI hint. Read-only: computing it never advances a timestamp,
   * so repeated `message_status`/`ping` polls cannot fabricate progress.
   *
   * A running state means "the bridge is still waiting for the ACP prompt result", not "the model
   * is still making progress". `baseline` (a message's submission time) is used only when the
   * harness has produced no progress yet, so a message that never emitted anything is still
   * measurable; `last_progress_at` stays null to show it has never reported progress.
   */
  private activity(baseline?: number | null): Record<string, unknown> {
    const now = Date.now();
    const secondsSince = (at: number | null): number | null => (at === null ? null : Math.max(0, (now - at) / 1000));
    const secondsSinceProgress = secondsSince(this.lastProgressAt ?? baseline ?? null);
    const stallHint = this.config.sessions.stallHintSeconds;
    return {
      last_transport_event_at: this.lastTransportEventAt === null ? null : new Date(this.lastTransportEventAt).toISOString(),
      last_progress_at: this.lastProgressAt === null ? null : new Date(this.lastProgressAt).toISOString(),
      observed_phase: this.observedPhase,
      seconds_since_progress: secondsSinceProgress,
      seconds_since_transport_event: secondsSince(this.lastTransportEventAt),
      stall_hint_seconds: stallHint,
      stalled: stallHint > 0 && secondsSinceProgress !== null && secondsSinceProgress >= stallHint,
    };
  }
  private static phaseOf(event: OutputEvent): string | null {
    if (event.type === "reasoning") return "thinking";
    if (event.type === "answer") return "responding";
    if (event.type === "tool_call" || event.type === "tool_output") return "tool_use";
    if (event.type === "session_options") {
      const kind = isRecord(event.data) ? event.data.sessionUpdate : undefined;
      return kind === "usage_update" ? "usage" : "session_update";
    }
    return null;
  }
  private assertThinkingLevel(model: string, level: string | null): void {
    const levels = declaredThinkingLevels(this.config, resolveHarness(this.config, this.params.harness).name, model);
    if (level && levels !== null && !levels.includes(level)) throw new BridgeError("unsupported_request", `thinking_level ${level} is not configured for model ${model}`);
  }
  async setOptions(options: { model_id?: string; thinking_level?: string; permission_mode?: CreateSessionParams["permissionMode"] }): Promise<Record<string, unknown>> {
    this.assertIdle();
    if (this.state !== "ready") throw authenticationRequired(this.sessionId);
    this.assertThinkingLevel(options.model_id ?? this.modelId, options.thinking_level ?? null);
    const nextConfig = { ...this.adapterConfig, permissionMode: options.permission_mode ?? this.permissionMode,
      acpModeId: this.config.launch.agyModeIds[options.permission_mode ?? this.permissionMode] ?? null };
    this.adapter.validate(nextConfig);
    this.operation = "setting_options"; this.touch(); this.journal("session_options_requested", options); this.persist();
    try {
      if (options.model_id !== undefined) {
        await this.adapter.setModel(this.client(), options.model_id);
        this.modelId = this.protocol.modelId ?? options.model_id; this.adapterConfig.modelId = this.modelId;
        // Reasoning from the old model cannot be treated as confirmed for the new model.
        this.thinkingLevel = this.protocol.reasoningEffort;
        this.persist();
      }
      if (options.thinking_level !== undefined) {
        await this.adapter.setThinkingLevel(this.client(), this.protocol.sessionId!, this.modelId, options.thinking_level, this.protocol.options);
        this.thinkingLevel = options.thinking_level; this.persist();
      }
      if (options.permission_mode !== undefined) {
        await this.adapter.setPermissionMode(this.client(), nextConfig, this.protocol.sessionId!);
        this.permissionMode = options.permission_mode; this.adapterConfig = { ...nextConfig, modelId: this.modelId }; this.persist();
      }
      this.journal("session_options_changed", this.options());
      return { session_id: this.sessionId, options: this.options() };
    } catch (error) {
      this.journal("session_options_failed", { error: errorInfo(error), effective_options: this.options() });
      if (error instanceof BridgeError && error.code === "authentication_required") { this.authenticated = false; this.state = "authentication_required"; }
      throw error;
    }
    finally { if (!this.isClosed) this.operation = "idle"; this.persist(); }
  }
  authTargetKey(): string { return authTargetKey(this.adapter.name, this.spec.launchMode, this.spec.sshHost); }
  isAuthenticated(): boolean { return this.authenticated; }
  /** True only when the harness itself has an open, ready session. */
  isReady(): boolean { return this.state === "ready" && this.protocol.sessionId !== null; }
  authCandidates(): AuthCandidate[] {
    return authMethods(this.protocol.initializeResponse).map(method => {
      const id = typeof method.id === "string" ? method.id : "";
      const type = typeof method.type === "string" ? method.type : "agent";
      const supported = Boolean(id) && type === "agent";
      const original = typeof method.description === "string" ? method.description.trim() : "";
      return { id, name: typeof method.name === "string" ? method.name : id, type, supported,
        ...((original || !supported) ? { description: [original, ...(!supported ? ["Not supported in harness_acp_bridge"] : [])].filter(Boolean).join(" ") } : {}) };
    });
  }
  setAuthQuestionSink(sink: ((prompt: AuthPrompt) => boolean) | null): void { this.authQuestionSink = sink; }
  authInfo(): Record<string, unknown> {
    return { authenticated: this.auth ? this.authenticated : this.authenticated ? true : null,
      supported: this.auth !== null, methods: authMethods(this.protocol.initializeResponse), user: this.auth?.user ?? null };
  }
  async refreshAuthInfo(): Promise<AuthInfo | null> {
    this.assertOpen();
    try {
      this.auth = await this.adapter.getAuthInfo(this.client(), this.protocol.initializeResponse);
      this.authenticated = this.auth.authenticated; this.persist(); return this.auth;
    } catch (error) {
      if (!(error instanceof AuthStatusUnsupported)) throw error;
      this.unsupportedAuth = { reason: error.message, raw: error.detail ?? null };
      return null;
    }
  }
  unsupportedAuthInfo(): unknown { return this.unsupportedAuth; }
  async ensureReady(): Promise<unknown> {
    if (this.state === "ready") return this.snapshot();
    this.assertIdle(); this.operation = "authenticating";
    try { await this.openSession(); return this.snapshot(); }
    finally { if (!this.isClosed) this.operation = "idle"; this.persist(); }
  }
  async authenticate(methodId: string): Promise<unknown> {
    this.assertIdle(); this.operation = "authenticating"; this.touch(); this.journal("authentication_started", { method_id: methodId }); this.persist();
    try {
      let rpcSucceededWithoutStatus = false;
      try { this.auth = await this.adapter.authenticate(this.client(), methodId); this.authenticated = this.auth.authenticated; }
      catch (error) { if (!(error instanceof AuthStatusUnsupported)) throw error; rpcSucceededWithoutStatus = true; }
      if (!rpcSucceededWithoutStatus && !this.authenticated) throw new BridgeError("authentication_failed", "harness is still unauthenticated");
      await this.openSession();
      if (this.state !== "ready" || !this.protocol.sessionId) throw new BridgeError("authentication_failed", "authentication completed but the harness session is not ready");
      this.authenticated = true;
      this.journal("authentication_completed", this.authInfo()); return this.snapshot();
    } finally { if (!this.isClosed) this.operation = "idle"; this.persist(); }
  }
  sendMessage(text: string, key?: string): { message_id: string } {
    const hash = createHash("sha256").update(text).digest("hex");
    const keyHash = key === undefined ? null : createHash("sha256").update(key).digest("hex");
    if (keyHash && this.idempotency[keyHash]) {
      const old = this.idempotency[keyHash];
      if (old.hash !== hash) throw new BridgeError("idempotency_conflict", "idempotency_key was used with different text");
      return { message_id: old.message_id };
    }
    this.assertIdle();
    if (this.state !== "ready") throw authenticationRequired(this.sessionId);
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    this.store.messageId = id;
    // Acceptance and slot are recorded before any ACP write or HTTP response.
    this.journal("message_accepted", { message_id: id });
    this.operation = "running"; this.touch();
    const message: Message = { id, state: "running", text: "", reasoning: "", tools: new Map(), submittedAt: iso(), finishedAt: null,
      questions: new Map(), ticket: null, done: Promise.resolve(), cancelRequested: false, unsupported: [] };
    this.active = message; this.messages.set(id, message);
    // Progress is per message: a fresh message must not inherit the previous message's
    // last_progress_at/observed_phase (which would immediately look stalled or show a stale phase).
    this.lastProgressAt = null;
    this.observedPhase = null;
    if (keyHash) this.idempotency[keyHash] = { hash, message_id: id };
    try { this.persist(); }
    catch (error) {
      message.failure = errorInfo(error);
      message.done = this.finishMessage(message);
      void message.done.catch(() => undefined);
      throw error;
    }
    message.ticket = this.protocol.beginRequest("session/prompt", { sessionId: this.protocol.sessionId, prompt: [{ type: "text", text }] });
    message.timer = setTimeout(() => { void this.cancelMessage(id, new BridgeError("message_timeout", "message deadline exceeded")).catch(() => undefined); }, this.config.timeouts.turnTimeoutSeconds * 1000);
    message.done = this.finishMessage(message);
    void message.done.catch(error => this.close(error).catch(() => undefined));
    return { message_id: id };
  }
  private async finishMessage(message: Message): Promise<void> {
    try {
      if (!message.ticket) throw new BridgeError("storage_error", "message acceptance could not be persisted");
      const response = await message.ticket.promise;
      message.response = response.result;
      message.stopReason = isRecord(response.result) ? response.result.stopReason : undefined;
    } catch (error) { if (!(message.cancelRequested && this.state === "closed")) message.failure ??= errorInfo(normalizeError(error, this.sessionId)); }
    if (message.cancellation) {
      try { await message.cancellation; } catch (error) { message.failure ??= errorInfo(error); }
    }
    message.state = message.failure ? "failed" : message.cancelRequested || message.stopReason === "cancelled" ? "cancelled" : "completed";
    if (message.failure?.code === "authentication_required") { this.authenticated = false; this.state = "authentication_required"; }
    message.finishedAt = iso();
    clearTimeout(message.timer); clearTimeout(message.inputTimer); message.questions.clear();
    this.journal("message_finished", { message_id: message.id, state: message.state, error: message.failure });
    try { this.store.result(message.id, this.messageStatus(message.id)); }
    catch (error) { throw this.storageError(error); }
    message.persisted = true;
    message.text = ""; message.reasoning = ""; message.tools.clear(); message.response = undefined;
    if (this.active === message) { this.active = null; this.store.messageId = null; if (!this.isClosed && !this.closePromise) this.operation = "idle"; }
    this.touch(); this.persist();
  }
  messageStatus(id: string): Record<string, unknown> {
    const message = this.messages.get(id);
    if (!message) throw new BridgeError("message_not_found", `unknown message_id: ${id}`);
    if (message.persisted) {
      const result = readJsonFileSafe(join(this.store.directory, "results", `${id}.json`));
      if (!result) throw new BridgeError("result_unavailable", "persisted message result is unavailable");
      return result;
    }
    const done = terminal(message.state);
    const activity = this.activity(Date.parse(message.submittedAt));
    // A finished message is not "stalled", and a message waiting on the user is waiting on input,
    // not on the model: neither should report a stall hint.
    if (done || message.state === "waiting_input") activity.stalled = false;
    const progress = done ? null : this.progress(message);
    return { session_id: this.sessionId, message_id: id, state: message.state, terminal: done,
      submitted_at: message.submittedAt, finished_at: message.finishedAt,
      activity,
      unsupported: message.unsupported,
      questions: [...message.questions.values()].map(({ rpc_id, ...question }) => question),
      ...(progress ? { progress } : {}),
      ...(message.failure ? { error: message.failure } : {}),
      ...(done ? { result: { text: message.text, reasoning: message.reasoning, tool_calls: [...message.tools.values()], stop_reason: message.stopReason ?? null, raw_result: message.response ?? null } } : {}) };
  }
  private progress(message: Message): Record<string, unknown> {
    const limit = this.config.buffers.previewTextBytes;
    const bounded = (value: string): string => {
      const safe = this.redactor.text(value);
      const bytes = Buffer.from(safe);
      if (bytes.length <= limit) return safe;
      let end = limit;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      return `${bytes.subarray(0, end).toString("utf8")}…`;
    };
    const tools: unknown[] = [];
    let size = 2;
    for (const tool of [...message.tools.values()].slice(-50)) {
      const safe = this.redactor.value(tool);
      const encoded = JSON.stringify(safe);
      if (size + Buffer.byteLength(encoded) > limit) break;
      tools.push(safe); size += Buffer.byteLength(encoded) + 1;
    }
    return { text: bounded(message.text), reasoning: bounded(message.reasoning), tool_calls: tools };
  }
  private onOutput(event: OutputEvent): void {
    if (event.type === "auth" && this.authQuestionSink) {
      const interaction = this.adapter.normalizeAuthInteraction(event.data);
      if (interaction && this.authQuestionSink(this.authPrompt(interaction, async () => undefined))) return;
    }
    // Only real model output advances the business progress clock. Metadata frames
    // (usage_update/config/session_info/plan, `_codebuddy.ai/*`) may update the observed phase as
    // evidence, but a periodic usage/idle heartbeat must never clear a stall.
    if (event.type === "reasoning" || event.type === "answer" || event.type === "tool_call" || event.type === "tool_output") {
      this.lastProgressAt = Date.now();
    }
    const phase = HarnessSession.phaseOf(event);
    if (phase !== null) this.observedPhase = phase;
    const message = this.active;
    if (!message || terminal(message.state)) return;
    if (event.type === "answer") message.text += event.text;
    if (event.type === "reasoning") message.reasoning += event.text;
    if (["tool_call", "tool_output"].includes(event.type) && isRecord(event.data)) {
      const id = String(event.data.tool_call_id ?? "unknown");
      message.tools.set(id, { ...message.tools.get(id), ...event.data });
    }
  }
  private onQuestion(question: Question): void {
    this.lastProgressAt = Date.now();
    this.observedPhase = "waiting_input";
    if (this.authQuestionSink) {
      const interaction = this.adapter.normalizeAuthQuestion(question);
      const respond = (answer: string, optionId: string | null, content: Record<string, unknown> | null) => {
        // Register any credential-shaped answer values as literal secrets for THIS session so the
        // on-disk copy is masked by value while the wire bytes to the harness stay exact.
        this.registerAuthSecrets(content);
        return this.protocol.answer(question, answer, optionId, content);
      };
      const prompt: AuthPrompt = interaction
        ? this.authPrompt(interaction, respond)
        : { kind: question.kind, title: question.title, message: question.message, options: question.options,
            schema: question.schema, raw: this.redactor.value(question.raw), respond };
      if (this.authQuestionSink(prompt)) {
        if (question.elicitation_id) this.authPrompts.set(question.elicitation_id, prompt);
        return;
      }
    }
    const message = this.active;
    if (!message || message.cancelRequested) {
      void this.protocol.send({ jsonrpc: "2.0", id: question.rpc_id, error: { code: -32601, message: "no message awaiting input" } }).catch(error => this.onFault(error)); return;
    }
    message.questions.set(question.request_id, question); message.state = "waiting_input"; this.operation = "waiting_input";
    this.journal("question_pending", { request_id: question.request_id });
    clearTimeout(message.inputTimer);
    if (this.config.timeouts.inputTimeoutSeconds) message.inputTimer = setTimeout(() => {
      void this.cancelMessage(message.id, new BridgeError("input_timeout", "question was not answered before deadline")).catch(() => undefined);
    }, this.config.timeouts.inputTimeoutSeconds * 1000);
    this.persist();
  }
  /** Build the normalized auth prompt the coordinator enqueues for the client. */
  private authPrompt(interaction: AuthInteraction, respond: AuthPrompt["respond"]): AuthPrompt {
    return { kind: "information", title: interaction.title, message: interaction.message,
      options: [], schema: interaction.schema, raw: this.redactor.value(interaction.raw), respond };
  }
  /** Treat string answer values (token/code/response/…) as ephemeral secrets for on-disk copies. */
  private registerAuthSecrets(content: Record<string, unknown> | null): void {
    if (!content) return;
    const values: string[] = [];
    for (const value of Object.values(content)) {
      if (typeof value === "string") values.push(value);
      else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") values.push(item);
    }
    if (values.length) this.redactor.addSecrets(values);
  }
  /**
   * Assemble stderr into lines and, only while an authentication is in flight, offer each line to
   * the harness's strict login-URL hook. stderr is never parsed as JSON-RPC, and only the harness's
   * own exact message is ever treated as an auth URL.
   */
  private onStderr(text: string): void {
    if (!this.authQuestionSink || !text) return;
    this.stderrBuffer += text;
    if (this.stderrBuffer.length > 64 * 1024) this.stderrBuffer = this.stderrBuffer.slice(-8 * 1024);
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this.considerAuthStderr(line);
      newline = this.stderrBuffer.indexOf("\n");
    }
  }
  private considerAuthStderr(line: string): void {
    if (!this.authQuestionSink || !line.trim()) return;
    const interaction = this.adapter.normalizeAuthStderr(line);
    if (!interaction) return;
    this.authQuestionSink(this.authPrompt(interaction, async () => undefined));
  }
  /** Withdraw an auth question the harness has already completed out of band. */
  private onQuestionStale(value: unknown): void {
    const id = isRecord(value) && typeof value.elicitation_id === "string" ? value.elicitation_id : null;
    if (!id) return;
    const prompt = this.authPrompts.get(id);
    if (!prompt) return;
    this.authPrompts.delete(id);
    prompt.cancel?.();
  }
  async answerQuestion(id: string, requestId: string, answer: string, optionId: string | null, content: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    this.assertOpen();
    const message = this.active;
    if (!message || message.id !== id || message.cancelRequested) throw new BridgeError("no_pending_question", "message is not awaiting input");
    const question = message.questions.get(requestId);
    if (!question) throw new BridgeError("question_not_found", "unknown request_id");
    // Validate synchronously inside adapter before claiming/removing a question.
    const response = this.protocol.answer(question, answer, optionId, content);
    message.questions.delete(requestId); clearTimeout(message.inputTimer);
    message.state = message.questions.size ? "waiting_input" : "running"; this.operation = message.state;
    this.touch(); this.persist();
    try { await response; }
    catch (error) { await this.cancelMessage(id, error instanceof Error ? error : new Error(String(error))); throw error; }
    if (["timeout", "cancel"].includes(answer) || (answer === "reject" && question.kind === "information")) await this.cancelMessage(id);
    return { session_id: this.sessionId, message_id: id, request_id: requestId, answered: true };
  }
  async cancelMessage(id: string, failure?: Error): Promise<Record<string, unknown>> {
    const message = this.messages.get(id);
    if (!message) throw new BridgeError("message_not_found", "unknown message_id");
    if (terminal(message.state)) return this.messageStatus(id);
    if (!message.cancellation) {
      message.cancelRequested = true; message.failure = failure ? errorInfo(failure) : message.failure;
      message.state = "cancelling"; this.operation = "cancelling";
      clearTimeout(message.timer); clearTimeout(message.inputTimer);
      this.journal("message_cancel_requested", { error: message.failure }); this.persist();
      message.cancellation = this.performCancel(message);
    }
    await message.done;
    return this.messageStatus(id);
  }
  private async performCancel(message: Message): Promise<void> {
    try {
      await deadline((async () => {
        if (!this.protocol.sessionId) throw new BridgeError("session_closed", "cannot cancel before a harness session exists");
        await this.protocol.notify("session/cancel", { sessionId: this.protocol.sessionId });
        await message.ticket?.promise.catch(() => undefined);
      })(), this.config.timeouts.turnCancelTimeoutSeconds, "cancel_timeout");
    } catch (error) {
      message.failure ??= errorInfo(error);
      // Unconfirmed cancellation never releases the session for the next message.
      await this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private onFault(error: Error): void {
    if (this.closePromise) return;
    try { this.journal("session_error", errorInfo(error)); }
    catch (cause) { error = new BridgeError("storage_error", `could not journal session error: ${String(cause)}`); }
    if (this.active && error instanceof BridgeError && ["invalid_json", "line_too_large"].includes(error.code)) {
      void this.cancelMessage(this.active.id, error).catch(() => undefined);
    } else void this.close(error).catch(() => undefined);
  }
  close(failure?: Error): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Claim the state synchronously before any await; closed sessions cannot be revived.
    this.state = failure ? "failed" : "closed"; this.operation = "closing"; this.authQuestionSink = null; this.authPrompts.clear();
    this.closePromise = Promise.resolve().then(() => this.finishClose(failure));
    return this.closePromise;
  }
  private async finishClose(failure?: Error): Promise<void> {
    const message = this.active;
    let storageFailure: unknown;
    try { this.journal("session_closing", { error: failure ? errorInfo(failure) : null }); this.persist(); }
    catch (error) { storageFailure = error; }
    if (message) {
      message.cancelRequested = true; message.failure ??= failure ? errorInfo(failure) : undefined;
      if (this.protocol.sessionId) await this.protocol.notify("session/cancel", { sessionId: this.protocol.sessionId }).catch(() => undefined);
    }
    await this.transport.close(this.config.timeouts.terminateGraceSeconds + this.config.timeouts.remoteCleanupTimeoutSeconds * 2 + 3);
    this.protocol.failAll(failure ?? new BridgeError("session_closed", "session closed"));
    // Do not await message.done here: cancellation recovery may itself be awaiting close.
    if (message && !message.cancellation) await message.done.catch(error => { storageFailure ??= error; });
    this.operation = "closed";
    try { this.journal("session_closed", { state: this.state, error: failure ? errorInfo(failure) : null }); this.persist(); }
    catch (error) { storageFailure ??= error; }
    try { unlinkSync(this.metadataPath); } catch { /* Already removed or never created. */ }
    if (storageFailure) throw new BridgeError("storage_error", `session cleanup completed but persistence failed: ${String(storageFailure)}`);
  }
}
