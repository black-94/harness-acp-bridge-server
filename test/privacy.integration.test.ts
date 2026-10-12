import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/logic/config";
import { HarnessHttpServer } from "../dist/http/server.js";
import { SessionStore } from "../src/io/persistence";
import { StdioTransport } from "../src/transport/stdio";
import { Redactor } from "../src/redact/redact";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-harness.mjs", import.meta.url));

// Capture every atomic write payload (the temporary `.tmp` files) so we can prove content is
// sanitized *before* serialization touches disk, not masked on read.
const writes: Array<{ path: string; data: string }> = vi.hoisted(() => []);
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], options?: Parameters<typeof actual.writeFileSync>[2]) => {
      writes.push({ path: String(path), data: Buffer.isBuffer(data) ? data.toString("latin1") : String(data) });
      return actual.writeFileSync(path, data, options);
    },
  };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0)) await operation(); vi.unstubAllEnvs(); });

/** Sentinels that must never reach disk; each shape is covered by a distinct detection path. */
const PROVIDER = `sk-${"Q".repeat(30)}1234`;
const LITERAL = "literal-api-key-0123456789";
const SENTINELS = [PROVIDER, LITERAL, "pw-sentinel-aaa", "api-sentinel-ddd", "rt-sentinel-bbb", "at-sentinel-ccc", "escaped-body-token-987654", "pem-body-SENTINEL-eee", "err-sentinel-fff"];

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path); else found.push(path);
    }
  };
  walk(root);
  return found;
}

/**
 * Every byte that could ever be persisted. Raw files are appended verbatim; for the raw journal
 * the base64 payloads are concatenated **per (stream, session, message) with no separator**, so a
 * sentinel split across two adjacent records is still observed instead of being hidden by a
 * marker between the decoded segments.
 */
function persistedText(root: string): string {
  const parts: Buffer[] = [];
  for (const path of filesUnder(root)) {
    const raw = readFileSync(path);
    parts.push(raw);
    if (!path.endsWith(".jsonl")) continue;
    const streams = new Map<string, Buffer[]>();
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.raw !== "string") continue;
        const key = `${event.stream ?? ""}\u0000${event.session_id ?? ""}\u0000${event.message_id ?? ""}`;
        const bucket = streams.get(key) ?? [];
        streams.set(key, bucket);
        bucket.push(Buffer.from(event.raw, "base64"));
      } catch { /* partial append */ }
    }
    for (const bucket of streams.values()) parts.push(Buffer.concat(bucket));
  }
  return Buffer.concat(parts).toString("utf8");
}

async function setup(harnessEnv: Record<string, string>, extra: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hab-privacy-"));
  const path = join(directory, "config.yaml");
  writeFileSync(path, stringify({ schema_version: 2, paths: { state_dir: join(directory, "sessions") },
    server: { host: "127.0.0.1", port: 0 }, sessions: { max_concurrency: 4, reap_interval_seconds: 0.05 },
    timeouts: { startup_timeout_seconds: 3, request_timeout_seconds: 1, turn_timeout_seconds: 5, turn_cancel_timeout_seconds: 0.3, terminate_grace_seconds: 0.05, remote_cleanup_timeout_seconds: 0.05, authentication_timeout_seconds: 0.5 },
    authentication: { rate_limit: { enabled: false } }, default_harness: "codebuddy",
    harnesses: { codebuddy: { models: [{ id: "fake-model", thinking_levels: ["low", "high"] }] } }, ...extra }));
  const config = loadConfig(path);
  const server = new HarnessHttpServer(config);
  const address = await server.start();
  cleanup.push(async () => { await server.stop(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(method === "create_session" ? { template: "fixture", ...params } : params) });
    return { status: response.status, ...(await response.json() as any) };
  };
  expect((await request("register_template", { template: { name: "fixture", harness: "codebuddy", command: process.execPath, args: [fixture], env: harnessEnv } })).ok).toBe(true);
  const create = async () => {
    const response = await request("create_session", { cwd: directory, model_id: "fake-model" });
    expect(response.ok, JSON.stringify(response)).toBe(true); return response.data.session_id as string;
  };
  const complete = async (session: string, message: string) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const response = await request("message_status", { session_id: session, message_id: message });
      if (response.data?.terminal) return response.data;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("message did not become terminal");
  };
  return { server, config, directory, base, request, create, complete };
}

