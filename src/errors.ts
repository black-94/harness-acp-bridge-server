export class BridgeError extends Error {
  override name = "BridgeError";
  constructor(readonly code: string, message: string, readonly detail?: unknown) { super(message); }
}
export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function errorInfo(error: unknown): { code: string; message: string; detail?: unknown } {
  const value = isRecord(error) ? error : {};
  const code = typeof value.code === "string" ? value.code : value.code === -32601 ? "unsupported_request" : typeof value.code === "number" ? "harness_error" : value.name === "AuthStatusUnsupported" ? "unsupported_response" : value.name === "ConfigError" ? "invalid_param" : value.name === "AdapterError" && /unsupported|not supported|requires an observed/i.test(String(value.message)) ? "unsupported_request" : "internal_error";
  return { code, message: error instanceof Error ? error.message : String(error), ...(value.detail !== undefined ? { detail: value.detail } : {}) };
}
export async function deadline<T>(promise: Promise<T>, seconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError(code, `${code} after ${seconds}s`)), seconds * 1000);
    })]);
  } finally { clearTimeout(timer); }
}
