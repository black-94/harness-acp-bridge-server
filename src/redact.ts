/**
 * Redaction for on-disk copies of bridge traffic and state.
 *
 * The real ACP byte stream is never rewritten: the transport delivers original bytes to the
 * adapter and writes original bytes to the harness. This module only sanitizes the *copies* the
 * bridge persists (the raw journal, session/queue snapshots, message results, temporary
 * metadata, and diagnostics logs) before they touch disk.
 *
 * Scope is deliberately conservative, per the operator's instruction ("only handle common
 * sensitive fields and body content; do not touch what cannot be identified reliably"):
 *
 *   - values under object keys that name a common credential are replaced recursively;
 *   - a small set of unambiguous textual patterns is masked (Authorization headers,
 *     `key=value` / JSON sensitive pairs, URL userinfo and query credentials, PEM private
 *     keys, and well-known provider token shapes);
 *   - literal secret *values* from sensitive-named environment/configuration keys are masked
 *     wherever they appear, so a known key echoed in an ordinary field is still caught;
 *   - ordinary text, unknown blobs, and identifiers (`max_tokens`, `token_count`, message
 *     ids, model ids, emails) are preserved verbatim.
 *
 * It is **not** a guarantee that every unknown secret or PII is removed. Unknown/unrecognized
 * content is intentionally preserved.
 */
import { REDACTED, applyRanges, isSensitiveKeyName, matchRanges, redactText, type Range, type ValueUntil } from "./redact-core.js";

export { REDACTED, isSensitiveKeyName, redactText, matchRanges } from "./redact-core.js";

export const MIN_SECRET_LENGTH = 8;

/** A nested record value with credential-named keys and textual secrets masked. */
export function redactValue<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return redactText(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKeyName(key) ? REDACTED : redactValue(item, secrets);
    }
    return out as unknown as T;
  }
  return value;
}

function normalizeSecrets(secrets: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string") continue;
    const value = secret.trim();
    // Very short values would mask ordinary words; ignore them.
    if (value.length < MIN_SECRET_LENGTH) continue;
    unique.add(value);
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

/** True when an environment/config key names a value that must never be persisted. */
export function isSensitiveName(name: unknown): boolean {
  return typeof name === "string" && isSensitiveKeyName(name);
}

/** Collect literal secret values from sensitive-named environment and harness environment keys. */
export function collectSecrets(
  env: NodeJS.ProcessEnv = process.env,
  harnesses: Record<string, { env?: Record<string, string> }> = {},
): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && isSensitiveName(key)) secrets.push(value);
  }
  for (const harness of Object.values(harnesses)) {
    for (const [key, value] of Object.entries(harness.env ?? {})) {
      if (isSensitiveName(key)) secrets.push(value);
    }
  }
  return secrets;
}

/** Redact a persisted byte blob. Valid UTF-8 is round-tripped exactly when untouched. */
export function redactBytes(buffer: Buffer, secrets: readonly string[]): Buffer {
  if (buffer.length === 0) return buffer;
  const strict = strictUtf8(buffer);
  if (strict !== null) {
    const safe = redactText(strict, secrets);
    return safe === strict ? buffer : Buffer.from(safe, "utf8");
  }
  // Not valid UTF-8: operate in latin1 so every untouched byte round-trips exactly. Map the known
  // literal secrets to their latin1 (byte-preserving) form so a multibyte secret echoed into a
  // non-UTF-8 blob is still caught instead of surviving as mojibake.
  const latin = buffer.toString("latin1");
  const latinSecrets = secrets.map(secret => Buffer.from(secret, "utf8").toString("latin1"));
  const safe = redactText(latin, latinSecrets);
  return safe === latin ? buffer : Buffer.from(safe, "latin1");
}

function strictUtf8(buffer: Buffer): string | null {
  // `ignoreBOM: true` keeps a leading BOM in the decoded string; the default strips it, which
  // would silently drop the BOM from every persisted copy that we decode/re-encode.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { return null; }
}

/**
 * A redactor bound to a fixed set of literal secrets. Cheap to construct; the secret set is
 * kept in memory only and never written to disk.
 */
