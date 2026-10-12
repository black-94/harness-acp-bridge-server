/**
 * Core redaction rules: the sensitive-key classifier and the textual pattern matcher.
 *
 * Kept dependency-free so both the persistence layer and the bounded streaming redactor can
 * share exactly one definition of "what counts as sensitive". See `redact.ts` for the
 * higher-level `Redactor`/`StreamRedactor` wrappers.
 */
export const REDACTED = "[REDACTED]";
/** Literal secret values shorter than this are ignored to avoid masking ordinary words. */
export const MIN_SECRET_LENGTH = 8;

const EXACT_SENSITIVE = new Set<string>([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "csrftoken",
  "apikey",
  "privatekey",
  "clientsecret",
  "secretkey",
  "secretaccesskey",
  "accesskey",
  "accesskeyid",
  "awssecretaccesskey",
  "awsaccesskeyid",
  "password",
  "passwd",
  "passphrase",
  "authorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "clientkey",
  "sessionkey",
  "authkey",
  "signingkey",
  "encryptionkey",
  "masterkey",
]);

const SENSITIVE_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "apikey",
  "privatekey",
  "clientsecret",
  "accesskey",
  "accesskeyid",
  "secretkey",
  "sessionkey",
  "authkey",
  "signingkey",
  "encryptionkey",
  "masterkey",
  "credential",
  "credentials",
  "authorization",
  "cookie",
];

/** Normalize a key to lowercase alphanumerics: `accessToken` and `access_token` -> `accesstoken`. */
export function normalizeKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * True when an object key names a common credential.
 *
 * Exact matches plus a curated suffix set. The suffix set deliberately excludes `tokens`
 * (plural), so counters such as `max_tokens`/`token_count`/`input_tokens` are never masked,
 * and excludes a bare `key` suffix so `public_key`/`registry_key`/`monkey` are preserved.
 */
export function isSensitiveKeyName(name: string): boolean {
  const normalized = normalizeKey(name);
  if (!normalized) return false;
  if (EXACT_SENSITIVE.has(normalized)) return true;
  // Suffix matching already rejects plural counters (`maxtokens` does not end with `token`).
  return SENSITIVE_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

/**
 * How the streaming redactor finds the end of an over-long value it has already decided is
 * sensitive (so it can resume emitting the ordinary suffix right after the value, instead of
 * dropping the rest of the line).
 */
export type ValueUntil =
  | { kind: "quote"; quote: string }
  | { kind: "line" }
  | { kind: "chars"; stop: RegExp }
  | { kind: "container" };

export interface Range {
  start: number;
  end: number;
  replacement: string;
  /**
   * Earliest offset that must also be held back while this match is still incomplete, so a value
   * split across a chunk boundary is re-detected together with its key. For a `key: value` or
   * `Authorization:` match this is the key/header start; callers that only mask `[start, end)` may
   * ignore it.
   */
  contextStart?: number;
  /** Terminator class for the value, used only by the bounded streaming redactor. */
  until?: ValueUntil;
}

/**
 * Well-known provider token shapes; masked wherever they appear.
 *
 * Each entry carries the token's real allowed-character set (`stop` matches the first byte that is
 * NOT part of the token), so the bounded streaming redactor consumes the WHOLE token when it has to
 * mask an over-long one, instead of truncating at a fixed identifier charset. Real provider tokens
 * contain `-`, `_`, `.`, and `+`/`/`/`=` (Basic); stopping at any of those leaked the tail of an
 * over-long token whose remainder no longer carries the recognizable prefix.
 */
const PROVIDER_PATTERNS: Array<{ pattern: RegExp; stop: RegExp }> = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, stop: /[^A-Za-z0-9_-]/ },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, stop: /[^A-Za-z0-9]/ },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, stop: /[^A-Za-z0-9]/ },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, stop: /[^A-Za-z0-9_]/ },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, stop: /[^A-Za-z0-9-]/ },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, stop: /[^0-9A-Z]/ },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, stop: /[^0-9A-Za-z_-]/ },
  { pattern: /\bya29\.[A-Za-z0-9_-]{10,}\b/g, stop: /[^A-Za-z0-9_.-]/ },
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, stop: /[^A-Za-z0-9]/ },
  { pattern: /\bpypi-[A-Za-z0-9_-]{16,}\b/g, stop: /[^A-Za-z0-9_-]/ },
  // A JWT is three base64url segments joined by dots (padding optional).
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, stop: /[^A-Za-z0-9_.=-]/ },
];

