import { describe, expect, it } from "vitest";
import { Redactor, StreamRedactor, collectSecrets, redactBytes, redactValue } from "../src/redact/redact";
import { isSensitiveKeyName, redactText } from "../src/redact/redact-core";

const SENTINEL = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

describe("sensitive key classification", () => {
  it.each([
    "token", "access_token", "accessToken", "refresh_token", "refreshToken", "id_token",
    "password", "passphrase", "passwd", "secret", "client_secret", "api_key", "apiKey",
    "private_key", "privateKey", "authorization", "Authorization", "cookie", "set-cookie",
    "session_key", "credentials",
  ])("treats %s as sensitive", name => { expect(isSensitiveKeyName(name)).toBe(true); });

  it.each([
    "max_tokens", "token_count", "input_tokens", "output_tokens", "totalTokens", "tokens",
    "monkey", "public_key", "registry_key", "key", "id", "model_id", "text", "raw", "email",
    "session_id", "message_id", "harness_session_id",
  ])("does not treat %s as sensitive", name => { expect(isSensitiveKeyName(name)).toBe(false); });
});

describe("textual redaction", () => {
  it("masks sensitive JSON string values and keeps the JSON valid", () => {
    expect(JSON.parse(redactText('{"token":"abc123","ok":1}'))).toEqual({ token: "[REDACTED]", ok: 1 });
    expect(redactText('{"accessToken":"v"}')).toBe('{"accessToken":"[REDACTED]"}');
  });
  it("preserves counters, ids, and ordinary body text byte-for-byte", () => {
    const text = '{"max_tokens":100,"token_count":5,"id":"tok_1","text":"hello 世界 😀"}';
    expect(redactText(text)).toBe(text);
  });
  it("masks escaped JSON secret values", () => {
    expect(redactText('{"token":"a\\"b"}')).toBe('{"token":"[REDACTED]"}');
  });
  it("masks Authorization headers and bare bearer tokens", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnopqrstuv")).toBe("Authorization: [REDACTED]");
    expect(redactText("x=Bearer abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
    expect(redactText("a basic understanding of parsing")).toBe("a basic understanding of parsing");
  });
  it("masks key=value and colon forms for sensitive keys only", () => {
    expect(redactText("token=SECRETVALUE ok=1")).toBe("token=[REDACTED] ok=1");
    expect(redactText("password: hunter2 ; token_count=3")).toBe("password: [REDACTED] ; token_count=3");
  });
  it("masks URL userinfo and query credentials", () => {
    expect(redactText("https://user:s3cr3t@example.com/x?access_token=abc&x=1")).toBe("https://user:[REDACTED]@example.com/x?access_token=[REDACTED]&x=1");
  });
  it("masks PEM private keys", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nDEFghi\n-----END RSA PRIVATE KEY-----";
    expect(redactText(`before\n${pem}\nafter`)).toBe("before\n[REDACTED]\nafter");
  });
  it("masks well-known provider token shapes", () => {
    expect(redactText(`key is ${SENTINEL} end`)).toBe("key is [REDACTED] end");
    expect(redactText("ghp_abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]");
  });
  it("masks literal secrets from the environment anywhere they appear", () => {
    const redactor = new Redactor(["abcdef123456"]);
    expect(redactor.text("echoed abcdef123456 here")).toBe("echoed [REDACTED] here");
    expect(redactor.text("echoed abcdef1 here")).toBe("echoed abcdef1 here");
  });
});

describe("recursive value redaction", () => {
  it("replaces credential-named keys and textual secrets recursively", () => {
    const input = { session_id: "s-1", auth: { token: "x", user: { email: "a@b.c" } }, list: [{ apiKey: "y" }, "text ok"], note: "call with abcdef123456" };
    const output = redactValue(input, ["abcdef123456"]) as typeof input;
    expect(output).toEqual({ session_id: "s-1", auth: { token: "[REDACTED]", user: { email: "a@b.c" } }, list: [{ apiKey: "[REDACTED]" }, "text ok"], note: "call with [REDACTED]" });
    expect(input.auth.token).toBe("x"); // never mutated
  });
});

describe("byte redaction", () => {
  it("round-trips untouched valid UTF-8 exactly", () => {
    const buffer = Buffer.from('{"text":"汉字😀 plain"}\n');
    expect(redactBytes(buffer, [])).toEqual(buffer);
  });
  it("redacts base64-decoded content", () => {
    const buffer = Buffer.from('{"token":"secret-value"}\n');
    const decoded = redactBytes(buffer, []).toString("utf8");
    expect(decoded).not.toContain("secret-value");
    expect(JSON.parse(decoded.trim())).toEqual({ token: "[REDACTED]" });
  });
  it("preserves bytes for invalid UTF-8 while still masking ASCII secrets", () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("token=SECRETVALUE")]);
    const out = redactBytes(buffer, []);
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(out.toString("latin1")).toContain("[REDACTED]");
  });
});

