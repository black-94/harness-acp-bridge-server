/**
 * Read-only recovery of a persisted session.
 *
 * `message_result` and `live_output` must keep working after `close_session` (which removes
 * the session from the live registry) and after a daemon restart (where the registry is empty).
 * This module opens a session directory **read-only** and serves status/result/preview from the
 * atomic snapshots.
 *
 * Safety rules, all enforced here rather than at the call sites:
 *   - the session id must be a single path segment (no separators, no `..`);
 *   - the directory is resolved under the configured session root only;
 *   - the directory must be a real directory, not a symlink, and its realpath must be
 *     exactly `<sessionRoot>/<sessionId>` (so no symlinked ancestor can redirect the read);
 *   - snapshot and preview files are read only when they are regular files and not symlinks.
 *
 * A daemon that restarts finds the previous run's `running`/`queued`/`waiting_input`
 * messages still non-terminal on disk, because their harness process is gone. Those are
 * reconciled exactly once into a terminal `failed` state with `error.code: "interrupted"`
 * and `orphaned: true`, so a poller can never hang on a message that will never advance.
 */
import { dirname, join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

import {
  IDEMPOTENCY_FILE,
  IDEMPOTENCY_TOKEN_RE,
  MAX_PREVIEW_WAIT_MS,
  PREVIEW_FILE,
  QUEUE_FILE,
  RESULTS_DIR,
  STATE_FILE,
  isValidSessionId,
  parseIdempotencyIndex,
  readFileBufferSafe,
  readJsonFileSafe,
  resultFileName,
  slicePreviewWindow,
  writeJsonAtomicSync,
  awaitPreviewActivity,
  type IdempotencyRecord,
  type PreviewWindow,
} from "./persistence.js";

export type PersistedMessageState =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_MAX_BYTES = 1024 * 1024;

export function isTerminalPersistedState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve `<sessionRoot>/<sessionId>` to a real directory, or `null` when it is absent or
 * unsafe (symlink, non-directory, escaping path, invalid id).
 */
export function resolvePersistedDirectory(sessionRoot: string, sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  let rootReal: string;
  try {
    rootReal = realpathSync(sessionRoot);
  } catch {
    return null;
  }
  const candidate = join(rootReal, sessionId);
  let entry;
  try {
    entry = lstatSync(candidate);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  // Exact match rejects both symlinked session dirs and symlinked ancestors.
  if (real !== candidate) return null;
  if (dirname(real) !== rootReal) return null;
  return real;
}

export interface PersistedOutputOptions {
  messageId?: string | null;
  offset?: number | null;
  maxBytes?: number;
  stop?: boolean;
  waitMs?: number;
  signal?: AbortSignal;
}

export interface PersistedLiveOutput {
  session_id: string;
  message_id: string | null;
  chunk: string;
  offset: number;
  next_offset: number;
  max_bytes: number;
  truncated: boolean;
  dropped_bytes: number;
  stopped: boolean;
  state: string;
  terminal: boolean;
  window_start: number;
  window_end: number;
  message_end_offset: number | null;
  waited_ms: number;
  persisted: true;
  orphaned: boolean;
}

export class PersistedSession {
  readonly sessionId: string;
  readonly directory: string;

  private constructor(sessionId: string, directory: string) {
    this.sessionId = sessionId;
    this.directory = directory;
  }

  /** Open a persisted session, or return `null` when it is absent or unsafe. */
  static open(sessionRoot: string, sessionId: string): PersistedSession | null {
    const directory = resolvePersistedDirectory(sessionRoot, sessionId);
    if (directory === null) return null;
    if (readJsonFileSafe(join(directory, STATE_FILE)) === null) return null;
    const session = new PersistedSession(sessionId, directory);
    // Reconcile in-flight messages from a previous daemon run before anyone reads them, so
    // no message can remain non-terminal forever. Idempotent and a no-op when all messages
    // are already terminal.
    session.reconcileOrphans();
    return session;
  }

  state(): Record<string, unknown> {
    return readJsonFileSafe(join(this.directory, STATE_FILE)) ?? {};
  }

  private queue(): Record<string, unknown> {
    return readJsonFileSafe(join(this.directory, QUEUE_FILE)) ?? {};
  }

  entries(): Map<string, Record<string, unknown>> {
    const messages = this.queue().messages;
    const result = new Map<string, Record<string, unknown>>();
    if (!isRecord(messages)) return result;
    for (const [messageId, entry] of Object.entries(messages)) {
      if (isRecord(entry)) result.set(messageId, entry);
    }
    return result;
  }

  private previewBuffer(): Buffer | null {
    return readFileBufferSafe(join(this.directory, PREVIEW_FILE));
  }

  /** `[total - fileBytes, total)` using the persisted total, or `[0, fileBytes)` if absent. */
  previewWindow(): PreviewWindow {
    const buffer = this.previewBuffer();
    const bytes = buffer?.length ?? 0;
    const total = this.state().preview_total_bytes;
    const end = typeof total === "number" && Number.isFinite(total) && total >= bytes ? total : bytes;
    return { start: Math.max(0, end - bytes), end, bytes };
  }

  sessionOrphaned(): boolean {
    return this.state().state === "interrupted";
  }

  private entryOrphaned(entry: Record<string, unknown>): boolean {
    return entry.orphaned === true || this.sessionOrphaned();
  }

  /**
   * Status (plus result fields once terminal) for one message from the persisted snapshots.
   *
   * A non-terminal entry reports status alone, mirroring the live session: result fields are
   * added only for a terminal message. A terminal entry whose result snapshot is missing is
   * synthesized from the queue snapshot, so a terminal message never loses its answer.
   */
  messageResult(messageId: string): Record<string, unknown> | null {
    const entry = this.entries().get(messageId) ?? null;
    if (entry && isTerminalPersistedState(String(entry.state ?? ""))) {
      restoreResultIfMissing(this.directory, messageId, entry);
    }
    const persisted = this.resultEntry(messageId);
    if (!entry && !persisted) return null;

    const source = entry ?? (persisted as Record<string, unknown>);
    const state = typeof source.state === "string" ? source.state : "failed";
    const terminal = isTerminalPersistedState(state);
    const result: Record<string, unknown> = {
      message_id: messageId,
      state,
      terminal,
      mode: source.mode === "steering" ? "steering" : "queue",
      seq: typeof source.seq === "number" ? source.seq : 0,
      created_at: typeof source.created_at === "string" ? source.created_at : "",
      started_at: typeof source.started_at === "string" ? source.started_at : null,
      finished_at: typeof source.finished_at === "string" ? source.finished_at : null,
      queue_position: null,
      cancellable: false,
      interaction: null,
      cancelled_by: typeof source.cancelled_by === "string" ? source.cancelled_by : null,
      cancel_reason: typeof source.cancel_reason === "string" ? source.cancel_reason : null,
      stop_reason: typeof source.stop_reason === "string" ? source.stop_reason : null,
      error: isRecord(source.error) ? source.error : null,
      preview_bytes:
        typeof source.preview_bytes === "number" ? source.preview_bytes : this.previewWindow().bytes,
      output_start_offset:
        typeof source.output_start_offset === "number" ? source.output_start_offset : null,
      output_end_offset: typeof source.output_end_offset === "number" ? source.output_end_offset : null,
      result_available: terminal,
      orphaned: entry ? this.entryOrphaned(entry) : this.sessionOrphaned(),
      persisted: true,
    };
    if (!terminal) return result;
    result.text = persisted && typeof persisted.text === "string" ? persisted.text : null;
    result.tool_calls = persisted && Array.isArray(persisted.tool_calls) ? persisted.tool_calls : [];
    result.harness_session_id =
      persisted && typeof persisted.harness_session_id === "string" ? persisted.harness_session_id : null;
    return result;
  }

  private resultEntry(messageId: string): Record<string, unknown> | null {
    try {
      return readJsonFileSafe(join(this.directory, RESULTS_DIR, resultFileName(messageId)));
    } catch {
      return null;
    }
  }

  /**
   * The persisted idempotency record for an opaque key token, or `null`.
   *
   * The index is committed inside `queue.json` alongside the messages, so a message and its
   * key mapping are always visible together. A legacy standalone `idempotency.json` (an
   * earlier layout) is read as a fallback. Read-only: lets a restarted daemon resolve a
   * retried `send_message` idempotency key to the message it was first used with, even
   * though the session is no longer live.
   */
  idempotencyEntry(token: string): IdempotencyRecord | null {
    if (!IDEMPOTENCY_TOKEN_RE.test(token)) return null;
    const queue = readJsonFileSafe(join(this.directory, QUEUE_FILE));
    if (queue && "idempotency" in queue) {
      return parseIdempotencyIndex(queue.idempotency)[token] ?? null;
    }
    return parseIdempotencyIndex(readJsonFileSafe(join(this.directory, IDEMPOTENCY_FILE)))[token] ?? null;
  }

  /** Session-level status for a persisted (closed or interrupted) session. */
  sessionStatus(): Record<string, unknown> {
    const state = this.state();
    const entries = this.entries();
    const window = this.previewWindow();
    return {
      session_id: this.sessionId,
      directory: this.directory,
      harness: state.harness ?? null,
      state: state.state ?? "closed",
      authenticated: state.authenticated === true,
      model_id: state.model_id ?? null,
      model_name: state.model_name ?? null,
      harness_session_id: state.harness_session_id ?? null,
      cwd: state.cwd ?? null,
      permission_mode: state.permission_mode ?? null,
      created_at: state.created_at ?? null,
      updated_at: state.updated_at ?? null,
      closed_at: state.closed_at ?? null,
      running_message_id: null,
      queued_message_ids: [],
      messages_total: entries.size,
      preview_bytes: window.bytes,
      harness_models: [],
      orphaned: state.state === "interrupted",
      persisted: true,
    };
  }

  /** Read the rolling preview, with the same offset/truncation semantics as a live session. */
  readOutput(options: PersistedOutputOptions = {}): PersistedLiveOutput {
    const window = this.previewWindow();
    const maxBytes = Math.min(
      MAX_MAX_BYTES,
      Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES)),
    );
    const entry = options.messageId ? this.entries().get(options.messageId) : undefined;
    if (options.messageId && !entry) {
      throw new Error(`unknown message: ${options.messageId}`);
    }
    const state = entry ? String(entry.state ?? "failed") : String(this.state().state ?? "closed");
    const terminal = entry ? isTerminalPersistedState(state) : true;
    const messageEndOffset =
      entry && typeof entry.output_end_offset === "number" ? entry.output_end_offset : null;
    const base = {
      session_id: this.sessionId,
      message_id: options.messageId ?? null,
      max_bytes: maxBytes,
      state,
      terminal,
      window_start: window.start,
      window_end: window.end,
      message_end_offset: messageEndOffset,
      persisted: true as const,
      orphaned: entry ? this.entryOrphaned(entry) : this.sessionOrphaned(),
    };

    if (options.stop) {
      const offset = Math.max(0, Math.floor(options.offset ?? window.end));
      return {
        ...base,
        chunk: "",
        offset,
        next_offset: offset,
        truncated: false,
        dropped_bytes: 0,
        stopped: true,
        waited_ms: 0,
      };
    }

    const messageStart = entry && typeof entry.output_start_offset === "number" ? entry.output_start_offset : null;
    const from = options.offset ?? (entry ? (messageStart ?? window.end) : window.start);
    const slice = this.readSlice(from, maxBytes);
    const stopped = entry
      ? terminal && messageEndOffset !== null && slice.nextOffset >= messageEndOffset
      : true;
    return {
      ...base,
      chunk: slice.text,
      offset: slice.offset,
      next_offset: slice.nextOffset,
      truncated: slice.truncated,
      dropped_bytes: slice.droppedBytes,
      stopped,
      waited_ms: 0,
    };
  }

  /**
   * Long-poll variant of `readOutput`. A persisted session's files only change if another
   * process writes them, but the same bounded wait keeps the tool contract uniform and still
   * honours a socket disconnect via `signal`.
   */
  async listenOutput(options: PersistedOutputOptions = {}): Promise<PersistedLiveOutput> {
    const waitMs = Math.max(0, Math.min(MAX_PREVIEW_WAIT_MS, Math.floor(options.waitMs ?? 0)));
    if (waitMs === 0) return this.readOutput(options);
    const settled = (): boolean => {
      try {
        const output = this.readOutput(options);
        return output.chunk.length > 0 || output.stopped;
      } catch {
        return true;
      }
    };
    const activity = await awaitPreviewActivity({
      previewPath: join(this.directory, PREVIEW_FILE),
      waitMs,
      isSettled: settled,
      signal: options.signal,
    });
    return { ...this.readOutput(options), waited_ms: activity.waitedMs };
  }

  private readSlice(
    from: number,
    maxBytes: number,
  ): { text: string; offset: number; nextOffset: number; truncated: boolean; droppedBytes: number } {
    const window = this.previewWindow();
    const buffer = this.previewBuffer() ?? Buffer.alloc(0);
    return slicePreviewWindow(buffer, window, from, maxBytes);
  }

  /**
   * Mark every non-terminal message as interrupted, exactly once.
   *
   * Writes back the per-message result snapshot and the queue/state snapshots so the
   * reconciliation survives for later readers, and so no message can remain non-terminal
   * forever after a restart.
   */
  reconcileOrphans(nowIso: string = new Date().toISOString()): string[] {
    const queue = this.queue();
    const messages = queue.messages;
    if (!isRecord(messages)) return [];
    const reconciled: string[] = [];
    const window = this.previewWindow();
    const updated: Record<string, unknown> = {};

    for (const [messageId, rawEntry] of Object.entries(messages)) {
      if (!isRecord(rawEntry)) continue;
      const state = typeof rawEntry.state === "string" ? rawEntry.state : "failed";
      if (isTerminalPersistedState(state)) continue;
      const entry: Record<string, unknown> = { ...rawEntry };
      entry.state = "failed";
      entry.orphaned = true;
      entry.finished_at = entry.finished_at ?? nowIso;
      entry.error = {
        code: "interrupted",
        message: "the bridge daemon stopped while this message was in flight",
      };
      if (typeof entry.output_start_offset !== "number") {
        entry.output_start_offset = window.start;
      }
      entry.output_end_offset = window.end;
      messages[messageId] = entry;
      updated[messageId] = entry;
      reconciled.push(messageId);
      try {
        writeJsonAtomicSync(join(this.directory, RESULTS_DIR, resultFileName(messageId)), {
          message_id: messageId,
          state: "failed",
          terminal: true,
          mode: entry.mode === "steering" ? "steering" : "queue",
          seq: typeof entry.seq === "number" ? entry.seq : 0,
          created_at: entry.created_at ?? nowIso,
          started_at: entry.started_at ?? null,
          finished_at: entry.finished_at,
          stop_reason: null,
          cancelled_by: null,
          cancel_reason: null,
          error: entry.error,
          text: null,
          tool_calls: [],
          harness_session_id: typeof entry.harness_session_id === "string" ? entry.harness_session_id : null,
          preview_bytes: window.bytes,
          output_start_offset: entry.output_start_offset,
          output_end_offset: entry.output_end_offset,
          orphaned: true,
          interrupted_at: nowIso,
        });
      } catch {
        // A failed write still returns the reconciled view; it will be retried on the next open.
      }
    }

    if (reconciled.length === 0) return [];
    writeJsonAtomicSync(join(this.directory, QUEUE_FILE), {
      ...queue,
      updated_at: nowIso,
      running: null,
      queued: [],
      messages,
    });
    const state = this.state();
    if (state.state !== "interrupted") {
      writeJsonAtomicSync(join(this.directory, STATE_FILE), {
        ...state,
        state: "interrupted",
        orphaned_at: nowIso,
        updated_at: nowIso,
        running_message_id: null,
        queued_message_ids: [],
      });
    }
    return reconciled;
  }
}