const PEM_PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const AUTH_HEADER = /(?<head>\bauthorization\b\s*[:=]\s*)(?<value>[^\r\n]+)/gid;
const JSON_PAIR = /(?<key>"(?:[^"\\]|\\.)*")\s*:\s*(?<value>"(?:[^"\\]|\\.)*")/gd;
/**
 * Identifier key, optional whitespace, separator, value.
 *
 * The negative lookbehind starts a match only at the beginning of an identifier token, and the
 * identifier run is capped at 64 characters. Together they turn what would otherwise be an O(n²)
 * backwards walk over a long run of identifier bytes (a giant repeated token with no separator,
 * e.g. an oversized stdout line) into a single bounded scan. Whitespace runs are likewise capped.
 */
const KEY_VALUE = /(?<![A-Za-z0-9_])(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,63})\s{0,16}(?<sep>[:=])\s{0,16}(?<value>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]&]+)/gd;
/**
 * Unterminated sensitive values that run to end-of-input (a truncated frame, or a stream flushed
 * mid-value). A closing quote/line never arrives, so the normal pair patterns cannot match; these
 * still mask the value from its opening delimiter so an incomplete frame cannot leak a secret.
 */
const UNTERMINATED_JSON = /(?<key>"(?:[^"\\]|\\.)*")\s{0,16}:\s{0,16}(?<value>"(?:[^"\\]|\\.)*)$/gd;
const UNTERMINATED_KV = /(?<![A-Za-z0-9_])(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,63})\s{0,16}[:=]\s{0,16}(?<value>"(?:[^"\\]|\\.)*)$/gd;
/**
 * `scheme://user:pass@host`. The scheme is bounded (real scheme names are short) and anchored to a
 * token boundary, and the userinfo halves are length-capped, so a long run of letters or a
 * `scheme://` prefix with no `@` cannot trigger a quadratic backwards walk.
 */