describe("bounded streaming redactor", () => {
  it("does not leak a secret split across chunk boundaries", () => {
    const redactor = new StreamRedactor(["abcdef123456"], "utf8");
    const out = Buffer.concat([redactor.push(Buffer.from("prefix abc")), redactor.push(Buffer.from("def123456 suffix")), redactor.flush()]).toString();
    expect(out).toBe("prefix [REDACTED] suffix");
  });
  it("never emits an unterminated PEM body", () => {
    const redactor = new StreamRedactor([], "utf8");
    const parts = [redactor.push(Buffer.from("start\n-----BEGIN RSA PRIVATE KEY-----\nMIIE")), redactor.push(Buffer.from("SECRETKEYBODY\n")), redactor.flush()];
    const out = Buffer.concat(parts).toString();
    expect(out).toContain("start");
    expect(out).not.toContain("SECRETKEYBODY");
    expect(out).toContain("[REDACTED]");
  });
  it("redacts a PEM delivered in one chunk", () => {
    const redactor = new StreamRedactor([], "utf8");
    const out = Buffer.concat([redactor.push(Buffer.from("x\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\ny")), redactor.flush()]).toString();
    expect(out).toBe("x\n[REDACTED]\ny");
  });
  it("redacts latin1 oversized fragments across byte splits", () => {
    const redactor = new StreamRedactor(["abcdef123456"], "latin1");
    const out = Buffer.concat([redactor.push(Buffer.from("s".repeat(9000))), redactor.push(Buffer.from("abcdef123456")), redactor.flush()]).toString();
    expect(out).not.toContain("abcdef123456");
  });
  it("bounds memory for a pathological unterminated sensitive value", () => {
    const redactor = new StreamRedactor([], "latin1");
    const out = redactor.push(Buffer.from("-----BEGIN PRIVATE KEY-----" + "A".repeat(200000))).toString();
    expect(out).toBe("[REDACTED]");
  });
});

describe("collectSecrets", () => {
  it("collects sensitive-named environment and harness env values only", () => {
    const secrets = collectSecrets({ API_KEY: "abcdef123456", PATH: "/usr/bin", SHORT: "x" }, { codebuddy: { env: { AUTH_TOKEN: "harness-secret-value", MODEL: "m" } } });
    expect(secrets).toContain("abcdef123456");
    expect(secrets).toContain("harness-secret-value");
    expect(secrets).not.toContain("/usr/bin");
    expect(secrets).not.toContain("m");
  });
});

describe("UTF-8 BOM round-trip", () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  it("preserves a leading BOM byte-for-byte when nothing is sensitive", () => {
    const buffer = Buffer.concat([BOM, Buffer.from('{"text":"汉字😀"}\n')]);
    expect(redactBytes(buffer, [])).toEqual(buffer);
  });
  it("keeps the BOM while still redacting a sensitive field", () => {
    const buffer = Buffer.concat([BOM, Buffer.from('{"token":"secret-value"}\n')]);
    const out = redactBytes(buffer, []);
    expect(out.subarray(0, 3)).toEqual(BOM);
    expect(out.toString("utf8")).toBe('\ufeff{"token":"[REDACTED]"}\n');
  });
});

