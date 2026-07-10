import { describe, expect, it } from "vitest";
import { isAuthorized } from "../server/src/bridge/auth.js";

describe("auth", () => {
  const token = "super-secret-token-1234";

  it("accepts the exact bearer token", () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects missing header", () => {
    expect(isAuthorized(undefined, token)).toBe(false);
  });

  it("rejects wrong token", () => {
    expect(isAuthorized("Bearer wrong-token-abcdef", token)).toBe(false);
  });

  it("rejects token with different length", () => {
    expect(isAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorized(`Bearer ${token.slice(0, -1)}`, token)).toBe(false);
  });

  it("rejects non-bearer schemes", () => {
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(isAuthorized(token, token)).toBe(false);
  });
});
