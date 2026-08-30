# Authentication

How a human proves who they are. Repo access is a **separate** system — see [`github-app.md`](github-app.md).

## The split

| | This doc | `github-app.md` |
|---|---|---|
| Question | who is this human? | which repos may the app touch? |
| Mechanism | Better Auth + a cookie | GitHub App installation |
| Storage | `users`, `auth_sessions`, `accounts`, `verifications` | `github_installations`, `github_installation_users` |

"Sign in with GitHub" grants **zero** repo access. It is only a login button.

## Better Auth owns the endpoints

```
api.ts:188   app.all("/api/auth/*splat", toNodeHandler(auth))
```

One wildcard mount creates ~30 endpoints — `/sign-in/social`, `/sign-up/email`, `/callback/google`, `/reset-password`, `/get-session`. None of those handlers are ours. `auth/auth.ts` only configures them.

When sign-in breaks, the bug is in that config or in the provider's OAuth app settings. The only code we own on that path is the error-message mapping in `client/auth/auth-client.ts`.

## Tables

| Table | Holds |
|---|---|
| `users` | id, name, email, emailVerified |
| `auth_sessions` | `id` (PK) **and** `token` (the secret) — see below |
| `accounts` | one row per provider per user. Password hash lives here, not on `users`. OAuth tokens encrypted |
| `verifications` | email-verify + reset tokens, 1 hour TTL. Also holds OAuth `state` |

## The session cookie

```
Name:   better-auth.session_token            (dev)
        __Secure-better-auth.session_token   (prod)
Value:  <auth_sessions.token> . <HMAC signed with BETTER_AUTH_SECRET>
Flags:  HttpOnly, SameSite=Lax, Secure (prod only), Path=/
```

- The cookie carries **`token`**, not `id`. They are separate columns on purpose — an `id` leaking into a log is not a session hijack.
- The HMAC suffix is verified before any DB query, so forged cookies are rejected without a round trip.
- **HttpOnly means JS cannot read it.** No localStorage or sessionStorage is used anywhere in `src/client/`.
- `client/lib/api.ts` uses bare `fetch()` — default `credentials: "same-origin"` attaches the cookie automatically. The frontend never handles the token.

### Expiry is a rolling window

```
auth.ts:17   expiresIn 7 days
auth.ts:18   updateAge 1 day     → refreshed on any request once the session is >1 day old
```

An active user is never logged out. 8 days idle = expired.

`cookieCache` is **disabled** (`auth.ts:124`), so every `/api/*` request does a `SELECT` on `auth_sessions`. Slower, but deleting the row logs someone out instantly.

## The auth gate

```
api.ts:263   app.use("/api", requireAuthentication)
```

Everything **below** that line needs a session and gets `request.authUser`.
Everything **above** it is public by design:

| Public route | Authenticated by |
|---|---|
| `/api/health`, `/api/auth-methods` | nothing |
| `/api/auth/*` | Better Auth internally |
| `/api/github/webhook` | HMAC over the raw body |
| `/api/github/installations/callback` | HMAC inside the `state` param |

## OAuth (Google / GitHub sign-in)

RFC 6749 Authorization Code flow. Identical shape for every provider.

```
1.  Frontend  ──▶ POST /api/auth/sign-in/social       (our backend, NOT the provider)
2.  Backend   ──▶ 200 { url: "https://accounts.google.com/…" }
                  JSON, not a 302 — lets the client show an error instead of bouncing
3.  Client JS ──▶ window.location.href = url
4.  User authenticates on the provider's domain. We never see the password.
5.  Provider  ──▶ 302 to /api/auth/callback/google?code=…&state=…
                  A real redirect — the provider cannot run our JavaScript.
6.  Backend   ──▶ POST provider's token endpoint, with code + CLIENT_SECRET
                  Server-to-server. The browser is not involved. This is the load-bearing step.
7.  Provider  ──▶ { id_token } → decodes to { sub, email, name }
8.  Backend writes users + accounts + auth_sessions, Set-Cookie, 302 to "/"
9.  Frontend mounts, useSession() runs, discovers it is logged in.
```

Two consecutive redirects at the end, easily collapsed into one by mistake:

```
① accounts.google.com/…                       user picks account
② our-domain/api/auth/callback/google?code=…  backend path. Blank flash, no render.
③ our-domain/                                 React mounts here for the first time
```

The `code` must reach a process holding `CLIENT_SECRET`. That is why step ② exists — if the provider redirected straight to `/`, the code would land in React, which has no secret.

Notes:
- Store the provider's **`sub`** as `accounts.accountId`, not the email. Emails change; `sub` does not.
- Google/Microsoft are OIDC and return an `id_token`. Plain GitHub OAuth does not — Better Auth makes one extra `GET api.github.com/user` call.
- The backend never tells the frontend "you are logged in". It sets a cookie and redirects; the frontend *discovers* it via `useSession()`. A failure is the same mechanism with `?error=…` instead of a cookie.

## One origin, two behaviors

The callback URL sits on our domain but is a **backend path**. React is never involved.

| Path | Answered by |
|---|---|
| `/api/*` | Express route handlers |
| everything else | `index.html` → React |

There is no `if (path.startsWith("/api"))` anywhere. The logic **is registration order**:

```js
index.ts:15   const app = createApi()                  // claims /api/* first
index.ts:20   app.use(express.static(clientDirectory))
index.ts:21   app.get("*splat", … sendFile("index.html"))   // claims the rest
```

In dev the same split is enforced by Vite instead — `vite.config.ts` proxies `/api/` → `localhost:3000`.

Because it is one origin either way, `SameSite=Lax` and `credentials: "same-origin"` both just work. Splitting the frontend and API onto different domains would break the cookie, `TRUSTED_ORIGINS` (`config.ts:153` allows a single origin in prod), the bare `fetch()` calls, and would require CORS.