describe("overlap coverage and unterminated values", () => {
  it("merges overlapping matches so a shorter match cannot leave a secret suffix", () => {
    // The URL userinfo pass (`abcTAIL`) ends before `@`; the literal secret (`TAIL@host`) starts
    // inside it and extends past the `@`. Keeping only the longer-at-first-start match would leave
    // the secret suffix `@host` exposed.
    const secret = "TAIL@host";
    const out = redactText("https://u:abcTAIL@host", [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("@host");
  });
  it("masks an unterminated sensitive JSON value at end of input", () => {
    expect(redactText('{"token":"secret-without-close')).not.toContain("secret-without-close");
    expect(redactText("token=\"secret-without-close")).not.toContain("secret-without-close");
  });
  it("bounds an unclosed quoted value in the streaming redactor without leaking it", () => {
    const redactor = new StreamRedactor([], "latin1");
    let out = redactor.push(Buffer.from('token="' + "A".repeat(200000)));
    expect(out.toString("latin1")).not.toContain("AAAA");
    out = Buffer.concat([out, redactor.flush()]);
    expect(out.toString("latin1")).not.toContain("AAAA");
  });
});

/** Feed a stream of parts and return everything emitted (push + flush), decoded. */
function streamAll(parts: readonly string[], charset: "utf8" | "latin1" = "latin1"): string {
  const redactor = new StreamRedactor([], charset);
  const out = parts.map(part => redactor.push(Buffer.from(part, charset)));
  return Buffer.concat([...out, redactor.flush()]).toString(charset);
}

describe("structured sensitive values of every JSON shape", () => {
  const raw = '{"token":424242,"secret":null,"credentials":{"label":"opaqueSECRET1","other":"opaqueSECRET2"},"cookie":["opaqueCOOKIE1","opaqueCOOKIE2"],"public_key":"keep"}';
  it("masks short/number/null/object/array values under a sensitive key as a whole", () => {
    const out = redactText(raw);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.secret).toBe("[REDACTED]");
    expect(parsed.credentials).toBe("[REDACTED]");
    expect(parsed.cookie).toBe("[REDACTED]");
    expect(parsed.public_key).toBe("keep");
    expect(out).not.toContain("opaqueSECRET1");
    expect(out).not.toContain("opaqueCOOKIE1");
  });
  it("round-trips a base64-decoded copy per field while the wire bytes are untouched", () => {
    const wire = Buffer.from(`${raw}\n`);
    const stored = redactBytes(wire, []);
    const parsed = JSON.parse(stored.toString("utf8").trim()) as Record<string, unknown>;
    expect(parsed.credentials).toBe("[REDACTED]");
    expect(parsed.public_key).toBe("keep");
    expect(wire.toString("utf8")).toBe(`${raw}\n`); // the original buffer is never mutated
  });
});

describe("escaped JSON inside ordinary body text", () => {
  it("masks a sensitive pair escaped inside a string value", () => {
    const out = redactText('{"text":"{\\"token\\":\\"escaped-secret-123456\\"}","note":"keep me"}');
    const parsed = JSON.parse(out) as { text: string; note: string };
    expect(parsed.note).toBe("keep me");
    expect(parsed.text).toBe('{"token":"[REDACTED]"}');
  });
  it("keeps newlines and emoji exact when it redacts an ordinary body string", () => {
    const out = redactText('{"text":"line1\\nsecret=SECRETVALUE123\\nemoji:\\ud83d\\ude00 end"}');
    const parsed = JSON.parse(out) as { text: string };
    expect(parsed.text).toBe("line1\nsecret=[REDACTED]\nemoji:😀 end");
  });
});

describe("bounded streaming keeps the field key and suffix", () => {
  const long = "S".repeat(70000);
  it("over-long quoted KV value in one chunk keeps the prefix and the line suffix", () => {
    expect(streamAll([`token="${long}" suffix KEEP\n`])).toBe(`token="[REDACTED]" suffix KEEP\n`);
  });
  it("over-long quoted KV value across chunks keeps the prefix and suffix", () => {
    expect(streamAll([`token="${long}`, `" suffix KEEP\nafter\n`])).toBe(`token="[REDACTED]" suffix KEEP\nafter\n`);
  });
  it("over-long quoted JSON value keeps the object suffix", () => {
    expect(streamAll([`{"token":"${long}"} suffix KEEP\n`])).toBe(`{"token":"[REDACTED]"} suffix KEEP\n`);
  });
  it("resumes at the real closing quote after an escaped quote inside the value", () => {
    const out = streamAll([`token="${long}\\"inner" suffix KEEP\n`]);
    expect(out).toBe(`token="[REDACTED]" suffix KEEP\n`);
  });
  it("masks an over-long bare provider token and URL query value, keeping the suffix", () => {
    const provider = streamAll([`k sk-${"Q".repeat(70000)} tail\n`]);
    expect(provider).not.toContain("Q".repeat(100));
    expect(provider).toContain("tail");
    const query = streamAll([`https://h/x?access_token=${"T".repeat(70000)}&next=1`]);
    expect(query).toContain("access_token=[REDACTED]&next=1");
    const bearer = streamAll([`Authorization: Bearer ${"b".repeat(70000)}\nX=1`]);
    expect(bearer).toContain("Authorization: [REDACTED]\nX=1");
  });
  it("handles a 1MiB value split across chunks without leaking or dropping the marker", () => {
    const redactor = new StreamRedactor([], "latin1");
    const out = Buffer.concat([
      redactor.push(Buffer.from('token="' + "A".repeat(1024 * 1024))),
      redactor.push(Buffer.from('" KEEPMARKER\n')),
      redactor.flush(),
    ]).toString("latin1");
    expect(out.startsWith('token="[REDACTED]"')).toBe(true);
    expect(out).toContain("KEEPMARKER");
    expect(out).not.toContain("A".repeat(1000));
  });
});

describe("PEM private-key handling", () => {
  it("does not mask a complete PUBLIC KEY block", () => {
    const text = "x -----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\ny";
    expect(redactText(text)).toBe(text);
  });
  it("leaves an ordinary non-terminated BEGIN as unknown text", () => {
    const text = "-----BEGIN CERTIFICATE AAAA ordinary text";
    expect(redactText(text)).toContain("ordinary text");
  });
  it("streaming: a foreign END marker inside a private body does not end the block early", () => {
    const redactor = new StreamRedactor([], "latin1");
    const out = Buffer.concat([
      redactor.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n" + "A".repeat(10000))),
      redactor.push(Buffer.from("-----END EC PARAMETERS-----\nSECRETLEAKBODY\n-----END PRIVATE KEY-----\nZ")),
      redactor.flush(),
    ]).toString("latin1");
    expect(out).not.toContain("SECRETLEAKBODY");
    expect(out).toContain("Z");
  });
  it("streaming: a confirmed private key or an unconfirmed partial BEGIN stays bounded", () => {
    const partial = new StreamRedactor([], "latin1");
    for (let i = 0; i < 20; i++) partial.push(Buffer.from("-----BEGIN " + "A".repeat(50000)));
    expect((partial as unknown as { carry: Buffer }).carry.length).toBeLessThanOrEqual(64 * 1024);
    const confirmed = new StreamRedactor([], "latin1");
    confirmed.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n" + "B".repeat(200000)));
    expect((confirmed as unknown as { carry: Buffer }).carry.length).toBeLessThanOrEqual(64 * 1024);
  });
  it("streaming: an unterminated confirmed private key masks the whole body at EOF", () => {
    const out = streamAll(["before\n-----BEGIN PRIVATE KEY-----\nSECRETBODY\nmore"]);
    expect(out).toContain("before");
    expect(out).not.toContain("SECRETBODY");
    expect(out).toContain("[REDACTED]");
  });
});

describe("streaming UTF-8 boundary safety", () => {
  it("splits a multibyte stream at every byte offset without corruption", () => {
    const buffer = Buffer.from("prefix 中文😀 end".repeat(2000));
    const redactor = new StreamRedactor([], "utf8");
    let accumulated = Buffer.alloc(0);
    for (let i = 0; i < buffer.length; i += 7) accumulated = Buffer.concat([accumulated, redactor.push(buffer.subarray(i, i + 7))]);
    accumulated = Buffer.concat([accumulated, redactor.flush()]);
    expect(accumulated.equals(buffer)).toBe(true);
  });
  it("catches a known multibyte literal split at every byte offset", () => {
    const secret = "秘密令牌value1";
    const buffer = Buffer.from(`xx${secret}yy`);
    const redactor = new StreamRedactor([secret], "utf8");
    let accumulated = Buffer.alloc(0);
    for (let i = 0; i < buffer.length; i++) accumulated = Buffer.concat([accumulated, redactor.push(buffer.subarray(i, i + 1))]);
    accumulated = Buffer.concat([accumulated, redactor.flush()]);
    expect(accumulated.toString("utf8")).not.toContain(secret);
    expect(accumulated.toString("utf8")).toContain("[REDACTED]");
  });
  it("preserves invalid UTF-8 bytes while redacting an ASCII secret", () => {
    const buffer = Buffer.concat([Buffer.from([0xc3, 0x28, 0xff]), Buffer.from(" token=SECRETVALUE123")]);
    const redactor = new StreamRedactor([], "utf8");
    const out = Buffer.concat([redactor.push(buffer), redactor.flush()]);
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xc3, 0x28, 0xff]));
    expect(out.toString("latin1")).toContain("[REDACTED]");
  });
  it("matches a UTF-8 known literal in latin1 mode", () => {
    const secret = "秘密令牌value1";
    const mojibake = Buffer.from(secret, "utf8").toString("latin1");
    const redactor = new StreamRedactor([secret], "latin1");
    const out = Buffer.concat([redactor.push(Buffer.from(`a${mojibake}b`, "latin1")), redactor.flush()]).toString("latin1");
    expect(out).not.toContain(mojibake);
  });
  it("redacts a known literal in an invalid UTF-8 blob by mapping it to latin1 bytes", () => {
    const secret = "秘密值SECRET123";
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token=${secret}`, "utf8")]);
    const out = redactBytes(buffer, [secret]);
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(out.toString("latin1")).not.toContain(Buffer.from(secret, "utf8").toString("latin1"));
  });
});

describe("provider tokens keep their real character set when masked as a stream", () => {
  // The bounded mask must consume the WHOLE token (including `-`, `_`, `.`) once it has confirmed a
  // provider shape, or the remainder — which no longer carries the recognizable prefix — is written.
  it.each([
    ["sk-ant", `sk-ant-${"A".repeat(70000)}`, "-SENTINEL_PROVIDER_SUFFIX"],
    ["pypi", `pypi-${"B".repeat(70000)}`, "-pypi_SUFFIX"],
    ["xox", `xoxb-${"D".repeat(70000)}`, "-extra-tail"],
    ["github_pat", `github_pat_${"E".repeat(70000)}`, "_gh_suffix"],
  ])("masks an over-long %s token including its -/_ continuation and keeps the suffix", (_name, first, continuation) => {
    const out = streamAll([first, `${continuation} KEEPMARK\n`]);
    expect(out).not.toContain(continuation);
    expect(out).toContain("KEEPMARK");
  });
  it("consumes dots through an over-long JWT across chunks", () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"S".repeat(70000)}`;
    const out = streamAll([jwt, " tail KEEP\n"]);
    expect(out).not.toContain("S".repeat(100));
    expect(out).toContain("tail KEEP");
  });
  it("keeps Basic base64 `=` padding inside the mask", () => {
    const out = streamAll([`x Basic ${"d".repeat(70000)}==`, " tail KEEP\n"]);
    expect(out).not.toContain("==");
    expect(out).toContain("tail KEEP");
  });
  it("still masks a short provider token in a single chunk", () => {
    expect(redactText(`x sk-ant-${"A".repeat(30)} y`)).toBe("x [REDACTED] y");
    expect(redactText(`x pypi-${"B".repeat(20)} y`)).toBe("x [REDACTED] y");
  });
});