describe("privacy: end-to-end redaction with a real server and fake harness", () => {
  it("never writes a credential to disk, keeps ordinary content, redacts before the atomic write, and leaves history untouched", async () => {
    writes.length = 0;
    const promptFile = join(mkdtempSync(join(tmpdir(), "hab-prompt-")), "prompts.txt");
    const app = await setup({ API_KEY: LITERAL, FAKE_HARNESS_PROMPT_FILE: promptFile });
    // A pre-existing historical session log must never be rewritten by the new redaction path.
    const history = join(app.config.paths.sessionDir, "2020-01-01-historical");
    mkdirSync(history, { recursive: true });
    const historicalRaw = join(history, "raw.jsonl");
    writeFileSync(historicalRaw, `{"legacy":"${PROVIDER}"}\n`);
    const historicalBefore = readFileSync(historicalRaw);

    const session = await app.create();
    const prompt = `privacy-fields ${PROVIDER} ${LITERAL} 普通正文😀`;
    const message = (await app.request("send_message", { session_id: session, text: prompt })).data.message_id;
    expect((await app.complete(session, message)).state).toBe("completed");

    // (1) The harness received the ORIGINAL prompt bytes on the wire.
    const received = readFileSync(promptFile, "utf8");
    expect(received).toContain(PROVIDER);
    expect(received).toContain(LITERAL);

    // (2) No sentinel survives anywhere in the NEW session's disk state (raw, queue, session,
    // results, decoded base64, merged). The historical directory is scanned separately below.
    const disk = persistedText(join(app.config.paths.sessionDir, session));
    for (const sentinel of SENTINELS) expect(disk, `leaked ${sentinel}`).not.toContain(sentinel);

    // (3) Sensitive fields are masked; ordinary neighbours and body text remain.
    expect(disk).toContain("[REDACTED]");
    expect(disk).toContain("public-key-value-kept");
    expect(disk).toContain("max_tokens");
    expect(disk).toContain("token_count");
    expect(disk).toContain("sess-keep-1");
    expect(disk).toContain("普通正文😀");
    expect(disk).toContain("ordinary text");
    // The escaped-JSON body's credential is gone, but its ordinary prefix/suffix survive.
    expect(disk).toContain("prefix ");
    expect(disk).toContain("suffix 😀");

    // (4) Sanitize-before-write: every atomic `.tmp` payload (serialized, pre-rename) was already clean.
    const temporaryWrites = writes.filter(entry => entry.path.endsWith(".tmp") && !entry.path.includes("templates.json."));
    expect(temporaryWrites.length).toBeGreaterThan(0);
    for (const entry of temporaryWrites) for (const sentinel of SENTINELS) expect(entry.data, `temp write leaked ${sentinel}`).not.toContain(sentinel);

    // (5) Historical files are byte-for-byte untouched.
    expect(readFileSync(historicalRaw)).toEqual(historicalBefore);
  });

  it("redacts credentials in persisted error details while keeping non-sensitive markers", async () => {
    const app = await setup({});
    const session = await app.create();
    const message = (await app.request("send_message", { session_id: session, text: "privacy-error" })).data.message_id;
    const result = await app.complete(session, message);
    expect(result.error.code).toBe("unsupported_response");
    const disk = persistedText(app.config.paths.sessionDir);
    expect(disk).not.toContain("err-sentinel-fff");
    expect(disk).toContain("vendorFinal");
  });
});

