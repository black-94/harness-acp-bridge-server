/**
 * Session persistence primitives.
 *
 * Ports the reference behaviour from `harness_acp_mcp/output_log.py` (bounded,
 * append-only JSON-lines log) and `harness_acp_mcp/privacy.py` (credential redaction),
 * and adds the pieces the asynchronous per-session queue needs:
 *
 *   <session_dir>/                       e.g. ~/.harness-acp-bridge/2026-09-27-1a2b3c4d/
 *     raw.jsonl     append-only, redacted raw ACP traffic (input + output + stderr)
 *     log.txt       append-only human-readable lifecycle log
 *     preview.txt   size-limited rolling preview, appended incrementally so a
 *                   `live_output` follower can tail it
 *     state.json    atomic session-state snapshot
 *     queue.json    atomic queue/message-state snapshot, INCLUDING the idempotency index
 *                   (opaque key -> message id) so a message and its key mapping commit
 *                   together in one rename
 *     results/      atomic per-message result snapshots (<message_id>.json)
 *     meta.json     atomic session metadata (creation params + effective echo, redacted)
 *
 * `idempotency.json` is only ever *read* as a backward-compatibility fallback for a session
 * written by an earlier layout; it is no longer written.
 *
 * The raw stream and the log are append-only. State, queue, result and meta snapshots are
 * written atomically (temp file + rename) so a reader or a restarted process never sees a
 * half-written snapshot. Every persisted record is redacted first.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
  type FSWatcher,
  type WriteStream,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const REDACTED = "[redacted]";

/**
 * The only account fields ever echoed back for display. A real ACP server can return
 * live credentials (`token`, `accessToken`) inside its account object, so results are
 * rebuilt from this whitelist instead of forwarding the harness object verbatim.
 */
export const ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
  "userId",
  "user_id",
  "username",
  "userName",
  "name",
  "displayName",
  "nickname",
  "email",
]);

// Key names that mark a value as a credential. Matched case-insensitively against object
// keys only (never free text), so a credential in a JSON field can never be persisted.
const SENSITIVE_KEY_RE =
  /token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key/i;

// Free text (stderr lines, unparsable strings) has no structure to key off, so mask a
// credential-looking `key: value` / `key=value` assignment and scheme-prefixed secrets
// as a best-effort second line of defense.
const SENSITIVE_ASSIGNMENT_RE =
  /(?<key>[A-Za-z0-9_.'"-]*(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key)[A-Za-z0-9_.'"-]*)(?<sep>\s*[:=]\s*)(?<value>[^\n,}]+)/gi;
const SCHEME_SECRET_RE = /\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{6,})/gi;

export function isSensitiveKey(name: unknown): boolean {
  return typeof name === "string" && SENSITIVE_KEY_RE.test(name);
}

/** Return the whitelisted, display-only subset of a harness account object. */
export function publicAccount(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const account: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ACCOUNT_FIELDS.has(key) || isSensitiveKey(key)) continue;
    if (typeof item !== "string" && typeof item !== "number") continue;
    if (typeof item === "string" && !item.trim()) continue;
    account[key] = item;
  }
  return Object.keys(account).length > 0 ? account : null;
}