describe("unterminated sensitive containers must not leak opaque children", () => {
  const chunk = (text: string, size = 65536): string[] => {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
    return parts;
  };
  it("object value: masks the whole subtree across chunks and keeps the sibling", () => {
    const payload = `prefix {"credentials":{"label":"OPAQUE_LEAK_SENTINEL${"A".repeat(100000)}"},"public_key":"KEEP"}\n`;
    const out = streamAll(chunk(payload));
    expect(out).not.toContain("OPAQUE_LEAK_SENTINEL");
    expect(out).not.toContain("A".repeat(1000));
    expect(out).toBe(`prefix {"credentials":"[REDACTED]","public_key":"KEEP"}\n`);
  });
  it("array value: masks the whole subtree and keeps the sibling", () => {
    const payload = `{"cookie":["OPAQUE_COOKIE_SENTINEL${"B".repeat(100000)}"],"public_key":"KEEP"}\n`;
    const out = streamAll(chunk(payload));
    expect(out).not.toContain("OPAQUE_COOKIE_SENTINEL");
    expect(out).toBe(`{"cookie":"[REDACTED]","public_key":"KEEP"}\n`);
  });
  it("a complete sensitive container over the hold keeps the sibling", () => {
    const payload = `{"credentials":{"k":"${"A".repeat(100000)}"},"public_key":"KEEP"}`;
    const out = streamAll([payload]);
    expect(out).not.toContain("A".repeat(1000));
    expect(out).toContain('"public_key":"KEEP"');
  });
  it("masks a complete sensitive container the same in a single buffer", () => {
    expect(redactText('{"credentials":{"label":"x"},"public_key":"KEEP"}')).toBe('{"credentials":"[REDACTED]","public_key":"KEEP"}');
  });
});

