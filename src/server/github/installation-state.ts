import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

interface StatePayload {
  userId: string;
  nonce: string;
  expiresAt: number;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", config.BETTER_AUTH_SECRET)
    .update(`github-installation:${encodedPayload}`)
    .digest("base64url");
}

function encode(payload: StatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(encodedPayload: string): StatePayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.userId !== "string" || typeof candidate.nonce !== "string") return null;
    if (typeof candidate.expiresAt !== "number") return null;
    return { userId: candidate.userId, nonce: candidate.nonce, expiresAt: candidate.expiresAt };
  } catch {
    return null;
  }
}

export function createInstallationState(userId: string, now = Date.now()): string {
  const payload: StatePayload = {
    userId,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: now + config.GITHUB_INSTALLATION_STATE_TTL_SECONDS * 1_000,
  };
  const encoded = encode(payload);
  return `${encoded}.${sign(encoded)}`;
}

export function verifyInstallationState(state: string, now = Date.now()): { userId: string } | null {
  const separator = state.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = state.slice(0, separator);
  const signature = Buffer.from(state.slice(separator + 1));
  const expected = Buffer.from(sign(encoded));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

  const payload = decode(encoded);
  if (!payload || payload.expiresAt <= now) return null;
  return { userId: payload.userId };
}