function redactText(text: string): string {
  const stripped = text.trim();
  if (stripped.startsWith("{") || stripped.startsWith("[")) {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(stripped)));
    } catch {
      // Not JSON after all; fall through to text patterns.
    }
  }
  const masked = text.replace(SCHEME_SECRET_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  return masked.replace(
    SENSITIVE_ASSIGNMENT_RE,
    (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  );
}

/**
 * Recursively replace credentials with a placeholder without mutating the input.
 *
 * Called on every record persisted to the raw stream and on every snapshot, so a harness
 * token is neither written to disk nor echoed back.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(item);
    }
    return output;
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

export type RawStream = "client" | "stdout" | "stderr" | "note";

export const RAW_FILE = "raw.jsonl";
export const LOG_FILE = "log.txt";
export const PREVIEW_FILE = "preview.txt";
export const META_FILE = "meta.json";
export const STATE_FILE = "state.json";
export const QUEUE_FILE = "queue.json";
export const IDEMPOTENCY_FILE = "idempotency.json";
export const RESULTS_DIR = "results";

export const DEFAULT_PREVIEW_BYTES = 16 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const FILE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export class PersistenceError extends Error {
  override name = "PersistenceError";
}

function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Session id and directory name: `<YYYY-MM-DD>-<random>`. */
export function newSessionId(date: Date = new Date()): string {
  return `${localDateStamp(date)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

/** Absolute session directory for `sessionId` under the configured session root. */
export function sessionDirectory(rootDir: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new PersistenceError(`invalid session id: ${JSON.stringify(sessionId)}`);
  }
  const root = resolve(rootDir);
  const directory = join(root, sessionId);
  if (!directory.startsWith(`${root}/`) && directory !== root) {
    throw new PersistenceError(`session directory escapes the session root: ${directory}`);
  }
  return directory;
}

/** Atomic write (temp file + rename) with the credential redaction pass applied. */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  writeAtomicFileSync(path, `${JSON.stringify(redactSensitive(value), null, 2)}\n`);
}

/** Atomic text write (temp file + rename). */
export function writeAtomicFileSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Read a JSON object from a regular, non-symlinked file.
 *
 * Used by the persisted-session reader, where following a symlink out of the session
 * directory would be a read primitive an attacker could plant.
 */
export function readJsonFileSafe(path: string): Record<string, unknown> | null {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return null;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read a regular, non-symlinked file as bytes. */
export function readFileBufferSafe(path: string): Buffer | null {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return null;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Opaque index token for a caller-supplied idempotency key.
 *
 * Keys are hashed (never stored raw) so the persisted index stays fixed-width and
 * credential-free — the same rationale as the authentication ledger's target key.
 */
export const IDEMPOTENCY_TOKEN_RE = /^[0-9a-f]{64}$/;

export interface IdempotencyRecord {
  message_id: string;
  /** Fingerprint of the normalized mode + text the key was first used with. */
  request_hash: string;
  created_at: string;
}

/** SHA-256 hex token for an idempotency key. Deterministic, collision-resistant. */
export function idempotencyKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Fingerprint of a request for idempotency comparison: the normalized `mode` and the exact
 * `text`, hashed so the index never stores the prompt a second time.
 */
export function idempotencyRequestHash(mode: string, text: string): string {
  return createHash("sha256").update(`${mode}\u0000${text}`, "utf8").digest("hex");
}

/** Keep only well-formed entries; a malformed or legacy file degrades to an empty index. */
export function parseIdempotencyIndex(value: unknown): Record<string, IdempotencyRecord> {
  const index: Record<string, IdempotencyRecord> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return index;
  for (const [token, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!IDEMPOTENCY_TOKEN_RE.test(token)) continue;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.message_id !== "string" || typeof record.request_hash !== "string") continue;
    index[token] = {
      message_id: record.message_id,
      request_hash: record.request_hash,
      created_at: typeof record.created_at === "string" ? record.created_at : "",
    };
  }
  return index;
}

export interface PreviewWindow {
  start: number;
  end: number;
  bytes: number;
}/**
 * Slice the rolling preview window at an absolute byte offset.
 *
 * Pure so both the live session reader and the post-restart reader use identical
 * offset/truncation semantics.
 */
export function slicePreviewWindow(
  buffer: Buffer,
  window: PreviewWindow,
  from: number | null,
  maxBytes: number,
): { text: string; offset: number; nextOffset: number; truncated: boolean; droppedBytes: number } {
  const requested = from ?? window.start;
  let offset = Math.max(0, Math.floor(requested));
  let truncated = false;
  let droppedBytes = 0;
  if (offset < window.start) {
    truncated = true;
    droppedBytes = window.start - offset;
    offset = window.start;
  }
  if (offset > window.end) offset = window.end;
  const limit = Math.max(1, Math.floor(maxBytes));
  const to = Math.min(window.end, offset + limit);
  let text = "";
  if (to > offset && window.bytes > 0 && buffer.length > 0) {
    const start = offset - window.start;
    const end = Math.min(buffer.length, to - window.start);
    if (start < buffer.length && end > start) text = buffer.subarray(start, end).toString("utf8");
  }
  return { text, offset, nextOffset: to, truncated, droppedBytes };
}

/** Cap for one `live_output` long-poll wait. */
export const MAX_PREVIEW_WAIT_MS = 30_000;
const DEFAULT_PREVIEW_WAIT_POLL_MS = 250;

/**
 * Long-poll the preview file until it changes, the stream settles, the wait elapses, or the
 * caller aborts (socket disconnect).
 *
 * `fs.watch` gives prompt wakeups on append *and* on the in-place truncation the rolling
 * window performs; a short interval poll is kept as a fallback because `fs.watch` can miss
 * or error on some filesystems. Every listener and the watcher itself are removed before
 * returning, so a disconnect cannot leak a watcher.
 */
export async function awaitPreviewActivity(options: {
  previewPath: string;
  waitMs: number;
  isSettled: () => boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<{ waitedMs: number; settled: boolean; aborted: boolean }> {
  const waitMs = Math.max(0, Math.min(MAX_PREVIEW_WAIT_MS, Math.floor(options.waitMs)));
  if (waitMs === 0) return { waitedMs: 0, settled: options.isSettled(), aborted: false };
  const pollMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_PREVIEW_WAIT_POLL_MS);
  const started = Date.now();

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(options.previewPath);
    // A watcher 'error' event is otherwise unhandled and would crash the daemon; the
    // interval poll still wakes us if the watcher is broken.
    watcher.on("error", () => undefined);
  } catch {
    watcher = null;
  }

  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  if (options.signal?.aborted) abortController.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (options.isSettled()) {
        return { waitedMs: Date.now() - started, settled: true, aborted: false };
      }
      if (abortController.signal.aborted) {
        return { waitedMs: Date.now() - started, settled: false, aborted: true };
      }
      const remaining = waitMs - (Date.now() - started);
      if (remaining <= 0) {
        return { waitedMs: Date.now() - started, settled: false, aborted: false };
      }
      await waitForActivity(watcher, Math.min(pollMs, remaining), abortController.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    watcher?.close();
  }
}

function waitForActivity(
  watcher: FSWatcher | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.off("change", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    watcher?.on("change", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** File name of a message result snapshot; validates the id is a single safe segment. */
export function resultFileName(messageId: string): string {
  if (!FILE_ID_RE.test(messageId)) {
    throw new PersistenceError(`invalid message id: ${JSON.stringify(messageId)}`);
  }
  return `${messageId}.json`;
}

/**
 * A rolling, byte-bounded text window.
 *
 * Chunks are appended and the oldest chunks are dropped once the byte budget is
 * exceeded. A single oversized chunk is truncated at the front, so the window always
 * holds the most recent text at or below `maxBytes`.
 */
export class RollingPreview {
  private chunks: string[] = [];
  private bytes = 0;
  private totalBytes = 0;
  private truncatedFlag = false;

  constructor(private readonly maxBytes: number = DEFAULT_PREVIEW_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new PersistenceError("preview maxBytes must be a positive integer");
    }
  }

  append(text: string): void {
    if (!text) return;
    const size = Buffer.byteLength(text, "utf8");
    this.totalBytes += size;
    this.chunks.push(text);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift() as string;
      this.bytes -= Buffer.byteLength(dropped, "utf8");
      this.truncatedFlag = true;
    }
    if (this.bytes > this.maxBytes) {
      const only = this.chunks[0] as string;
      const buffer = Buffer.from(only, "utf8");
      const tail = buffer.subarray(buffer.length - this.maxBytes).toString("utf8");
      this.chunks[0] = tail;
      this.bytes = Buffer.byteLength(tail, "utf8");
      this.truncatedFlag = true;
    }
  }

  reset(): void {
    this.chunks = [];
    this.bytes = 0;
    this.totalBytes = 0;
    this.truncatedFlag = false;
  }

  text(): string {
    return this.chunks.join("");
  }

  get byteLength(): number {
    return this.bytes;
  }

  /** Bytes seen before trimming; larger than `byteLength` once the window rolls over. */
  get totalByteLength(): number {
    return this.totalBytes;
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }
}

export interface SessionSnapshot {
  sessionId: string;
  directory: string;
  rawPath: string;
  logPath: string;
  previewPath: string;
  metaPath: string;
  statePath: string;
  queuePath: string;
  idempotencyPath: string;
  resultsDir: string;
  rawBytes: number;
  rawLines: number;
  previewBytes: number;
  previewFileBytes: number;
  previewTotalBytes: number;
  previewTruncated: boolean;
  createdAt: string;
}

export interface SessionRecorderOptions {
  /** Session root directory (usually `config.paths.sessionDir`). */
  rootDir: string;
  /** Session id / directory name; must be a safe path segment. */
  sessionId: string;
  /** Cap for both the in-memory rolling preview and the preview file. */
  previewBytes?: number;
  maxEntryBytes?: number;
}

export interface SessionMeta {
  sessionId: string;
  harness: string;
  modelId: string;
  cwd: string;
  harnessSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/**
 * Owns one session directory: the append-only raw stream and log, the size-limited
 * tail-able preview, and the atomic state/queue/result/meta snapshots.
 */
export class SessionRecorder {
  readonly sessionId: string;
  readonly directory: string;
  readonly rawPath: string;
  readonly logPath: string;
  readonly previewPath: string;
  readonly metaPath: string;
  readonly statePath: string;
  readonly queuePath: string;
  readonly idempotencyPath: string;
  readonly resultsDir: string;
  readonly createdAt: string;

  private readonly preview: RollingPreview;
  private readonly previewMaxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly stream: WriteStream;
  private readonly previewFd: number;
  private previewFileBytes: number;
  private rawBytes = 0;
  private rawLines = 0;
  private closed = false;
  private streamError: Error | null = null;

  constructor(options: SessionRecorderOptions) {
    this.sessionId = options.sessionId;
    this.directory = sessionDirectory(options.rootDir, options.sessionId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.rawPath = join(this.directory, RAW_FILE);
    this.logPath = join(this.directory, LOG_FILE);
    this.previewPath = join(this.directory, PREVIEW_FILE);
    this.metaPath = join(this.directory, META_FILE);
    this.statePath = join(this.directory, STATE_FILE);
    this.queuePath = join(this.directory, QUEUE_FILE);
    this.idempotencyPath = join(this.directory, IDEMPOTENCY_FILE);
    this.resultsDir = join(this.directory, RESULTS_DIR);
    mkdirSync(this.resultsDir, { recursive: true, mode: 0o700 });
    this.previewMaxBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
    this.preview = new RollingPreview(this.previewMaxBytes);
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.createdAt = new Date().toISOString();
    this.stream = createWriteStream(this.rawPath, { flags: "a", mode: 0o600 });
    this.stream.on("error", (error) => {
      this.streamError = error instanceof Error ? error : new Error(String(error));
    });
    this.previewFd = openSync(this.previewPath, "a", 0o600);
    // Reopening an existing session keeps the size cap correct.
    this.previewFileBytes = existsSync(this.previewPath) ? statSync(this.previewPath).size : 0;
  }

  get rawSizeBytes(): number {
    return this.rawBytes;
  }

  get rawLineCount(): number {
    return this.rawLines;
  }

  /** Total preview bytes ever appended (monotonic); the absolute offset ceiling. */
  get previewTotalBytes(): number {
    return this.preview.totalByteLength;
  }

  /**
   * The byte window currently retained on disk: `[start, end)` in absolute preview
   * offsets. `start` grows once the cap rolls the window over.
   */
  previewWindow(): { start: number; end: number; bytes: number } {
    const end = this.preview.totalByteLength;
    return { start: Math.max(0, end - this.previewFileBytes), end, bytes: this.previewFileBytes };
  }

  /**
   * Read a slice of the preview by absolute byte offset.
   *
   * An offset below the retained window is reported as truncated and clamped forward, so a
   * polling caller learns that it fell behind instead of silently receiving a hole.
   */
  readPreviewChunk(
    from: number | null,
    maxBytes: number,
  ): { text: string; offset: number; nextOffset: number; truncated: boolean; droppedBytes: number } {
    const window = this.previewWindow();
    const buffer = window.bytes > 0 ? (readFileBufferSafe(this.previewPath) ?? Buffer.alloc(0)) : Buffer.alloc(0);
    return slicePreviewWindow(buffer, window, from, maxBytes);
  }

  previewText(): string {
    return this.preview.text();
  }

  previewSize(): number {
    return this.preview.byteLength;
  }

  resetPreview(): void {
    this.preview.reset();
    ftruncateSync(this.previewFd, 0);
    this.previewFileBytes = 0;
  }

  /**
   * Append a preview chunk to the rolling window and to `preview.txt`.
   *
   * The file is appended incrementally so a `live_output` follower can tail it, and it is
   * compacted back down to the in-memory window once it exceeds the byte cap.
   */
  appendPreview(text: string): void {
    if (!text) return;
    this.preview.append(text);
    try {
      const buffer = Buffer.from(text, "utf8");
      writeSync(this.previewFd, buffer);
      this.previewFileBytes += buffer.length;
      if (this.previewFileBytes > this.previewMaxBytes) {
        const kept = Buffer.from(this.preview.text(), "utf8");
        ftruncateSync(this.previewFd, 0);
        writeSync(this.previewFd, kept);
        this.previewFileBytes = kept.length;
      }
    } catch (error) {
      // The preview is advisory; never let it break a turn.
      this.streamError ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Append one redacted record to the append-only raw stream. */
  appendRaw(stream: RawStream, value: unknown): void {
    if (this.closed) return;
    let record = {
      timestamp: new Date().toISOString(),
      stream,
      value: redactSensitive(value),
    };
    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.maxEntryBytes) {
      record = {
        timestamp: record.timestamp,
        stream,
        value: {
          error: "raw entry exceeded the tracking limit and was omitted",
          bytes: Buffer.byteLength(line, "utf8"),
        },
      };
      line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line, "utf8") > this.maxEntryBytes) return;
    }
    this.rawBytes += Buffer.byteLength(line, "utf8");
    this.rawLines += 1;
    this.stream.write(line);
  }

  /** Append one human-readable line to the append-only `log.txt`. */
  appendLog(text: string): void {
    if (this.closed) return;
    try {
      appendFileSync(this.logPath, `[${new Date().toISOString()}] ${text}\n`, { mode: 0o600 });
    } catch (error) {
      this.streamError ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  writeMeta(meta: Record<string, unknown>): void {
    writeJsonAtomicSync(this.metaPath, meta);
  }

  readMeta(): Record<string, unknown> | null {
    return readJsonFileSafe(this.metaPath);
  }

  writeState(state: Record<string, unknown>): void {
    writeJsonAtomicSync(this.statePath, state);
  }

  readState(): Record<string, unknown> | null {
    return readJsonFileSafe(this.statePath);
  }

  /** Replace the queue/message snapshot atomically (the authoritative commit). */
  writeQueue(queue: Record<string, unknown>): void {
    writeJsonAtomicSync(this.queuePath, queue);
  }

  readQueue(): Record<string, unknown> | null {
    return readJsonFileSafe(this.queuePath);
  }

  /**
   * Read the idempotency index, which is committed inside `queue.json` together with the
   * messages, so the two can never disagree after a crash.
   *
   * A session written by an earlier layout may instead carry a standalone `idempotency.json`;
   * that file is read as a fallback and never written.
   */
  readIdempotency(): Record<string, IdempotencyRecord> {
    const queue = readJsonFileSafe(this.queuePath);
    if (queue && "idempotency" in queue) return parseIdempotencyIndex(queue.idempotency);
    return parseIdempotencyIndex(readJsonFileSafe(this.idempotencyPath));
  }

  writeResult(messageId: string, result: Record<string, unknown>): void {
    writeJsonAtomicSync(join(this.resultsDir, resultFileName(messageId)), result);
  }

  readResult(messageId: string): Record<string, unknown> | null {
    return readJsonFileSafe(join(this.resultsDir, resultFileName(messageId)));
  }

  /** Resolve once every raw record queued so far has been handed to the OS. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      if (this.streamError) {
        reject(this.streamError);
        return;
      }
      this.stream.write("", (error) => (error ? reject(error) : resolvePromise()));
    });
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      directory: this.directory,
      rawPath: this.rawPath,
      logPath: this.logPath,
      previewPath: this.previewPath,
      metaPath: this.metaPath,
      statePath: this.statePath,
      queuePath: this.queuePath,
      idempotencyPath: this.idempotencyPath,
      resultsDir: this.resultsDir,
      rawBytes: this.rawBytes,
      rawLines: this.rawLines,
      previewBytes: this.preview.byteLength,
      previewFileBytes: this.previewFileBytes,
      previewTotalBytes: this.preview.totalByteLength,
      previewTruncated: this.preview.truncated,
      createdAt: this.createdAt,
    };
  }

  /** Flush the raw stream and release the file handles. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolvePromise) => {
      this.stream.end(() => resolvePromise());
    });
    try {
      closeSync(this.previewFd);
    } catch {
      // Already closed.
    }
  }
}

/** Remove a session directory (used by retention/reaping in later stages). */
export async function removeSession(baseDir: string, sessionId: string): Promise<void> {
  await rm(sessionDirectory(baseDir, sessionId), { recursive: true, force: true });
}

// --- post-close / post-restart readers ---------------------------------------
// These read only the atomic snapshots, so a caller in a fresh process can recover a
// closed session's status, queue and per-message results.

export function readPersistedState(sessionDir: string): Record<string, unknown> | null {
  return readJsonFileSafe(join(sessionDir, STATE_FILE));
}

export function readPersistedQueue(sessionDir: string): Record<string, unknown> | null {
  return readJsonFileSafe(join(sessionDir, QUEUE_FILE));
}

export function readPersistedResult(
  sessionDir: string,
  messageId: string,
): Record<string, unknown> | null {
  return readJsonFileSafe(join(sessionDir, RESULTS_DIR, resultFileName(messageId)));
}

/** Read the tail of a session's preview file, bounded by `maxBytes`. */
export function readPersistedPreview(sessionDir: string, maxBytes = 64 * 1024): string | null {
  const path = join(sessionDir, PREVIEW_FILE);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= maxBytes ? text : buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

export function readPersistedMeta(sessionDir: string): Record<string, unknown> | null {
  return readJsonFileSafe(join(sessionDir, META_FILE));
}