const URL_USERINFO = /(?<![A-Za-z0-9+.-])(?<head>[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)(?<user>[^/\s:@]{1,512}):(?<pass>[^/\s@]{1,512})@/gd;
const URL_QUERY = /[?&](?<key>access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|key|password|passwd|secret|client[_-]?secret|auth|signature|sig)=(?<value>[^&#\s"']*)/gid;
const BARE_SCHEME = /\b(?:Bearer|Basic)\s+(?<value>[A-Za-z0-9\-._~+/]{20,}=*)/gd;

function indicesOf(match: RegExpExecArray, group: string): [number, number] | null {
  const entry = match.indices?.groups?.[group];
  return entry ? [entry[0], entry[1]] : null;
}

/**
 * Decode a JSON string token (quotes included) into its real characters, honoring the standard
 * escapes (`\n`, `\t`, `\uXXXX`, `\\`, `\"`, `\/`, surrogate pairs). A non-string token is
 * returned unchanged.
 *
 * A naive `replace(/\\(.)/g, "$1")` drops the backslash, turning `\n` into `n` and `\u0041` into
 * `u0041`; when an ordinary body string is decoded, scanned, and re-encoded that corrupted the
 * unknown text's semantics. This decoder keeps newlines/emoji exact so re-encoding is faithful.
 */
function decodeJsonString(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const body = token.slice(1, -1);
  let output = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") { output += ch; continue; }
    const next = body[++i];
    if (next === undefined) { output += "\\"; break; }
    switch (next) {
      case '"': output += '"'; break;
      case "\\": output += "\\"; break;
      case "/": output += "/"; break;
      case "b": output += "\b"; break;
      case "f": output += "\f"; break;
      case "n": output += "\n"; break;
      case "r": output += "\r"; break;
      case "t": output += "\t"; break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { output += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else output += "u";
        break;
      }
      default: output += next;
    }
  }
  return output;
}

function applyIndices(text: string, pattern: RegExp, accept: (match: RegExpExecArray) => Range | null): Range[] {
  const ranges: Range[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const range = accept(match);
    if (range) ranges.push(range);
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return ranges;
}

function collectRanges(text: string, secrets: readonly string[]): Range[] {
  const ranges: Range[] = [];

  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(secret, from);
      if (at < 0) break;
      ranges.push({ start: at, end: at + secret.length, replacement: REDACTED });
      from = at + secret.length;
    }
  }

  for (const { pattern, stop } of PROVIDER_PATTERNS) {
    for (const range of applyIndices(text, pattern, match => ({ start: match.index, end: match.index + match[0].length, replacement: REDACTED, until: { kind: "chars", stop } }))) ranges.push(range);
  }
  for (const range of applyIndices(text, PEM_PRIVATE_KEY, match => ({ start: match.index, end: match.index + match[0].length, replacement: REDACTED }))) ranges.push(range);
  // An unterminated PRIVATE KEY block in a complete buffer: mask from the header to end of input.
  // Only the matching `-----END ... PRIVATE KEY-----` counts — a foreign END marker (e.g.
  // `-----END EC PARAMETERS-----`) inside the body must not make us think the block closed.
  for (const [begin, typeEnd] of pemHeaders(text)) {
    const type = text.slice(begin + 11, typeEnd).trim();
    if (!/PRIVATE KEY$/.test(type)) continue;
    if (privateKeyEnd(text, typeEnd + 5) < 0) ranges.push({ start: begin, end: text.length, replacement: REDACTED });
  }
  for (const range of applyIndices(text, AUTH_HEADER, match => {
    const head = indicesOf(match, "head");
    const value = indicesOf(match, "value");
    return value ? { start: value[0], end: value[1], replacement: REDACTED, contextStart: head ? head[0] : value[0], until: { kind: "line" } } : null;
  })) ranges.push(range);
  for (const range of applyIndices(text, JSON_PAIR, match => {
    const key = indicesOf(match, "key");
    const value = indicesOf(match, "value");
    if (!key || !value || !isSensitiveKeyName(decodeJsonString(text.slice(key[0], key[1])))) return null;
    return { start: value[0], end: value[1], replacement: `"${REDACTED}"`, contextStart: key[0], until: { kind: "quote", quote: '"' } };
  })) ranges.push(range);
  for (const range of applyIndices(text, KEY_VALUE, match => {
    const key = indicesOf(match, "key");
    const value = indicesOf(match, "value");
    if (!key || !value || !isSensitiveKeyName(text.slice(key[0], key[1]))) return null;
    const raw = text.slice(value[0], value[1]);
    const until: ValueUntil = raw.startsWith('"') ? { kind: "quote", quote: '"' } : raw.startsWith("'") ? { kind: "quote", quote: "'" } : { kind: "chars", stop: /[\s,;}\]&]/ };
    return { start: value[0], end: value[1], replacement: REDACTED, contextStart: key[0], until };
  })) ranges.push(range);
  // Unterminated (end-of-input) sensitive values: mask from the opening quote to the end.
  for (const range of applyIndices(text, UNTERMINATED_JSON, match => {
    const key = indicesOf(match, "key");
    const value = indicesOf(match, "value");
    if (!key || !value || !isSensitiveKeyName(decodeJsonString(text.slice(key[0], key[1])))) return null;
    return { start: value[0], end: value[1], replacement: REDACTED, contextStart: key[0], until: { kind: "quote", quote: '"' } };
  })) ranges.push(range);
  for (const range of applyIndices(text, UNTERMINATED_KV, match => {
    const key = indicesOf(match, "key");
    const value = indicesOf(match, "value");
    if (!key || !value || !isSensitiveKeyName(text.slice(key[0], key[1]))) return null;
    return { start: value[0], end: value[1], replacement: REDACTED, contextStart: key[0], until: { kind: "quote", quote: '"' } };
  })) ranges.push(range);
  for (const range of applyIndices(text, URL_USERINFO, match => {
    const pass = indicesOf(match, "pass");
    const head = indicesOf(match, "head");
    return pass ? { start: pass[0], end: pass[1], replacement: REDACTED, contextStart: head ? head[0] : pass[0], until: { kind: "chars", stop: /[/\s@]/ } } : null;
  })) ranges.push(range);
  for (const range of applyIndices(text, URL_QUERY, match => {
    const value = indicesOf(match, "value");
    return value ? { start: value[0], end: value[1], replacement: REDACTED, contextStart: match.index, until: { kind: "chars", stop: /[&#\s"']/ } } : null;
  })) ranges.push(range);
  for (const range of applyIndices(text, BARE_SCHEME, match => {
    const value = indicesOf(match, "value");
    return value ? { start: value[0], end: value[1], replacement: REDACTED, contextStart: match.index, until: { kind: "chars", stop: /[^A-Za-z0-9\-._~+/=]/ } } : null;
  })) ranges.push(range);

  // Sensitive keys whose value is NOT a plain string (number/null/bool/object/array), and escaped
  // JSON embedded inside an ordinary string value. Regex pairs only cover quoted string values.
  for (const range of scanStructuredValues(text, secrets)) ranges.push(range);

  return ranges;
}

/** Byte offsets of every `-----BEGIN ...-----` header (type text ends before the trailing dashes). */
function pemHeaders(text: string): Array<[number, number]> {
  const headers: Array<[number, number]> = [];
  for (let at = text.indexOf("-----BEGIN"); at >= 0; at = text.indexOf("-----BEGIN", at + 11)) {
    const end = text.indexOf("-----", at + 11);
    if (end >= 0) headers.push([at, end]);
  }
  return headers;
}

/** The matching `-----END ... PRIVATE KEY-----` (not a foreign `-----END ...`); -1 when absent. */
const PRIVATE_KEY_END = /-----END [^-]*PRIVATE KEY-----/;
function privateKeyEnd(text: string, from: number): number {
  const at = text.slice(from).search(PRIVATE_KEY_END);
  return at < 0 ? -1 : from + at;
}

const IDENTIFIER = /[A-Za-z0-9_.-]/;
const JSON_WS = /\s/;
const SCALAR_STOP = /[\s,;}\]&]/;

