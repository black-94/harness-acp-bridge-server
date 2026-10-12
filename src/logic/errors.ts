import { Redactor, collectSecrets } from "../redact/redact.js";

export class BridgeError extends Error {
  override name = "BridgeError";
  constructor(readonly code: string, message: string, readonly detail?: unknown) { super(message); }
}

const AUTH_ERROR_CODES = new Set([
  "authentication_required",
  "auth_required",
  "unauthenticated",
  "login_required",
  "not_logged_in",
]);

const AUTH_MESSAGE = "Authentication is required. Call authenticate with this session_id and complete the returned questions.";

/** Detect an explicit authentication failure: ACP `-32000`, a known vendor code, or our own error. */
function authDetail(error: unknown): { matched: boolean; detail: unknown } {
  if (error instanceof BridgeError) {
    if (error.code === "authentication_required" || AUTH_ERROR_CODES.has(error.code.toLowerCase())) {
      return { matched: true, detail: error.detail };
    }
    return { matched: false, detail: undefined };
  }
  const value = isRecord(error) ? error : {};
  const detail = isRecord(value.detail) ? value.detail : null;
  const frame = detail && isRecord(detail.frame) ? detail.frame : null;
  const rpcError = frame && isRecord(frame.error) ? frame.error : null;
  const data = rpcError && isRecord(rpcError.data) ? rpcError.data : null;
  const explicit = [value.code, rpcError?.code, data?.code, data?.errorCode]
    .find(candidate => typeof candidate === "string" && AUTH_ERROR_CODES.has(candidate.toLowerCase()));
  if (value.code === -32000 || rpcError?.code === -32000 || explicit !== undefined) {
    return { matched: true, detail: detail ?? value.detail };
  }
  return { matched: false, detail: undefined };
}

/**
 * Normalize only explicit, protocol-level authentication failures (ACP `-32000` or a known vendor
 * auth code) into a canonical `authentication_required`. Arbitrary messages containing "auth" are
 * never reclassified. When `sessionId` is supplied the canonical `session_id`/`next_action` are
 * attached by the caller's boundary; otherwise the upstream detail is carried through unchanged.
 */
export function normalizeError(error: unknown, sessionId?: string): unknown {
  const { matched, detail } = authDetail(error);
  if (!matched) return error;
  return sessionId === undefined
    ? new BridgeError("authentication_required", AUTH_MESSAGE, detail)
    : authenticationRequired(sessionId, detail);
}

/**
 * The canonical unauthenticated error. The helper's own `session_id`/`next_action` always win over
 * any upstream detail, so a harness cannot spoof where the caller must go next.
 */
export function authenticationRequired(sessionId: string, detail?: unknown): BridgeError {
  const extra = isRecord(detail) ? detail : {};
  return new BridgeError("authentication_required", AUTH_MESSAGE, {
    ...extra,
    session_id: sessionId,
    next_action: { method: "authenticate", params: { session_id: sessionId } },
  });
}
export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Defensive redactor so error messages/details echoed back or journaled never carry known secrets. */
const ERROR_REDACTOR = new Redactor(collectSecrets(process.env));
export function errorInfo(error: unknown): { code: string; message: string; detail?: unknown } {
  error = normalizeError(error);
  const value = isRecord(error) ? error : {};
  const code = typeof value.code === "string" ? value.code : value.code === -32601 ? "unsupported_request" : typeof value.code === "number" ? "harness_error" : value.name === "AuthStatusUnsupported" ? "unsupported_response" : value.name === "ConfigError" ? "invalid_param" : value.name === "AdapterError" && /unsupported|not supported|requires an observed/i.test(String(value.message)) ? "unsupported_request" : "internal_error";
  const message = ERROR_REDACTOR.text(error instanceof Error ? error.message : String(error));
  return { code, message, ...(value.detail !== undefined ? { detail: ERROR_REDACTOR.value(value.detail) } : {}) };
}
export async function deadline<T>(promise: Promise<T>, seconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError(code, `${code} after ${seconds}s`)), seconds * 1000);
    })]);
  } finally { clearTimeout(timer); }
}
