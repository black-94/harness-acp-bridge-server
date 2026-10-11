/** Append-only, lossless event journal and atomic session/message snapshots. */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Redactor } from "./redact.js";

export const RAW_FILE = "raw.jsonl";
export const SESSION_FILE = "session.json";
export const QUEUE_FILE = "queue.json";
export const RESULTS_DIR = "results";
export const isValidSessionId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);
export function newSessionId(): string {
  return `${new Date().toISOString().slice(0, 10)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
export function sessionDirectory(root: string, id: string): string {
  if (!isValidSessionId(id)) throw new Error("invalid session_id");
  return join(resolve(root), id);
}
export function writeAtomicFileSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function writeJsonAtomicSync(path: string, value: unknown, redactor?: Redactor): void {
  writeAtomicFileSync(path, `${JSON.stringify(redactor ? redactor.value(value) : value, null, 2)}\n`);
}
export function readJsonFileSafe(path: string): Record<string, unknown> | null {
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export interface RawEvent {
  version: 1;
  seq: number;
  timestamp: string;
  session_id: string;
  message_id: string | null;
  type: "transport" | "lifecycle";
  stream?: "stdin" | "stdout" | "stderr";
  encoding?: "base64";
  raw?: string;
  fragment?: boolean;
  event?: string;
  data?: unknown;
}
export class SessionStore extends EventEmitter {
  readonly directory: string;
  readonly rawPath: string;
  private seq = 0;
  messageId: string | null = null;
  constructor(root: string, readonly sessionId: string, readonly redactor: Redactor = new Redactor()) {
    super();
    this.directory = sessionDirectory(root, sessionId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(this.directory, { mode: 0o700 });
    mkdirSync(join(this.directory, RESULTS_DIR), { mode: 0o700 });
    this.rawPath = join(this.directory, RAW_FILE);
    writeFileSync(this.rawPath, "", { mode: 0o600, flag: "wx" });
  }
  private append(fields: Partial<RawEvent>): RawEvent {
    const record: RawEvent = {
      version: 1, seq: ++this.seq, timestamp: new Date().toISOString(),
      session_id: this.sessionId, message_id: this.messageId, type: "lifecycle", ...fields,
    };
    appendFileSync(this.rawPath, `${JSON.stringify(record)}\n`);
    this.emit("append");
    return record;
  }
  wire(stream: "stdin" | "stdout" | "stderr", raw: Buffer, fragment = false): RawEvent {
    // The on-disk copy is redacted; the original bytes are delivered/written unchanged elsewhere.
    const safe = this.redactor.bytes(raw);
    return this.append({ type: "transport", stream, encoding: "base64", raw: safe.toString("base64"), fragment });
  }
  event(event: string, data?: unknown): RawEvent { return this.append({ type: "lifecycle", event, data: this.redactor.value(data) }); }
  session(value: unknown): void { writeJsonAtomicSync(join(this.directory, SESSION_FILE), this.redactor.value(value)); }
  queue(value: unknown): void { writeJsonAtomicSync(join(this.directory, QUEUE_FILE), this.redactor.value(value)); }
  result(id: string, value: unknown): void {
    if (!isValidSessionId(id)) throw new Error("invalid message_id");
    writeJsonAtomicSync(join(this.directory, RESULTS_DIR, `${id}.json`), this.redactor.value(value));
  }
}