export class Redactor {
  readonly secrets: readonly string[];
  constructor(secrets: readonly string[] = []) { this.secrets = normalizeSecrets(secrets); }
  text(value: string): string { return redactText(value, this.secrets); }
  value<T>(value: T): T { return redactValue(value, this.secrets); }
  bytes(buffer: Buffer): Buffer { return redactBytes(buffer, this.secrets); }
  /** A bounded, cross-chunk redactor for streamed diagnostics (stderr, oversized fragments). */
  stream(charset: "utf8" | "latin1" = "utf8"): StreamRedactor {
    return new StreamRedactor(this.secrets, charset);
  }
}

// ---------------------------------------------------------------------------
// Bounded cross-chunk streaming redactor
// ---------------------------------------------------------------------------

/** How much trailing context is held back so a secret split across chunks is still caught. */
const BASE_HOLD_BYTES = 8192;
/** Upper bound on held-back bytes before we force emission (never unbounded). */
const MAX_HOLD_BYTES = 64 * 1024;
/** Bytes kept while inside a private-key block so a split END marker is still seen. */
const PEM_TAIL_BYTES = 96;
/** A plausible PEM header is short; a longer unfinished `-----BEGIN` run is ordinary text. */
const MAX_PEM_HEADER = 64;

const EMPTY = Buffer.alloc(0);
/** The matching close of a *private key*, never a foreign `-----END ...` marker. */
const PEM_END = /-----END [^-]*PRIVATE KEY-----/;
const PEM_BEGIN = "-----BEGIN";
const ONE_BYTE = (): number => 1;

/** A decoded view of the carry: the text, how many bytes it consumed, and how to re-encode it. */
interface DecodedView {
  text: string;
  consumed: number;
  encoding: "utf8" | "latin1";
  width: (char: string) => number;
}

/** Offset just past a matching `-----END ... PRIVATE KEY-----` at/after `from`; -1 when absent. */
function privateKeyEnd(text: string, from: number): number {
  const at = text.slice(from).search(PEM_END);
  return at < 0 ? -1 : from + at;
}

/**
 * Scan for PEM headers. Only a CONFIRMED `PRIVATE KEY` header is sensitive; a header still
 * arriving (`pendingHeader`) is held until it can be classified, and a non-private header
 * (`PUBLIC KEY`, certificates) is left alone. `open` is a private block whose END never arrived.
 *
 * The header run is bounded: an unfinished `-----BEGIN` followed by more than `MAX_PEM_HEADER`
 * bytes without a closing `-----` cannot be a header, so it is treated as ordinary text (keeping
 * the held-back carry bounded) instead of waiting forever.
 */
function scanPem(text: string): { open: number | null; pendingHeader: number | null } {
  let at = text.indexOf(PEM_BEGIN);
  while (at >= 0) {
    const dash = text.indexOf("-----", at + 11);
    if (dash < 0) {
      return { open: null, pendingHeader: text.length - at <= MAX_PEM_HEADER ? at : null };
    }
    if (/PRIVATE KEY$/.test(text.slice(at + 11, dash).trim())) {
      const end = privateKeyEnd(text, dash + 5);
      if (end < 0) return { open: at, pendingHeader: null };
      at = text.indexOf(PEM_BEGIN, end);
    } else {
      at = text.indexOf(PEM_BEGIN, dash + 5);
    }
  }
  return { open: null, pendingHeader: null };
}

/**
 * A bounded streaming redactor for chunked diagnostics.
 *
 * Callers feed arbitrary chunks; it returns the redacted bytes that are safe to persist, holding
 * back a bounded tail so a secret or multi-line construct split across chunk boundaries is never
 * emitted half-redacted. `flush()` releases the tail at EOF.
 *
 * Memory is hard-bounded. When a *confirmed* sensitive value (a quoted/unquoted credential value,
 * an Authorization value, a runaway provider token, or an unterminated PRIVATE KEY body) grows
 * past the hold budget without terminating, the redactor masks the value and then, guided by the
 * value's real terminator (closing quote / delimiter / non-token byte / end-of-line), resumes
 * emitting the ordinary suffix right after it. The field key/prefix before the value is preserved,
 * so the rest of the line is never dropped.
 */