/**
 * Reconcile a single non-terminal entry into a terminal result even when the queue snapshot
 * was already rewritten by another reader (best effort, idempotent).
 */
function restoreResultIfMissing(
  directory: string,
  messageId: string,
  entry: Record<string, unknown>,
): void {
  if (!isTerminalPersistedState(String(entry.state ?? ""))) return;
  try {
    const existing = readJsonFileSafe(join(directory, RESULTS_DIR, resultFileName(messageId)));
    if (existing) return;
    writeJsonAtomicSync(join(directory, RESULTS_DIR, resultFileName(messageId)), {
      message_id: messageId,
      state: entry.state,
      terminal: true,
      mode: entry.mode === "steering" ? "steering" : "queue",
      seq: entry.seq ?? 0,
      created_at: entry.created_at ?? null,
      started_at: entry.started_at ?? null,
      finished_at: entry.finished_at ?? null,
      stop_reason: entry.stop_reason ?? null,
      cancelled_by: entry.cancelled_by ?? null,
      cancel_reason: entry.cancel_reason ?? null,
      error: entry.error ?? null,
      text: null,
      tool_calls: [],
      harness_session_id: entry.harness_session_id ?? null,
      preview_bytes: 0,
      output_start_offset: entry.output_start_offset ?? null,
      output_end_offset: entry.output_end_offset ?? null,
      reconstructed: true,
    });
  } catch {
    // Result snapshots are advisory for a terminal entry; ignore write failures.
  }
}
