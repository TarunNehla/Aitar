import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { createEmailVerificationToken } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAuthOptions } from "./auth.js";
import { config } from "../config.js";

interface SentEmail {
  to: string[];
  from: string;
  subject: string;
  text: string;
  html: string;
  authorization: string | null;
}

function newAuth(overrides: Partial<typeof baseAuthOptions> = {}) {
  database = { users: [], auth_sessions: [], accounts: [], verifications: [] };
  return betterAuth({ ...baseAuthOptions, ...overrides, database: memoryAdapter(database) });
}

let sent: SentEmail[] = [];
let database: MemoryDB;
let auth: ReturnType<typeof newAuth>;

function resendTransport() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const payload = JSON.parse(String(init?.body)) as Omit<SentEmail, "authorization">;
    sent.push({ ...payload, authorization: headers.get("authorization") });
    expect(String(input)).toBe("https://api.resend.com/emails");
    return new Response(JSON.stringify({ id: "message-1" }), { status: 200 });
  });
}

/** Mirrors the browser: same-origin requests carrying whatever cookies were last set. */
function client(instance = auth) {
  const jar = new Map<string, string>();

  async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const request = new Request(`${config.APP_URL}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      redirect: "manual",
      headers: {
        origin: config.APP_URL,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const response = await instance.handler(request);
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return response;
  }

  return {
    call,
    jar,
    async json(path: string, init?: Parameters<typeof call>[1]) {
      const response = await call(path, init);
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, response };
    },
  };
}

async function waitForEmail(index: number): Promise<SentEmail> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(index));
  return sent[index];
}

function linkIn(email: SentEmail): string {
  const match = /https?:\/\/\S+/.exec(email.text);
  if (!match) throw new Error("The email carried no link");
  return match[0];
}

function tokenIn(email: SentEmail): string {
  const url = new URL(linkIn(email));
  return url.searchParams.get("token") ?? (url.pathname.split("/").pop() as string);
}

/** Emails carry absolute URLs; the client helper addresses paths under the auth base. */
function authPath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace("/api/auth", "") + parsed.search;
}

async function signUp(instance: ReturnType<typeof client>, email: string, password = "correct horse 9") {
  return instance.json("/sign-up/email", { body: { name: "Ada Lovelace", email, password, callbackURL: "/" } });
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", resendTransport());
  auth = newAuth();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credential sign up", () => {
  it("creates one user with the password hashed into the credential account", async () => {
    const app = client();
    const password = "correct horse 9";
    const result = await signUp(app, "ada@example.com", password);

    expect(result.status).toBe(200);
    expect(database.users).toHaveLength(1);
    expect(database.users[0].emailVerified).toBe(false);
    expect(database.users[0]).not.toHaveProperty("password");
    expect(JSON.stringify(database.users)).not.toContain(password);

    const credential = database.accounts.filter((account) => account.providerId === "credential");
    expect(credential).toHaveLength(1);
    expect(credential[0].password).toBeTruthy();
    expect(credential[0].password).not.toContain(password);
  });

  it("creates no usable session before the address is verified", async () => {
    const app = client();
    const result = await signUp(app, "ada@example.com");

    expect(result.body?.token).toBeNull();
    expect([...app.jar.keys()].some((name) => name.includes("session_token"))).toBe(false);
    expect(database.auth_sessions).toHaveLength(0);

    const session = await app.json("/get-session");
    expect(session.body).toBeNull();
  });

  it("sends a verification link that names no password", async () => {
    const app = client();
    await signUp(app, "ada@example.com", "correct horse 9");
    const email = await waitForEmail(0);

    expect(email.to).toEqual(["ada@example.com"]);
    expect(email.from).toBe(config.AUTH_EMAIL_FROM);
    expect(email.subject).toBe("Verify your Aitar email");
    expect(email.text).toContain("/api/auth/verify-email?token=");
    expect(email.html).toContain("Verify your Aitar email");
    expect(email.text).not.toContain("correct horse 9");
    expect(email.html).not.toContain("correct horse 9");
    expect(email.authorization).toBe(`Bearer ${config.RESEND_API_KEY}`);
  });

  it("answers an existing address exactly as it answers a new one", async () => {
    const app = client();
    const first = await signUp(app, "ada@example.com");
    sent = [];
    const duplicate = await signUp(app, "ada@example.com");
    const fresh = await signUp(app, "grace@example.com");

    expect(duplicate.status).toBe(first.status);
    expect(duplicate.status).toBe(fresh.status);
    expect(Object.keys(duplicate.body ?? {}).sort()).toEqual(Object.keys(fresh.body ?? {}).sort());
    expect(duplicate.body?.token).toBe(fresh.body?.token);
    expect(database.users.filter((user) => user.email === "ada@example.com")).toHaveLength(1);
  });

  it("refuses a password outside the configured length", async () => {
    const app = client();

    expect((await signUp(app, "short@example.com", "1234567")).status).toBe(400);
    expect((await signUp(app, "long@example.com", "a".repeat(129))).status).toBe(400);
    expect(database.users).toHaveLength(0);
  });
});

describe("email verification", () => {
  it("verifies the address and lets the user sign in", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    const verified = await app.call(authPath(linkIn(await waitForEmail(0))));
    expect(verified.status).toBe(302);
    expect(database.users[0].emailVerified).toBe(true);

    const signedIn = await app.json("/sign-in/email", { body: { email: "ada@example.com", password: "correct horse 9" } });
    expect(signedIn.status).toBe(200);
    expect((signedIn.body?.user as { email: string }).email).toBe("ada@example.com");
  });

  it("sends a new link and refuses the session while the address is unverified", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);
    sent = [];

    const attempt = await app.json("/sign-in/email", { body: { email: "ada@example.com", password: "correct horse 9" } });

    expect(attempt.status).toBe(403);
    expect(attempt.body?.code).toBe("EMAIL_NOT_VERIFIED");
    expect(database.auth_sessions).toHaveLength(0);
    expect((await waitForEmail(0)).subject).toBe("Verify your Aitar email");
  });

  it("resends verification on request", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);
    sent = [];

    const resent = await app.json("/send-verification-email", {
      body: { email: "ada@example.com", callbackURL: "/" },
    });

    expect(resent.status).toBe(200);
    expect((await waitForEmail(0)).to).toEqual(["ada@example.com"]);
  });

  it("answers an unknown address the same way as an unverified one", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);

    const known = await app.json("/send-verification-email", { body: { email: "ada@example.com", callbackURL: "/" } });
    const unknown = await app.json("/send-verification-email", { body: { email: "nobody@example.com", callbackURL: "/" } });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it("rejects an expired link and leaves the address unverified", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);

    const expired = await createEmailVerificationToken(config.BETTER_AUTH_SECRET, "ada@example.com", undefined, -60);
    const response = await app.call(`/verify-email?token=${expired}&callbackURL=%2F`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=TOKEN_EXPIRED");
    expect(database.users[0].emailVerified).toBe(false);
  });

  it("rejects a link that was never issued", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);

    const response = await app.call("/verify-email?token=not-a-real-token&callbackURL=%2F");

    expect(response.headers.get("location")).toContain("error=INVALID_TOKEN");
    expect(database.users[0].emailVerified).toBe(false);
  });
});

describe("credential sign in", () => {
  async function verifiedUser(email = "ada@example.com", password = "correct horse 9") {
    const app = client();
    await signUp(app, email, password);
    await app.call(authPath(linkIn(await waitForEmail(sent.length - 1))));
    sent = [];
    return app;
  }

  it("cannot be told apart from an unknown address and a wrong password", async () => {
    const app = await verifiedUser();
    await app.json("/sign-out", { body: {} });

    const wrongPassword = await app.json("/sign-in/email", { body: { email: "ada@example.com", password: "wrong password" } });
    const unknownEmail = await app.json("/sign-in/email", { body: { email: "nobody@example.com", password: "wrong password" } });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(String(wrongPassword.body?.message)).not.toMatch(/password is|no account|not found/i);
  });

  it("keeps the session across requests and drops it on sign out", async () => {
    const app = await verifiedUser();

    const session = await app.json("/get-session");
    expect((session.body?.user as { email: string }).email).toBe("ada@example.com");

    await app.json("/sign-out", { body: {} });
    expect((await app.json("/get-session")).body).toBeNull();
    expect(database.auth_sessions).toHaveLength(0);
  });

  it("only persists the session cookie when the user asks to be remembered", async () => {
    const app = await verifiedUser();
    await app.json("/sign-out", { body: {} });

    const remembered = await app.call("/sign-in/email", {
      body: { email: "ada@example.com", password: "correct horse 9", rememberMe: true },
    });
    const rememberedCookie = remembered.headers.getSetCookie().find((value) => value.includes("session_token"));
    expect(rememberedCookie).toContain("Max-Age");

    await app.json("/sign-out", { body: {} });
    const forgotten = await app.call("/sign-in/email", {
      body: { email: "ada@example.com", password: "correct horse 9", rememberMe: false },
    });
    const forgottenCookie = forgotten.headers.getSetCookie().find((value) => value.includes("session_token"));
    expect(forgottenCookie).not.toContain("Max-Age");
  });

  it("marks the session cookie HttpOnly and SameSite=Lax", async () => {
    const app = await verifiedUser();
    await app.json("/sign-out", { body: {} });
    const response = await app.call("/sign-in/email", { body: { email: "ada@example.com", password: "correct horse 9" } });
    const cookie = response.headers.getSetCookie().find((value) => value.includes("session_token")) ?? "";

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("forgotten password", () => {
  async function oauthUser(providerId: "google" | "github", email: string) {
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser({ name: "Ada Lovelace", email, emailVerified: true });
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId,
      accountId: `${providerId}-1`,
      accessToken: "provider-token",
    });
    return user;
  }

  it("answers every address the same way, whatever the account behind it", async () => {
    const app = client();
    await signUp(app, "credential@example.com");
    await oauthUser("google", "google@example.com");
    await oauthUser("github", "github@example.com");
    sent = [];

    const replies = [];
    for (const email of [
      "credential@example.com",
      "google@example.com",
      "github@example.com",
      "nobody@example.com",
    ]) {
      replies.push(
        await app.json("/request-password-reset", {
          body: { email, redirectTo: `${config.APP_URL}/reset-password` },
        }),
      );
    }

    for (const reply of replies) {
      expect(reply.status).toBe(replies[0].status);
      expect(reply.body).toEqual(replies[0].body);
    }
  });

  it("emails a single-use reset link", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);
    sent = [];

    await app.json("/request-password-reset", {
      body: { email: "ada@example.com", redirectTo: `${config.APP_URL}/reset-password` },
    });
    const email = await waitForEmail(0);

    expect(email.subject).toBe("Reset your Aitar password");
    expect(email.text).toContain("/api/auth/reset-password/");
    expect(email.authorization).toBe(`Bearer ${config.RESEND_API_KEY}`);
  });

  it("hands the token to the app without exposing the address in the URL", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);
    sent = [];
    await app.json("/request-password-reset", {
      body: { email: "ada@example.com", redirectTo: `${config.APP_URL}/reset-password` },
    });

    const redirect = await app.call(authPath(linkIn(await waitForEmail(0))));
    const destination = new URL(redirect.headers.get("location") as string);

    expect(destination.pathname).toBe("/reset-password");
    expect(destination.searchParams.get("token")).toBeTruthy();
    expect(redirect.headers.get("location")).not.toContain("ada@example.com");
  });
});

describe("password reset", () => {
  async function resetToken(app: ReturnType<typeof client>, email: string) {
    sent = [];
    await app.json("/request-password-reset", {
      body: { email, redirectTo: `${config.APP_URL}/reset-password` },
    });
    return tokenIn(await waitForEmail(0));
  }

  it("sets a new password, ends other sessions, and refuses the token twice", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await app.call(authPath(linkIn(await waitForEmail(0))));
    expect(database.auth_sessions.length).toBeGreaterThan(0);

    const token = await resetToken(app, "ada@example.com");
    const reset = await app.json("/reset-password", { body: { newPassword: "a stronger secret", token } });

    expect(reset.status).toBe(200);
    expect(database.auth_sessions).toHaveLength(0);

    const reused = await app.json("/reset-password", { body: { newPassword: "another secret 12", token } });
    expect(reused.status).toBe(400);

    const signedIn = await app.json("/sign-in/email", { body: { email: "ada@example.com", password: "a stronger secret" } });
    expect(signedIn.status).toBe(200);
  });

  it("stores the new password only as a hash on the credential account", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);
    const token = await resetToken(app, "ada@example.com");
    await app.json("/reset-password", { body: { newPassword: "a stronger secret", token } });

    const credential = database.accounts.find((account) => account.providerId === "credential");
    expect(credential?.password).not.toContain("a stronger secret");
    expect(JSON.stringify(database)).not.toContain("a stronger secret");
  });

  it("rejects a missing, unknown, expired, or too-short reset", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);

    expect((await app.json("/reset-password", { body: { newPassword: "a stronger secret" } })).status).toBe(400);
    expect(
      (await app.json("/reset-password", { body: { newPassword: "a stronger secret", token: "nonsense" } })).status,
    ).toBe(400);

    const token = await resetToken(app, "ada@example.com");
    expect((await app.json("/reset-password", { body: { newPassword: "short", token } })).status).toBe(400);
  });

  it("expires a reset token that is past its lifetime", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await waitForEmail(0);
    const token = await resetToken(app, "ada@example.com");

    const stored = database.verifications.find((entry) => entry.identifier === `reset-password:${token}`);
    expect(stored).toBeTruthy();
    stored.expiresAt = new Date(Date.now() - 1000);

    expect(
      (await app.json("/reset-password", { body: { newPassword: "a stronger secret", token } })).status,
    ).toBe(400);
  });
});

describe("existing provider accounts", () => {
  async function oauthOnlyUser(providerId: "google" | "github", email: string) {
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser({ name: "Ada Lovelace", email, emailVerified: true });
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId,
      accountId: `${providerId}-1`,
      accessToken: "provider-token",
    });
    return user;
  }

  for (const provider of ["google", "github"] as const) {
    it(`lets an existing ${provider} user establish a password without a second account record`, async () => {
      const app = client();
      const existing = await oauthOnlyUser(provider, `${provider}@example.com`);

      await app.json("/request-password-reset", {
        body: { email: `${provider}@example.com`, redirectTo: `${config.APP_URL}/reset-password` },
      });
      const token = tokenIn(await waitForEmail(0));
      const reset = await app.json("/reset-password", { body: { newPassword: "a stronger secret", token } });

      expect(reset.status).toBe(200);
      expect(database.users).toHaveLength(1);
      expect(database.users[0].id).toBe(existing.id);

      const owned = database.accounts.filter((account) => account.userId === existing.id);
      expect(owned.map((account) => account.providerId).sort()).toEqual([provider, "credential"].sort());

      const signedIn = await app.json("/sign-in/email", {
        body: { email: `${provider}@example.com`, password: "a stronger secret" },
      });
      expect(signedIn.status).toBe(200);
      expect((signedIn.body?.user as { id: string }).id).toBe(existing.id);
    });
  }

  it("changes a password in place and revokes the other sessions", async () => {
    const app = client();
    const existing = await oauthOnlyUser("google", "google@example.com");
    await app.json("/request-password-reset", {
      body: { email: "google@example.com", redirectTo: `${config.APP_URL}/reset-password` },
    });
    await app.json("/reset-password", {
      body: { newPassword: "a stronger secret", token: tokenIn(await waitForEmail(0)) },
    });
    await app.json("/sign-in/email", { body: { email: "google@example.com", password: "a stronger secret" } });

    const other = client();
    await other.json("/sign-in/email", { body: { email: "google@example.com", password: "a stronger secret" } });
    expect(database.auth_sessions.length).toBe(2);

    const changed = await app.json("/change-password", {
      body: { currentPassword: "a stronger secret", newPassword: "yet another secret", revokeOtherSessions: true },
    });

    expect(changed.status).toBe(200);
    expect(database.auth_sessions).toHaveLength(1);
    expect(database.accounts.filter((account) => account.userId === existing.id)).toHaveLength(2);
    expect(JSON.stringify(database)).not.toContain("yet another secret");
  });

  it("refuses to change a password without a credential account", async () => {
    const app = client();
    await signUp(app, "ada@example.com");
    await app.call(authPath(linkIn(await waitForEmail(0))));

    // Leaves the signed-in session in place while the account becomes social only.
    database.accounts = database.accounts.filter((account) => account.providerId !== "credential");

    const changed = await app.json("/change-password", {
      body: { currentPassword: "correct horse 9", newPassword: "a stronger secret" },
    });

    expect(changed.status).toBe(400);
    expect(changed.body?.code).toBe("CREDENTIAL_ACCOUNT_NOT_FOUND");
  });
});

describe("rate limiting", () => {
  it("answers repeated sign-in attempts with 429 and a retry hint", async () => {
    auth = newAuth({ rateLimit: { ...baseAuthOptions.rateLimit, enabled: true } });
    const app = client();

    let last = await app.call("/sign-in/email", { body: { email: "ada@example.com", password: "whatever 123" } });
    for (let attempt = 0; attempt < 8 && last.status !== 429; attempt += 1) {
      last = await app.call("/sign-in/email", { body: { email: "ada@example.com", password: "whatever 123" } });
    }

    expect(last.status).toBe(429);
    expect(Number(last.headers.get("X-Retry-After"))).toBeGreaterThan(0);
  });

  it("throttles password reset requests", async () => {
    auth = newAuth({ rateLimit: { ...baseAuthOptions.rateLimit, enabled: true } });
    const app = client();

    let last = await app.call("/request-password-reset", {
      body: { email: "ada@example.com", redirectTo: `${config.APP_URL}/reset-password` },
    });
    for (let attempt = 0; attempt < 6 && last.status !== 429; attempt += 1) {
      last = await app.call("/request-password-reset", {
        body: { email: "ada@example.com", redirectTo: `${config.APP_URL}/reset-password` },
      });
    }

    expect(last.status).toBe(429);
  });
});