export class StreamRedactor {
  private carry: Buffer = Buffer.alloc(0);
  private inPem = false;
  /** Inside an over-long confirmed value: `until` describes how to find its real end. */
  private mask: ValueUntil | null = null;
  private maskEscaped = false;
  /** Nesting depth and string state while consuming a `container` value. */
  private containerDepth = 0;
  private containerQuoted = false;
  private readonly hold: number;
  private readonly utf8Secrets: readonly string[];
  private readonly latin1Secrets: readonly string[];
  private readonly charset: "utf8" | "latin1";
  constructor(secrets: readonly string[], charset: "utf8" | "latin1" = "utf8") {
    this.charset = charset;
    this.utf8Secrets = [...secrets];
    // A multibyte known secret, when the bytes are read as latin1, appears as its utf8 bytes
    // reinterpreted as latin1 code points; match that form when we fall back to latin1 decoding.
    this.latin1Secrets = secrets.map(secret => Buffer.from(secret, "utf8").toString("latin1"));
    const longest = this.utf8Secrets.reduce((max, secret) => Math.max(max, Buffer.byteLength(secret, charset)), 0);
    this.hold = Math.min(MAX_HOLD_BYTES, Math.max(BASE_HOLD_BYTES, longest + 256));
  }
  push(chunk: Buffer): Buffer {
    if (this.mask) {
      const rest = this.consumeMask(chunk);
      if (rest === null) return EMPTY;
      chunk = rest;
      if (chunk.length === 0) return EMPTY;
    }
    if (chunk.length) this.carry = this.carry.length ? Buffer.concat([this.carry, chunk]) : Buffer.from(chunk);
    return this.drain(false);
  }
  flush(): Buffer {
    this.mask = null; this.maskEscaped = false; this.containerDepth = 0; this.containerQuoted = false;
    return this.drain(true);
  }
  /**
   * Drop masked value bytes until the terminator. Returns the remainder (the terminator itself is
   * kept for `quote`/`chars`/`line`, dropped for `container` since the close belongs to the
   * placeholder), or null when the terminator has not arrived yet.
   */
  private consumeMask(chunk: Buffer): Buffer | null {
    const mask = this.mask!;
    if (mask.kind === "quote") {
      const quote = mask.quote.charCodeAt(0);
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (this.maskEscaped) { this.maskEscaped = false; continue; }
        if (byte === 0x5c) { this.maskEscaped = true; continue; }
        if (byte === quote) { this.mask = null; this.maskEscaped = false; return chunk.subarray(i); }
      }
      return null;
    }
    if (mask.kind === "container") {
      // Track a balanced `{}`/`[]` across chunks, ignoring delimiters inside JSON strings. Resume
      // *after* the matching close: the whole value is replaced by the placeholder.
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (this.maskEscaped) { this.maskEscaped = false; continue; }
        if (this.containerQuoted) {
          if (byte === 0x5c) this.maskEscaped = true;
          else if (byte === 0x22) this.containerQuoted = false;
          continue;
        }
        if (byte === 0x22) this.containerQuoted = true;
        else if (byte === 0x7b || byte === 0x5b) this.containerDepth++;
        else if (byte === 0x7d || byte === 0x5d) {
          this.containerDepth--;
          if (this.containerDepth === 0) { this.mask = null; return chunk.subarray(i + 1); }
        }
      }
      return null;
    }
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      const stop = mask.kind === "line" ? byte === 10 || byte === 13 : mask.stop.test(String.fromCharCode(byte));
      // The terminator itself is ordinary content: keep it so it is emitted normally.
      if (stop) { this.mask = null; return chunk.subarray(i); }
    }
    return null;
  }
  /**
   * Longest valid prefix of the carry plus how to re-encode it. When the bytes are not valid UTF-8
   * the view is decoded as latin1 (`encoding: "latin1"`) so the untouched bytes round-trip exactly
   * rather than being mojibake'd by a later utf8 re-encode.
   */
  private decodeView(): DecodedView {
    if (this.charset === "latin1") return { text: this.carry.toString("latin1"), consumed: this.carry.length, encoding: "latin1", width: ONE_BYTE };
    let end = this.carry.length;
    let index = this.carry.length - 1;
    for (let steps = 0; index >= 0 && steps < 3 && (this.carry[index]! & 0xc0) === 0x80; steps++) index--;
    if (index >= 0) {
      const lead = this.carry[index]!;
      const size = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
      if (index + size > this.carry.length) end = index;
    }
    const prefix = this.carry.subarray(0, end);
    const strict = strictUtf8(prefix);
    if (strict === null) return { text: prefix.toString("latin1"), consumed: end, encoding: "latin1", width: ONE_BYTE };
    return { text: strict, consumed: end, encoding: "utf8", width: (char: string) => Buffer.byteLength(char, "utf8") };
  }
  /** Emit `text[0..cut)` (redacted), consume its bytes from the carry, and return the encoded bytes. */
  private emitPrefix(text: string, cut: number, encoding: "utf8" | "latin1", ranges?: readonly Range[]): Buffer {
    const prefix = text.slice(0, cut);
    const consumed = encoding === "latin1" ? prefix.length : Buffer.byteLength(prefix, "utf8");
    this.carry = this.carry.subarray(consumed);
    const secrets = encoding === "latin1" ? this.latin1Secrets : this.utf8Secrets;
    const redacted = ranges ? applyRanges(prefix, ranges.filter(range => range.start < cut)) : redactText(prefix, secrets);
    return Buffer.from(redacted, encoding);
  }
  /**
   * The hold budget is exhausted by a confirmed sensitive value. Emit everything before the value
   * (the field key and separator, plus the opening quote for a quoted value), a single placeholder,
   * then consume the buffered value content up to its real terminator and resume emitting the
   * ordinary suffix — never dropping the rest of the line and never leaking the value.
   */
  private enterMask(text: string, view: DecodedView, ranges: readonly Range[], final: boolean): Buffer {
    const blocker = ranges.find(range => (range.contextStart ?? range.start) === 0) ?? ranges[0];
    if (!blocker) { this.carry = EMPTY; return Buffer.from(applyRanges(text, ranges), view.encoding); }
    // A finite match (a known literal, a complete container, a PEM block) already has its exact end
    // in this buffer: mask just that match and resume right after it, instead of suppressing the
    // rest of the line. This keeps an ordinary suffix even for an over-long literal.
    if (!blocker.until) return this.replaceFinite(text, view, ranges, blocker, final);
    const until = blocker.until;
    const prefix = applyRanges(text.slice(0, blocker.start), ranges.filter(range => range.end <= blocker.start));
    if (until.kind === "container") {
      // Consume a balanced `{}`/`[]` (across chunks) and resume after the close; the placeholder
      // already includes the value's quotes so the surrounding JSON stays valid.
      const contentOffset = view.encoding === "latin1" ? blocker.start : Buffer.byteLength(text.slice(0, blocker.start), "utf8");
      this.mask = until; this.maskEscaped = false; this.containerDepth = 0; this.containerQuoted = false;
      const rest = this.consumeMask(this.carry.subarray(contentOffset));
      const pieces: Buffer[] = [Buffer.from(prefix, view.encoding), Buffer.from(blocker.replacement, view.encoding)];
      if (rest === null) { this.carry = EMPTY; return Buffer.concat(pieces); }
      this.carry = rest;
      pieces.push(this.drain(final));
      return Buffer.concat(pieces);
    }
    let head = "";
    if (until.kind === "quote" && text[blocker.start] === until.quote) head = until.quote;
    const contentStart = blocker.start + head.length;
    const contentOffset = view.encoding === "latin1" ? contentStart : Buffer.byteLength(text.slice(0, contentStart), "utf8");
    this.mask = until;
    this.maskEscaped = false;
    const rest = this.consumeMask(this.carry.subarray(contentOffset));
    const pieces: Buffer[] = [Buffer.from(prefix, view.encoding)];
    if (head) pieces.push(Buffer.from(head, view.encoding));
    pieces.push(Buffer.from(REDACTED, view.encoding));
    if (rest === null) { this.carry = EMPTY; return Buffer.concat(pieces); }
    this.carry = rest;
    pieces.push(this.drain(final));
    return Buffer.concat(pieces);
  }
  /** Mask exactly `[blocker.start, blocker.end)` (a complete match) and resume after it. */
  private replaceFinite(text: string, view: DecodedView, ranges: readonly Range[], blocker: Range, final: boolean): Buffer {
    const prefix = applyRanges(text.slice(0, blocker.start), ranges.filter(range => range.end <= blocker.start));
    const consumed = view.encoding === "latin1" ? blocker.end : Buffer.byteLength(text.slice(0, blocker.end), "utf8");
    this.carry = this.carry.subarray(consumed);
    const pieces: Buffer[] = [Buffer.from(prefix, view.encoding), Buffer.from(blocker.replacement, view.encoding)];
    if (this.carry.length) pieces.push(this.drain(final));
    return Buffer.concat(pieces);
  }
  private drain(final: boolean): Buffer {
    if (this.carry.length === 0) { this.inPem = false; return EMPTY; }
    const view = this.decodeView();
    const { text, encoding } = view;
    const secrets = encoding === "latin1" ? this.latin1Secrets : this.utf8Secrets;

    if (this.inPem) {
      const end = PEM_END.exec(text);
      if (end) {
        this.inPem = false;
        const consumed = encoding === "latin1" ? end.index + end[0].length : Buffer.byteLength(text.slice(0, end.index + end[0].length), "utf8");
        this.carry = this.carry.subarray(consumed);
        return this.drain(final);
      }
      if (final) { this.inPem = false; this.carry = EMPTY; return EMPTY; }
      // Keep a short tail so a split END marker is still seen; drop the rest of the body.
      this.carry = this.carry.subarray(Math.max(0, this.carry.length - PEM_TAIL_BYTES));
      return EMPTY;
    }

    const pem = scanPem(text);
    if (pem.open !== null) {
      const open = pem.open;
      const ranges = matchRanges(text, secrets);
      if (final || this.carry.length - open > this.hold) {
        const prefix = applyRanges(text.slice(0, open), ranges.filter(range => range.end <= open));
        this.carry = EMPTY;
        this.inPem = true;
        return Buffer.concat([Buffer.from(prefix, encoding), Buffer.from(REDACTED, encoding)]);
      }
      const budget = Math.max(0, this.carry.length - this.hold);
      return this.emitPrefix(text, Math.min(safeCut(text, budget, ranges, view.width), open), encoding, ranges);
    }
    if (pem.pendingHeader !== null && !final) {
      // A header is still arriving, so it might become PRIVATE KEY: hold from it (do not mask yet).
      const ranges = matchRanges(text, secrets);
      const budget = Math.max(0, this.carry.length - this.hold);
      return this.emitPrefix(text, Math.min(safeCut(text, budget, ranges, view.width), pem.pendingHeader), encoding, ranges);
    }

    // EOF: process the whole remaining carry as one blob so a secret still held in the tail is
    // redacted rather than flushed raw, while unknown bytes round-trip exactly.
    if (final) { const tail = this.carry; this.carry = EMPTY; return redactBytes(tail, this.utf8Secrets); }

    const ranges = matchRanges(text, secrets);
    const budget = Math.max(0, this.carry.length - this.hold);
    const cut = safeCut(text, budget, ranges, view.width);
    if (cut === 0 && this.carry.length > this.hold) return this.enterMask(text, view, ranges, final);
    return this.emitPrefix(text, cut, encoding, ranges);
  }
}

