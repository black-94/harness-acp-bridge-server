/** Credential filtering for public account snapshots, independent of raw transport recording. */
/**
 * The only account fields ever echoed back for display. A real ACP server can return
 * live credentials (`token`, `accessToken`) inside its account object, so results are
 * rebuilt from this whitelist instead of forwarding the harness object verbatim.
 */
export const ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
  "userId",
  "user_id",
  "username",
  "userName",
  "name",
  "displayName",
  "nickname",
  "email",
]);

// Key names that mark a value as a credential. Matched case-insensitively against object
// keys only (never free text), so a credential in a JSON field can never be persisted.
const SENSITIVE_KEY_RE =
  /token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key/i;

export function isSensitiveKey(name: unknown): boolean {
  return typeof name === "string" && SENSITIVE_KEY_RE.test(name);
}

/** Return the whitelisted, display-only subset of a harness account object. */
export function publicAccount(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const account: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ACCOUNT_FIELDS.has(key) || isSensitiveKey(key)) continue;
    if (typeof item !== "string" && typeof item !== "number") continue;
    if (typeof item === "string" && !item.trim()) continue;
    account[key] = item;
  }
  return Object.keys(account).length > 0 ? account : null;
}

