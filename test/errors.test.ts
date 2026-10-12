/**
 * Unit coverage for the central authentication-error normalization: only explicit protocol codes
 * are reclassified, the real session_id is attached at the boundary, and the canonical
 * next_action always wins over spoofed upstream detail.
 */
import { describe, expect, it } from "vitest";

import { BridgeError, authenticationRequired, errorInfo, normalizeError } from "../src/logic/errors";

describe("authentication error normalization", () => {
  it("recognizes ACP -32000 and explicit vendor codes, never arbitrary text", () => {
    expect(errorInfo(normalizeError({ code: -32000, message: "auth required" })).code).toBe("authentication_required");
    expect(errorInfo(normalizeError(new BridgeError("unauthenticated", "x"))).code).toBe("authentication_required");
    // A clear `data.code` inside an RPC error frame is recognized.
    const framed = { code: -1, detail: { frame: { error: { code: -1, data: { code: "not_logged_in" } } } } };
    expect(errorInfo(normalizeError(framed)).code).toBe("authentication_required");
    // Arbitrary text containing "auth" is never reclassified.
    const plain = new Error("please auth later");
    expect(normalizeError(plain)).toBe(plain);
    expect(errorInfo(normalizeError(plain)).code).toBe("internal_error");
  });

  it("attaches the real session_id and lets canonical fields win over upstream detail", () => {
    const normalized = normalizeError(
      { code: -32000, detail: { session_id: "spoofed", next_action: { method: "evil" }, refs: [1] } },
      "sess-1",
    ) as BridgeError;
    expect(normalized.code).toBe("authentication_required");
    const detail = normalized.detail as Record<string, any>;
    expect(detail.session_id).toBe("sess-1");
    expect(detail.next_action).toEqual({ method: "authenticate", params: { session_id: "sess-1" } });
    // Non-canonical upstream extras are preserved for diagnostics.
    expect(detail.refs).toEqual([1]);
    expect(authenticationRequired("s2").detail.next_action).toEqual({ method: "authenticate", params: { session_id: "s2" } });
  });
});
