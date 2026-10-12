import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Redaction must stay near-linear and memory-bounded on pathological input. The work runs in a
 * child process with an OS-enforced wall-clock deadline: a quadratic regression is killed by the
 * parent instead of hanging the suite, and the test fails with the timing report.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const core = pathToFileURL(join(root, "dist/redact/redact-core.js")).href;
const redact = pathToFileURL(join(root, "dist/redact/redact.js")).href;

const PROBE = `
import { redactText } from ${JSON.stringify(core)};
import { StreamRedactor } from ${JSON.stringify(redact)};
const t = () => Number(process.hrtime.bigint() / 1000000n);
const out = {};
let start = t();
const plain = "a".repeat(8 * 1024 * 1024);
out.plainSame = redactText(plain, []) === plain;
out.plainMs = t() - start;
start = t();
const url = "https://" + "a".repeat(8 * 1024 * 1024);
out.urlSame = redactText(url, []) === url;
out.urlMs = t() - start;
start = t();
const stream = new StreamRedactor([], "latin1");
let emitted = 0;
const chunk = Buffer.from("a".repeat(65536));
for (let i = 0; i < 128; i++) emitted += stream.push(chunk).length;
emitted += stream.flush().length;
out.streamMs = t() - start; out.streamBytes = emitted;
start = t();
const unclosed = new StreamRedactor([], "latin1");
let body = unclosed.push(Buffer.from('token="' + "A".repeat(65536)));
for (let i = 0; i < 63; i++) body = Buffer.concat([body, unclosed.push(Buffer.from("A".repeat(65536)))]);
body = Buffer.concat([body, unclosed.flush()]);
const unclosedText = body.toString("latin1");
out.unclosedLeak = unclosedText.includes("AAAA");
out.unclosedBytes = body.length; out.unclosedMs = t() - start;
process.stdout.write(JSON.stringify(out));
`;

describe("redaction performance and bounding", () => {
  it("stays near-linear on 8MiB inputs and bounds an unclosed value", () => {
    let report: any;
    try {
      const raw = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], { cwd: root, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
      report = JSON.parse(raw);
    } catch (error: any) {
      throw new Error(`redaction probe failed or exceeded its 20s wall-clock deadline: ${error?.message ?? error}`);
    }
    expect(report.plainSame).toBe(true);
    expect(report.urlSame).toBe(true);
    expect(report.plainMs).toBeLessThan(8000);
    expect(report.urlMs).toBeLessThan(8000);
    expect(report.streamMs).toBeLessThan(8000);
    expect(report.streamBytes).toBe(8 * 1024 * 1024);
    expect(report.unclosedLeak).toBe(false);
    // Masked to a single placeholder, not buffered: a bounded buffer cannot hold the 4MiB body.
    expect(report.unclosedBytes).toBeLessThan(4096);
  });
});
