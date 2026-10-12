/** Byte transport only: supervision, newline framing, lossless write-before-delivery. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../logic/errors.js";
import { SessionStore } from "../io/persistence.js";
import { type StreamRedactor } from "../redact/redact.js";
import { SUPERVISOR_SPEC_ENV, type SupervisorSpec } from "../io/runtime.js";

export class StdioTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parts: Buffer[] = [];
  private size = 0;
  private overflow = false;
  private closePromise: Promise<void> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private gone = false;
  private stdoutClosed = false;
  private stderrPartial = Buffer.alloc(0);
  /** Bounded redactors so a secret split across stderr chunks / oversized fragments never lands. */
  private readonly stderrRedactor: StreamRedactor;
  private readonly fragmentRedactor: StreamRedactor;
  constructor(readonly store: SessionStore, readonly maxLineBytes: number) {
    super();
    this.stderrRedactor = store.redactor.stream("utf8");
    this.fragmentRedactor = store.redactor.stream("latin1");
  }
  start(spec: SupervisorSpec): void {
    if (this.child) throw new BridgeError("already_started", "transport already started");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.js", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"], detached: true,
      env: { ...process.env, [SUPERVISOR_SPEC_ENV]: JSON.stringify(spec) },
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    child.stdin.on("error", error => this.emit("fault", new BridgeError("transport_error", error.message)));
    child.stdout.on("data", (chunk: Buffer) => {
      try { this.receive(chunk); } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
    });
    // The ACP read channel ending is a transport fault, not necessarily a process exit: a
    // supervisor can stay alive (or a remote/pipe channel can break) after the harness closes
    // stdout. Converge the session; `gone` stays false so `close()` still terminates whatever
    // survives. The flag keeps the paired 'end'/'close' events from double-emitting.
    child.stdout.on("end", () => this.onStdoutClosed());
    child.stdout.on("close", () => this.onStdoutClosed());
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        // Transient, per-chunk stderr text for a harness that announces an interactive login
        // URL on stderr (the ACP stdout channel cannot carry it). Known secrets are stripped
        // in-place; this event is never persisted (the redacted `raw.jsonl` remains authoritative)
        // and is consumed only by the strict, per-harness auth-URL matcher.
        this.emit("stderr", this.store.redactor.text(chunk.toString("utf8")));
        this.receiveStderr(chunk);
      } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
    });
    child.on("error", error => this.emit("fault", new BridgeError("transport_error", error.message)));
    child.once("close", (code, signal) => {
      this.gone = true;
      try {
        if (this.size && !this.overflow) this.deliver();
        this.flushStreams();
        this.store.event("transport_exited", { code, signal });
      } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
      this.emit("exit", { code, signal });
    });
  }
  /** Emit any bytes held back by the bounded redactors (EOF). */
  private flushStreams(): void {
    if (this.stderrPartial.length) { const tail = this.stderrPartial; this.stderrPartial = Buffer.alloc(0); this.emitStderr(this.stderrRedactor.push(tail)); }
    this.emitStderr(this.stderrRedactor.flush());
    this.emitFragment(this.fragmentRedactor.flush());
  }
  /**
   * The stdout (ACP read) channel ended while this transport was still active.
   *
   * A final complete frame that was written **without a trailing newline** only becomes
   * deliverable at EOF (a normal exit delivers it from the `close` handler). Deliver it here,
   * in this same synchronous call, *before* emitting the fault: the resolved prompt response
   * settles in the first microtask, ahead of the fault's deferred `close()`/`finishClose`, so a
   * prompt whose final response arrived can still finish `completed` instead of being failed by
   * the channel close. The transport is not `gone`, so a later `close()` still reaps a lingering
   * child. The flag keeps the paired 'end'/'close' events from double-emitting.
   */
  private onStdoutClosed(): void {
    if (this.stdoutClosed) return;
    this.stdoutClosed = true;
    try {
      if (this.size && !this.overflow) this.deliver();
      this.flushStreams();
    } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
    this.emit("fault", new BridgeError("transport_closed", "harness stdout closed (ACP channel ended)"));
  }
  private emitStderr(buffer: Buffer): void { if (buffer.length) this.store.wire("stderr", buffer); }
  private emitFragment(buffer: Buffer): void { if (buffer.length) this.store.wire("stdout", buffer, true); }
  private receiveStderr(chunk: Buffer): void {
    const bytes = Buffer.concat([this.stderrPartial, chunk]);
    let start = bytes.length - 1;
    while (start >= 0 && bytes.length - start <= 4 && (bytes[start] & 0xc0) === 0x80) start--;
    let end = bytes.length;
    if (start >= 0) {
      const lead = bytes[start]!;
      const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
      if (start + width > bytes.length) end = start;
    }
    if (end) this.emitStderr(this.stderrRedactor.push(bytes.subarray(0, end)));
    this.stderrPartial = Buffer.from(bytes.subarray(end));
  }
  receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const piece = chunk.subarray(offset, end);
      if (this.overflow) this.emitFragment(this.fragmentRedactor.push(piece));
      else if (this.size + piece.length - (newline < 0 ? 0 : 1) > this.maxLineBytes) {
        for (const part of this.parts) this.emitFragment(this.fragmentRedactor.push(part));
        this.emitFragment(this.fragmentRedactor.push(piece));
        this.parts = []; this.size = 0; this.overflow = true;
        this.emit("fault", new BridgeError("line_too_large", `ACP line exceeds ${this.maxLineBytes} bytes`));
      } else {
        this.parts.push(piece); this.size += piece.length;
        if (newline >= 0) this.deliver();
      }
      if (newline >= 0 && this.overflow) { this.overflow = false; this.emitFragment(this.fragmentRedactor.flush()); }
      offset = end;
    }
  }
  private deliver(): void {
    const raw = Buffer.concat(this.parts, this.size);
    this.parts = []; this.size = 0;
    this.store.wire("stdout", raw);
    this.emit("line", raw);
  }
  async write(raw: Buffer): Promise<void> {
    if (!this.child || this.gone || this.child.stdin.destroyed) throw new BridgeError("transport_closed", "harness transport is closed");
    this.store.wire("stdin", raw);
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(raw, error => error ? reject(error) : resolve()));
  }
  close(budgetSeconds: number): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishClose(budgetSeconds);
    return this.closePromise;
  }
  private async finishClose(budgetSeconds: number): Promise<void> {
    if (!this.child || this.gone) return;
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([this.exited.then(() => true), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), budgetSeconds * 1000);
      })]);
      if (!closed) { this.child.kill("SIGKILL"); await this.exited; }
    } finally { clearTimeout(timer); }
  }
}
