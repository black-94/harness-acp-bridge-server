/** Stateless paging of the raw journal. Cursor includes position within a rendered event. */
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { BridgeError, isRecord } from "../logic/errors.js";
import { decodeLine, describeFrame, type OutputEvent } from "../acp/protocol.js";
import { type RawEvent } from "./persistence.js";

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
