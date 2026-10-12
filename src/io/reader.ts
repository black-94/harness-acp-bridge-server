#!/usr/bin/env node
/**
 * Stateless paging of the raw journal, plus the self-hosted `hacpr` command that streams it.
 *
 * Cursor includes position within a rendered event.
 */
import { closeSync, lstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { once } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { BridgeError, isRecord } from "../logic/errors.js";
import { decodeLine, describeFrame, type OutputEvent } from "../acp/protocol.js";
import { isEntryPoint } from "./entry.js";
import { isValidSessionId, RAW_FILE, type RawEvent } from "./persistence.js";

interface Cursor { v: 1; session: string; message: string | null; offset: number; item: number; char: number }
export interface PreviewEvent { type: string; text: string; seq: number; timestamp: string; message_id: string | null; complete: boolean; data?: unknown }
export interface PreviewPage { events: PreviewEvent[]; next_cursor: string; has_more: boolean }
const token = (value: Cursor): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function cursorOf(value: unknown, session: string, message: string | null): Cursor {
  if (value === undefined || value === null || value === "") return { v: 1, session, message, offset: 0, item: 0, char: 0 };
  try {
    if (typeof value !== "string" || value.length > 1024) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor.v !== 1 || cursor.session !== session || cursor.message !== message ||
        ![cursor.offset, cursor.item, cursor.char].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error();
    return cursor;
  } catch { throw new BridgeError("invalid_cursor", "cursor does not belong to this session/message or is malformed"); }
}
function render(record: RawEvent): Array<OutputEvent | { type: string; text: string; data?: unknown }> {
  if (record.type === "lifecycle") {
    if (record.event === "unsupported" && isRecord(record.data)) return [{ type: "unsupported", text: String(record.data.raw ?? JSON.stringify(record.data)), data: { code: record.data.code } }];
    return [{ type: "lifecycle", text: `${record.event ?? "event"}${record.data !== undefined ? `\n${JSON.stringify(record.data)}` : ""}`, data: record.data }];
  }
  if (record.stream === "stdin") return [];
  const raw = Buffer.from(record.raw ?? "", "base64");
  if (record.stream === "stderr") return [{ type: "stderr", text: raw.toString("utf8") }];
  if (record.fragment) return []; // Error lifecycle events explain oversized wire fragments.
  try {
    const frame = decodeLine(raw);
    if (frame === null) return [];
    return describeFrame(frame).map(event => event.type === "unsupported" ? { ...event, text: raw.toString("utf8") } : event);
  } catch { return [{ type: "unsupported", text: raw.toString("utf8") }]; }
}
/** Read exactly one complete JSONL record; an incomplete append leaves cursor unchanged. */
function readRecord(fd: number, offset: number, end: number): { record: RawEvent; end: number } | null {
  const parts: Buffer[] = [];
  let position = offset;
  const block = Buffer.allocUnsafe(64 * 1024);
  while (position < end) {
    const count = readSync(fd, block, 0, Math.min(block.length, end - position), position);
    if (!count) break;
    const newline = block.subarray(0, count).indexOf(10);
    if (newline >= 0) {
      parts.push(Buffer.from(block.subarray(0, newline)));
      try { return { record: JSON.parse(Buffer.concat(parts).toString("utf8")), end: position + newline + 1 }; }
      catch { throw new BridgeError("invalid_journal", "invalid raw journal record", { offset }); }
    }
    parts.push(Buffer.from(block.subarray(0, count))); position += count;
  }
  return null;
}
export function readPreview(path: string, session: string, options: { cursor?: unknown; messageId?: string | null; limit: number; textBytes: number }): PreviewPage {
  const cursor = cursorOf(options.cursor, session, options.messageId ?? null);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError("invalid_journal", "journal must be a regular file");
  const end = info.size;
  if (cursor.offset > end) throw new BridgeError("invalid_cursor", "cursor exceeds journal size");
  if (cursor.offset === end && (cursor.item || cursor.char)) throw new BridgeError("invalid_cursor", "cursor has no event at EOF");
  const fd = openSync(path, "r");
  const events: PreviewEvent[] = [];
  try {
    if (cursor.offset) {
      const previous = Buffer.alloc(1); readSync(fd, previous, 0, 1, cursor.offset - 1);
      if (previous[0] !== 10) throw new BridgeError("invalid_cursor", "cursor is not at a journal record boundary");
    }
    let scanned = 0;
    let incomplete = false;
    while (cursor.offset < end && events.length < options.limit && scanned++ < 2000) {
      const line = readRecord(fd, cursor.offset, end);
      if (!line) { incomplete = true; break; }
      const { record } = line;
      const items = cursor.message !== null && cursor.message !== record.message_id ? [] : render(record);
      if (cursor.item > items.length) throw new BridgeError("invalid_cursor", "cursor event index is invalid");
      if (cursor.item === items.length && cursor.char) throw new BridgeError("invalid_cursor", "cursor has no text at this event position");
      while (cursor.item < items.length && events.length < options.limit) {
        const item = items[cursor.item];
        if (cursor.char > item.text.length) throw new BridgeError("invalid_cursor", "cursor text position is invalid");
        if (cursor.char > 0 && /[\uD800-\uDBFF]/.test(item.text[cursor.char - 1] ?? "") && /[\uDC00-\uDFFF]/.test(item.text[cursor.char] ?? "")) throw new BridgeError("invalid_cursor", "cursor splits a Unicode code point");
        const remainder = item.text.slice(cursor.char);
        const bytes = Buffer.from(remainder);
        let length = Math.min(bytes.length, options.textBytes);
        // Never split a UTF-8 code point between pages.
        while (length < bytes.length && length > 0 && (bytes[length] & 0xc0) === 0x80) length--;
        const text = bytes.subarray(0, length).toString("utf8");
        const complete = text.length === remainder.length;
        const data = item.data;
        events.push({ type: item.type, text, seq: record.seq, timestamp: record.timestamp, message_id: record.message_id, complete,
          ...(data !== undefined && JSON.stringify(data).length <= 4096 ? { data } : {}) });
        if (complete) { cursor.item++; cursor.char = 0; }
        else cursor.char += text.length;
      }
      if (cursor.item === items.length) { cursor.offset = line.end; cursor.item = 0; cursor.char = 0; }
    }
    return { events, next_cursor: token(cursor), has_more: !incomplete && cursor.offset < end };
  } finally { closeSync(fd); }
}

// ---------------------------------------------------------------------------
// `hacpr` — the self-hosted command over this module
// ---------------------------------------------------------------------------

const HELP = `Usage: hacpr [session-or-journal] [options]

Stream a session's rendered output from its raw.jsonl journal.

Arguments:
  session-or-journal   A session id under the session directory, or a path to a
                       raw.jsonl file. Defaults to the most recent session.

Options:
  -m, --message <id>   Only emit events belonging to this message_id
  -f, --follow         Keep following the journal as it grows (default)
      --once           Emit what is already on disk, then exit
  -J, --json           Emit one JSON event per line instead of the text view
  -e, --from-end       Skip the existing content and emit only new events
      --dir <path>     Session directory root (default: paths.session_dir)
      --limit <n>      Max events per read (default: buffers.preview_page_events)
      --text-bytes <n> Max text bytes per event (default: buffers.preview_text_bytes)
      --interval <ms>  Follow poll interval (default: 250)
  -h, --help           Show this help
`;

interface HacprOptions {
  target: string | null;
  message: string | null;
  follow: boolean;
  json: boolean;
  fromEnd: boolean;
  dir: string | null;
  limit: number | null;
  textBytes: number | null;
  intervalMs: number;
  help: boolean;
}

const BOOLEAN_FLAGS = new Set(["-f", "--follow", "--once", "-J", "--json", "-e", "--from-end", "-h", "--help"]);
const VALUED_FLAGS = new Set(["-m", "--message", "--dir", "--limit", "--text-bytes", "--interval"]);
/** Preview paging defaults used only when the configuration cannot be read. */
const FALLBACK_LIMIT = 200;
const FALLBACK_TEXT_BYTES = 16 * 1024;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

function parseOptions(argv: readonly string[]): HacprOptions {
  const options: HacprOptions = { target: null, message: null, follow: true, json: false, fromEnd: false,
    dir: null, limit: null, textBytes: null, intervalMs: 250, help: false };
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith("-") || argument === "-") {
      if (options.target !== null) throw new Error(`unexpected extra argument: ${argument}`);
      options.target = argument;
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = separator > 0 ? argument.slice(0, separator) : argument;
    const inline = separator > 0 ? argument.slice(separator + 1) : null;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== null) throw new Error(`${flag} does not take a value`);
      if (flag === "-f" || flag === "--follow") options.follow = true;
      else if (flag === "--once") options.follow = false;
      else if (flag === "-J" || flag === "--json") options.json = true;
      else if (flag === "-e" || flag === "--from-end") options.fromEnd = true;
      else options.help = true;
      continue;
    }
    if (!VALUED_FLAGS.has(flag)) throw new Error(`unknown option: ${flag}`);
    let value = inline;
    if (value === null) {
      const next: string | undefined = argv[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      value = next;
    }
    values.set(flag, value);
  }
  const message = values.get("-m") ?? values.get("--message");
  if (message !== undefined) options.message = message;
  const dir = values.get("--dir");
  if (dir !== undefined) options.dir = dir;
  const limit = values.get("--limit");
  if (limit !== undefined) options.limit = positiveInteger(limit, "--limit");
  const textBytes = values.get("--text-bytes");
  if (textBytes !== undefined) options.textBytes = positiveInteger(textBytes, "--text-bytes");
  const interval = values.get("--interval");
  if (interval !== undefined) options.intervalMs = positiveInteger(interval, "--interval");
  return options;
}

function isRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch { return false; }
}

/** The most recently written session journal under `root`, or null when there is none. */
function latestSession(root: string): string | null {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isValidSessionId(entry.name))
      .map(entry => entry.name);
  } catch { return null; }
  let best: { name: string; mtime: number } | null = null;
  for (const name of names) {
    const journal = join(root, name, RAW_FILE);
    if (!isRegularFile(journal)) continue;
    let mtime: number;
    try { mtime = statSync(journal).mtimeMs; } catch { continue; }
    if (best === null || mtime > best.mtime) best = { name, mtime };
  }
  return best === null ? null : best.name;
}

/** Resolve the argument to a journal path plus the session identity its cursor is bound to. */
function locateJournal(target: string | null, root: string): { path: string; session: string } {
  if (target === null) {
    const session = latestSession(root);
    if (session === null) throw new Error(`no session journals under ${root}`);
    return { path: join(root, session, RAW_FILE), session };
  }
  const direct = resolve(target);
  if (isRegularFile(direct)) return { path: direct, session: basename(dirname(direct)) };
  const journal = join(root, target, RAW_FILE);
  if (isRegularFile(journal)) return { path: journal, session: target };
  throw new Error(`no journal for ${target} (looked for ${journal})`);
}

/** Preview paging defaults. The configuration is imported lazily so loading this module stays cheap. */
async function previewDefaults(): Promise<{ root: string; limit: number; textBytes: number; warning: string | null }> {
  const { loadConfig, defaultStateDirectory } = await import("../logic/config.js");
  try {
    const config = loadConfig();
    return { root: config.paths.sessionDir, limit: config.buffers.previewPageEvents,
      textBytes: config.buffers.previewTextBytes, warning: null };
  } catch (error) {
    return { root: defaultStateDirectory(), limit: FALLBACK_LIMIT, textBytes: FALLBACK_TEXT_BYTES,
      warning: `configuration not loaded (${describeError(error)}); using built-in defaults` };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds); });
}

