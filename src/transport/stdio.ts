/** Byte transport only: supervision, newline framing, lossless write-before-delivery. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";
import { SessionStore } from "../persistence.js";
import { SUPERVISOR_SPEC_ENV, type SupervisorSpec } from "../runtime.js";

export class StdioTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parts: Buffer[] = [];
  private size = 0;
  private overflow = false;
  private closePromise: Promise<void> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private gone = false;
  private stderrPartial = Buffer.alloc(0);
  constructor(readonly store: SessionStore, readonly maxLineBytes: number) { super(); }
  start(spec: SupervisorSpec): void {
    if (this.child) throw new BridgeError("already_started", "transport already started");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../supervisor.js", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"], detached: true,
      env: { ...process.env, [SUPERVISOR_SPEC_ENV]: JSON.stringify(spec) },
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    child.stdin.on("error", error => this.emit("fault", new BridgeError("transport_error", error.message)));
    child.stdout.on("data", (chunk: Buffer) => {
      try { this.receive(chunk); } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try { this.receiveStderr(chunk); } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
    });
    child.on("error", error => this.emit("fault", new BridgeError("transport_error", error.message)));
    child.once("close", (code, signal) => {
      this.gone = true;
      try {
        if (this.size && !this.overflow) this.deliver();
        if (this.stderrPartial.length) this.store.wire("stderr", this.stderrPartial);
        this.store.event("transport_exited", { code, signal });
      } catch (error) { this.emit("fault", new BridgeError("storage_error", String(error))); }
      this.emit("exit", { code, signal });
    });
  }
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
    if (end) this.store.wire("stderr", bytes.subarray(0, end));
    this.stderrPartial = Buffer.from(bytes.subarray(end));
  }
  receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const piece = chunk.subarray(offset, end);
      if (this.overflow) this.store.wire("stdout", piece, true);
      else if (this.size + piece.length - (newline < 0 ? 0 : 1) > this.maxLineBytes) {
        for (const part of this.parts) this.store.wire("stdout", part, true);
        this.store.wire("stdout", piece, true);
        this.parts = []; this.size = 0; this.overflow = true;
        this.emit("fault", new BridgeError("line_too_large", `ACP line exceeds ${this.maxLineBytes} bytes`));
      } else {
        this.parts.push(piece); this.size += piece.length;
        if (newline >= 0) this.deliver();
      }
      if (newline >= 0 && this.overflow) this.overflow = false;
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
