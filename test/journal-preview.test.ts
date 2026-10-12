import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/io/persistence";
import { StdioTransport } from "../src/transport/stdio";
import { readPreview } from "../src/io/preview";
import { decodeLine } from "../src/acp/protocol";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store() { const root = mkdtempSync(join(tmpdir(), "hab-journal-")); dirs.push(root); return new SessionStore(root, "session-one"); }
function rawEvents(journal: SessionStore): any[] { return readFileSync(journal.rawPath, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
const frame = (text: string): Buffer => Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })}\n`);
describe("lossless journal and stateless previews", () => {
  it("journals a redacted copy with every non-sensitive UTF-8/BOM byte intact, then delivers the original fragmented line", () => {
    const journal = store(); const transport = new StdioTransport(journal, 4096);
    const payload = Buffer.from(' \ufeff{"custom":"字😀","token":"original"}\r\n');
    // Only the sensitive `token` value changes on disk; the BOM, the multibyte text, the ordinary
    // field, and the CRLF must survive byte-for-byte.
    const redacted = Buffer.from(' \ufeff{"custom":"字😀","token":"[REDACTED]"}\r\n');
    let delivered = 0;
    transport.on("line", (line: Buffer) => {
      expect(Buffer.from(rawEvents(journal)[0].raw, "base64")).toEqual(redacted);
      expect(line).toEqual(payload); delivered++;
    });
    for (let index = 0; index < payload.length; index++) transport.receive(payload.subarray(index, index + 1));
    expect(delivered).toBe(1);
  });
  it("preserves every oversized fragment and still delivers the next normal line", () => {
    const journal = store(); const transport = new StdioTransport(journal, 8);
    const faults: any[] = []; const lines: Buffer[] = [];
    transport.on("fault", error => faults.push(error)); transport.on("line", raw => lines.push(raw));
    transport.receive(Buffer.from("overs")); transport.receive(Buffer.from("ized-wire-payload\n{}\n"));
    expect(faults[0].code).toBe("line_too_large"); expect(lines).toEqual([Buffer.from("{}\n")]);
    expect(Buffer.concat(rawEvents(journal).map(event => Buffer.from(event.raw, "base64"))).toString()).toBe("oversized-wire-payload\n{}\n");
  });
  it("prevents both outgoing writes and incoming delivery when journaling fails", async () => {
    const journal = store(); const transport = new StdioTransport(journal, 4096);
    const write = vi.fn((_raw, callback) => callback());
    (transport as any).child = { stdin: { destroyed: false, write } };
    vi.spyOn(journal, "wire").mockImplementation(() => { throw new Error("disk full"); });
    const delivered = vi.fn(); transport.on("line", delivered);
    await expect(transport.write(Buffer.from("{}\n"))).rejects.toThrow("disk full"); expect(write).not.toHaveBeenCalled();
    expect(() => transport.receive(Buffer.from("{}\n"))).toThrow("disk full"); expect(delivered).not.toHaveBeenCalled();
  });
  it("pages inside huge Chinese/emoji events and resumes identically with a fresh reader", () => {
    const journal = store(); journal.messageId = "message-one";
    const text = "汉字😀abc\n".repeat(200);
    journal.wire("stdout", frame(text));
    journal.wire("stdout", Buffer.from(`${JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", rawOutput: { value: "输出😀" } } } })}\n`));
    let cursor: string | undefined; let actual = ""; const types: string[] = [];
    for (let index = 0; index < 2000; index++) {
      const page = readPreview(journal.rawPath, journal.sessionId, { cursor, messageId: "message-one", limit: 1, textBytes: 7 });
      for (const event of page.events) { expect(event.text).not.toContain("�"); types.push(event.type); if (event.type === "answer") actual += event.text; }
      if (index === 2) expect(readPreview(journal.rawPath, journal.sessionId, { cursor, messageId: "message-one", limit: 1, textBytes: 7 })).toEqual(page);
      cursor = page.next_cursor; if (!page.has_more) break;
    }
    expect(actual).toBe(text); expect(types).toContain("tool_call"); expect(types).toContain("tool_output");
    expect(() => readPreview(journal.rawPath, "other-session", { cursor, messageId: "message-one", limit: 1, textBytes: 7 })).toThrow("cursor");
    expect(() => readPreview(journal.rawPath, journal.sessionId, { cursor, messageId: null, limit: 1, textBytes: 7 })).toThrow("cursor");
  });
  it("does not advance over an incomplete journal append or report a phantom next page", () => {
    const journal = store(); journal.wire("stdout", frame("first"));
    const first = readPreview(journal.rawPath, journal.sessionId, { limit: 10, textBytes: 100 });
    const partial = JSON.stringify({ version: 1, seq: 2, timestamp: "now", session_id: journal.sessionId, message_id: null, type: "transport", stream: "stdout", encoding: "base64", raw: frame("second").toString("base64") });
    appendFileSync(journal.rawPath, partial.slice(0, 20));
    const pending = readPreview(journal.rawPath, journal.sessionId, { cursor: first.next_cursor, limit: 10, textBytes: 100 });
    expect(pending.events).toEqual([]); expect(pending.has_more).toBe(false); expect(pending.next_cursor).toBe(first.next_cursor);
    appendFileSync(journal.rawPath, partial.slice(20) + "\n");
    expect(readPreview(journal.rawPath, journal.sessionId, { cursor: pending.next_cursor, limit: 10, textBytes: 100 }).events[0].text).toBe("second");
  });
  it("bounds scans of invisible records while advancing its cursor", () => {
    const journal = store();
    for (let index = 0; index < 2001; index++) journal.wire("stdin", Buffer.from("{}\n"));
    journal.wire("stdout", frame("visible"));
    const page = readPreview(journal.rawPath, journal.sessionId, { limit: 1, textBytes: 100 });
    expect(page.events).toEqual([]); expect(page.has_more).toBe(true);
    expect(readPreview(journal.rawPath, journal.sessionId, { cursor: page.next_cursor, limit: 1, textBytes: 100 }).events[0].text).toBe("visible");
  });
  it("rejects invalid UTF-8 and repairs only an outer ANSI envelope", () => {
    expect(() => decodeLine(Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}\n')]))).toThrow("invalid UTF-8");
    expect(decodeLine(Buffer.from('\ufeff\x1b[32m{"value":"中文😀"}\x1b[0m\r\n'))).toEqual({ value: "中文😀" });
    expect(() => decodeLine(Buffer.from('{"text":"a\x1b[32mb"}\n'))).toThrow("unrepairable");
  });
});