/**
 * Write one event. Text increments are written verbatim so they can be spliced into a pipeline;
 * structured events carry a `[type]` prefix. Backpressure is honoured so a long journal cannot
 * buffer without bound in the process.
 */
async function emitEvent(event: PreviewEvent, json: boolean): Promise<void> {
  const [stream, text]: [NodeJS.WriteStream, string] = json
    ? [process.stdout, `${JSON.stringify(event)}\n`]
    : event.type === "stderr" ? [process.stderr, event.text]
      : event.type === "answer" || event.type === "reasoning" || event.type === "user" ? [process.stdout, event.text]
        : [process.stdout, `\n[${event.type}] ${event.text}\n`];
  if (!stream.write(text)) await once(stream, "drain");
}

async function runHacpr(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  const defaults = await previewDefaults();
  if (defaults.warning !== null) process.stderr.write(`hacpr: ${defaults.warning}\n`);
  const { path, session } = locateJournal(options.target, options.dir ?? defaults.root);
  if (options.follow) process.stderr.write(`hacpr: following ${path}\n`);
  let cursor: string | undefined;
  // `--from-end`, and a journal that shrank under the cursor, skip to the current end before emitting.
  let live = !options.fromEnd;
  let reported = false;
  for (;;) {
    let page: PreviewPage;
    try {
      page = readPreview(path, session, { cursor, messageId: options.message,
        limit: options.limit ?? defaults.limit, textBytes: options.textBytes ?? defaults.textBytes });
    } catch (error) {
      if (!options.follow) throw error;
      // A restart trims a crash's partial tail, so a live cursor can point past the new EOF.
      if (error instanceof BridgeError && error.code === "invalid_cursor") {
        process.stderr.write(`hacpr: ${path} moved under the cursor; resyncing\n`);
        cursor = undefined; live = false;
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!reported) { process.stderr.write(`hacpr: ${path} is gone; waiting for it to reappear\n`); reported = true; }
        await delay(options.intervalMs);
        continue;
      }
      throw error;
    }
    reported = false;
    if (live) for (const event of page.events) await emitEvent(event, options.json);
    cursor = page.next_cursor;
    if (page.has_more) continue;
    live = true;
    if (!options.follow) break;
    await delay(options.intervalMs);
  }
}

async function main(): Promise<void> {
  try { await runHacpr(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`hacpr: ${describeError(error)}\n`);
    process.exitCode = 1;
  }
}

if (isEntryPoint(import.meta.url)) void main();