/** End offset of the JSON string starting at `start` (whose char is `"`), or -1 if unterminated. */
function jsonStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") { if (i + 1 >= text.length) return -1; i++; continue; }
    if (ch === '"') return i + 1;
  }
  return -1;
}

/** End offset of the balanced `{...}`/`[...]` starting at `start`, or -1 if unterminated. */
function containerEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') { const end = jsonStringEnd(text, i); if (end < 0) return -1; i = end - 1; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Depth cap for re-scanning escaped-JSON *body strings* only — a hostile-recursion guard. */
const MAX_BODY_DEPTH = 8;

/** A text region plus the absolute offset of its first character. */
type Region = [text: string, base: number];

/**
 * Single left-to-right pass over structured text. For every `key: value` / `key=value` whose key
 * names a credential, it masks the WHOLE value regardless of JSON type (string/number/null/bool,
 * balanced object/array, or an opaque scalar).
 *
 * Ordinary containers are descended **iteratively** (an explicit worklist), so a confirmed field is
 * still recognised when it sits under many levels of non-sensitive parents — a recursion depth cap
 * must never make a real credential in a deep but legitimate object look like unknown text. Only the
 * escaped-body-string re-scan is depth-bounded, to defuse a hostile nested-string input. Everything
 * not masked is preserved byte-for-byte.
 */
function scanStructuredValues(text: string, secrets: readonly string[]): Range[] {
  return scanRegions([[text, 0]], secrets, 0);
}