describe("deep but legitimate nesting is still scanned", () => {
  const wrap = (depth: number, inner: string): string => { let text = inner; for (let i = 0; i < depth; i++) text = `{"wrap${i}":${text}}`; return text; };
  const inner = '{"credentials":{"label":"DEEP_OPAQUE_SECRET"},"cookie":["DEEP_COOKIE_SECRET"],"token":424242,"public_key":"KEEP"}';
  it("masks a confirmed field under 12 ordinary levels in a single buffer", () => {
    const out = redactText(wrap(12, inner));
    expect(out).not.toContain("DEEP_OPAQUE_SECRET");
    expect(out).not.toContain("DEEP_COOKIE_SECRET");
    expect(out).not.toContain("424242");
    expect(out).toContain('"public_key":"KEEP"');
    let node = JSON.parse(out) as Record<string, any>;
    for (let i = 11; i >= 0; i--) node = node[`wrap${i}`];
    expect(node).toEqual({ credentials: "[REDACTED]", cookie: "[REDACTED]", token: "[REDACTED]", public_key: "KEEP" });
  });
  it("masks via redactBytes while the original wire bytes stay untouched", () => {
    const wire = Buffer.from(`${wrap(12, inner)}\n`);
    const stored = redactBytes(wire, []);
    expect(stored.toString("utf8")).not.toContain("DEEP_OPAQUE_SECRET");
    expect(wire.toString("utf8")).toContain("DEEP_OPAQUE_SECRET"); // the source buffer is never mutated
  });
  it("completes scanning under a 200-level parent chain", () => {
    const out = redactText(wrap(200, '{"token":999999,"public_key":"KEEP200"}'));
    expect(out).not.toContain("999999");
    expect(out).toContain("KEEP200");
  });
  it("preserves a deep non-sensitive JSON document byte-for-byte", () => {
    const plain = wrap(50, '{"a":1,"b":[1,2,{"c":"hello 世界😀"}]}');
    expect(redactText(plain)).toBe(plain);
  });
});