/**
 * Largest character offset that is safe to emit (no recognized match or UTF-8 sequence is
 * split), capped by the byte budget. `width` gives the encoded byte length of a single character.
 *
 * Iteration is by Unicode code point, not UTF-16 code unit: measuring a lone surrogate half
 * (`Buffer.byteLength("\uD83D") === 3`) would overcount an emoji pair as 6 bytes instead of 4 and
 * cut the tail short. Cutting at a code-point boundary also means a surrogate pair is never split
 * across the emitted prefix and the held tail.
 */
function safeCut(text: string, byteBudget: number, ranges: readonly Range[], width: (char: string) => number): number {
  if (byteBudget <= 0) return 0;
  let bytes = 0;
  let limit = text.length;
  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index) as number);
    const size = width(char);
    if (bytes + size > byteBudget) { limit = index; break; }
    bytes += size;
    index += char.length;
  }
  for (const range of ranges) {
    if (range.start >= limit) break;
    // Hold from the key/header start of an incomplete match, not just its value, so the key is
    // still present when the value completes in a later chunk and the pair can be re-detected.
    if (range.end > limit) { limit = range.contextStart ?? range.start; break; }
  }
  while (limit > 0 && limit < text.length && isHighSurrogate(text[limit - 1]!)) limit--;
  return Math.max(0, limit);
}

function isHighSurrogate(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}