function scanRegions(worklist: Region[], secrets: readonly string[], depth: number): Range[] {
  const ranges: Range[] = [];
  if (depth > MAX_BODY_DEPTH) return ranges;
  while (worklist.length > 0) {
    const [text, base] = worklist.pop()!;
    const emit = (start: number, end: number, replacement: string, contextStart?: number, until?: ValueUntil): void => {
      const range: Range = { start: start + base, end: end + base, replacement };
      if (contextStart !== undefined) range.contextStart = contextStart + base;
      if (until !== undefined) range.until = until;
      ranges.push(range);
    };
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      let key: string;
      let keyStart = i;
      let keyEnd: number;
      let quotedKey = false;
      if (ch === '"') {
        const end = jsonStringEnd(text, i);
        if (end < 0) { i++; continue; }
        key = decodeJsonString(text.slice(i, end)); keyStart = i; keyEnd = end; quotedKey = true;
      } else if (IDENTIFIER.test(ch) && /[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < text.length && j - i <= 63 && IDENTIFIER.test(text[j]!)) j++;
        key = text.slice(i, j); keyStart = i; keyEnd = j;
      } else { i++; continue; }
      let k = keyEnd;
      while (k < text.length && JSON_WS.test(text[k]!)) k++;
      const sep = text[k];
      if (sep !== ":" && sep !== "=") { i = keyEnd; continue; }
      let v = k + 1;
      while (v < text.length && JSON_WS.test(text[v]!)) v++;
      if (v >= text.length) { i = keyEnd; continue; }
      const sensitive = isSensitiveKeyName(key);
      const vch = text[v]!;
      if (vch === '"') {
        const end = jsonStringEnd(text, v);
        if (end < 0) { i = keyEnd; continue; }
        if (sensitive) emit(v, end, `"${REDACTED}"`, keyStart, { kind: "quote", quote: '"' });
        else {
          // Escaped JSON inside an ordinary string value: redact it and re-escape.
          const inner = decodeJsonString(text.slice(v, end));
          const sub = scanRegions([[inner, 0]], secrets, depth + 1);
          if (sub.length) emit(v, end, `"${escapeJsonString(applyRanges(inner, sub))}"`);
        }
        i = end; continue;
      }
      if (vch === "{" || vch === "[") {
        const end = containerEnd(text, v);
        if (end < 0) {
          // The container value is not closed within this buffer (a truncated frame or a stream
          // fragment). A CONFIRMED sensitive key still must not leak its opaque children, so emit a
          // range that lets the streaming redactor consume a balanced container across chunks; it
          // resumes right after the matching close, preserving `public_key`/ordinary neighbours.
          if (sensitive) { emit(v, text.length, quotedKey ? `"${REDACTED}"` : REDACTED, keyStart, { kind: "container" }); i = text.length; }
          else i = keyEnd;
          continue;
        }
        if (sensitive) emit(v, end, quotedKey ? `"${REDACTED}"` : REDACTED, keyStart);
        else worklist.push([text.slice(v, end), base + v]);
        i = end; continue;
      }
      let j = v;
      while (j < text.length && !SCALAR_STOP.test(text[j]!)) j++;
      if (sensitive) emit(v, j, quotedKey ? `"${REDACTED}"` : REDACTED, keyStart);
      i = j > v ? j : v + 1;
    }
  }
  return ranges;
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Sorted, non-overlapping masked ranges for a text blob. */
export function matchRanges(text: string, secrets: readonly string[] = []): Range[] {
  if (!text) return [];
  const candidates = collectRanges(text, secrets)
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  // Merge overlapping candidates into whole intervals. Greedily keeping only the longest match at
  // each start could leave the tail of a shorter, later-starting match exposed (e.g. a literal
  // secret overlapping the end of a provider pattern); merging guarantees full coverage.
  const merged: Range[] = [];
  for (const range of candidates) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      if (range.end > last.end) last.end = range.end;
      if (range.contextStart !== undefined && (last.contextStart === undefined || range.contextStart < last.contextStart)) last.contextStart = range.contextStart;
    } else merged.push({ ...range });
  }
  return merged;
}

/** Apply already-computed, sorted, non-overlapping ranges without re-scanning the text. */
export function applyRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  let output = "";
  let position = 0;
  for (const range of ranges) {
    if (range.start < position) continue;
    output += text.slice(position, range.start) + range.replacement;
    position = range.end;
  }
  return output + text.slice(position);
}

/** Mask sensitive keys and patterns in a text blob, preserving everything else verbatim. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  if (!text) return text;
  return applyRanges(text, matchRanges(text, secrets));
}
