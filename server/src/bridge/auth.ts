import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer token check.
 * Returns true only when the Authorization header is exactly `Bearer <token>`.
 */
export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader) return false;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (!match) return false;
  const presented = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