describe("privacy: lossless delivery with a redacted on-disk copy", () => {
  function store(redactor?: Redactor): SessionStore { const root = mkdtempSync(join(tmpdir(), "hab-priv-stream-")); cleanup.push(async () => rmSync(root, { recursive: true, force: true })); return new SessionStore(root, "session-one", redactor); }
  function rawEvents(journal: SessionStore): any[] { return readFileSync(journal.rawPath, "utf8").trim().split("\n").map(line => JSON.parse(line)); }

  it("delivers the original line at every split point while the journal copy stays redacted", () => {
    const journal = store(new Redactor([LITERAL]));
    const payload = Buffer.from(` \ufeff\x1b[32m{"token":"abc123","text":"汉字😀 ${LITERAL}","n":7}\x1b[0m\r\n`);
    for (const cut of [0, 1, 2, 5, 12, Math.floor(payload.length / 2), payload.length - 3, payload.length - 1, payload.length]) {
      const transport = new StdioTransport(journal, 4096);
      const lines: Buffer[] = [];
      transport.on("line", (line: Buffer) => lines.push(line));
      transport.receive(payload.subarray(0, cut));
      transport.receive(payload.subarray(cut));
      expect(lines.length, `cut=${cut}`).toBe(1);
      expect(lines[0], `cut=${cut}`).toEqual(payload); // real wire, unchanged
    }
    const journaled = rawEvents(journal).map(event => Buffer.from(event.raw, "base64").toString("utf8")).join("");
    expect(journaled).not.toContain(LITERAL);
    expect(journaled).toContain("[REDACTED]");
    expect(journaled).toContain("汉字😀"); // non-sensitive multibyte bytes intact
  });

  it("keeps a redactor-bound literal out of a long fragmented stream and bounds its buffer", () => {
    const journal = store(new Redactor([LITERAL]));
    const transport = new StdioTransport(journal, 8 * 1024);
    // Feed a name/value pair whose value is a huge single token: it must be redacted, and the
    // internal hold must stay bounded (< 64KiB) rather than buffering the whole stream.
    const parts = [Buffer.from(`token="${LITERAL}`), Buffer.from("A".repeat(300 * 1024))];
    for (const part of parts) transport.receive(part);
    transport.receive(Buffer.from("\"\n{}\n"));
    const journaled = rawEvents(journal).map(event => Buffer.from(event.raw, "base64").toString("latin1")).join("");
    expect(journaled).not.toContain(LITERAL);
    expect(journaled).not.toContain("A".repeat(1000));
    const hold = (transport as any).fragmentRedactor?.carry?.length ?? 0;
    expect(hold).toBeLessThanOrEqual(64 * 1024);
  });

  it("delivers a frame with a sensitive container unchanged while the journal masks the value", () => {
    const journal = store();
    const payload = Buffer.from('{"credentials":{"label":"OPAQUE_KEEP_ON_WIRE","other":"x"},"public_key":"KEEP"}\n');
    const transport = new StdioTransport(journal, 4096);
    const lines: Buffer[] = [];
    transport.on("line", (line: Buffer) => lines.push(line));
    transport.receive(payload);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(payload); // the real wire bytes are never rewritten
    const journaled = rawEvents(journal).map(event => Buffer.from(event.raw, "base64").toString("utf8")).join("");
    expect(journaled).not.toContain("OPAQUE_KEEP_ON_WIRE");
    expect(journaled).toContain('"public_key":"KEEP"');
  });

  it("an oversized fragmented frame with an unterminated sensitive container leaks no opaque child", () => {
    const journal = store();
    const transport = new StdioTransport(journal, 8 * 1024);
    const payload = `prefix {"credentials":{"label":"OPAQUE_LEAK_SENTINEL${"A".repeat(100000)}"},"public_key":"KEEP"}\n`;
    for (let i = 0; i < payload.length; i += 4096) transport.receive(Buffer.from(payload.slice(i, i + 4096), "utf8"));
    const journaled = rawEvents(journal).map(event => Buffer.from(event.raw, "base64").toString("latin1")).join("");
    expect(journaled).not.toContain("OPAQUE_LEAK_SENTINEL");
    expect(journaled).not.toContain("A".repeat(1000));
    expect(journaled).toContain('"public_key":"KEEP"');
  });

  it("masks a confirmed field under 12 ordinary wrapper levels in the journal, wire unchanged", () => {
    const journal = store();
    let frame = '{"credentials":{"label":"DEEP_OPAQUE_SECRET"},"cookie":["DEEP_COOKIE_SECRET"],"token":424242,"public_key":"KEEP"}';
    for (let i = 0; i < 12; i++) frame = `{"wrap${i}":${frame}}`;
    const payload = Buffer.from(`${frame}\n`);
    const transport = new StdioTransport(journal, 64 * 1024);
    const lines: Buffer[] = [];
    transport.on("line", (line: Buffer) => lines.push(line));
    transport.receive(payload);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(payload); // the real wire bytes are never rewritten
    const journaled = rawEvents(journal).map(event => Buffer.from(event.raw, "base64").toString("utf8")).join("");
    expect(journaled).not.toContain("DEEP_OPAQUE_SECRET");
    expect(journaled).not.toContain("DEEP_COOKIE_SECRET");
    expect(journaled).not.toContain("424242");
    expect(journaled).toContain('"public_key":"KEEP"');
  });
});

describe("privacy: the persisted scan sees across adjacent records", () => {
  it("detects a sentinel split across two raw records that share a stream", () => {
    const root = mkdtempSync(join(tmpdir(), "hab-priv-scan-"));
    cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
    const records = [PROVIDER.slice(0, 10), PROVIDER.slice(10)].map(raw =>
      JSON.stringify({ version: 1, seq: 1, timestamp: "t", session_id: "s", message_id: "m", type: "transport", stream: "stdout", encoding: "base64", raw: Buffer.from(raw, "utf8").toString("base64") }));
    writeFileSync(join(root, "raw.jsonl"), `${records.join("\n")}\n`);
    expect(persistedText(root)).toContain(PROVIDER);
  });
});
