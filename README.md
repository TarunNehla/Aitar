# Cloud Agents V0

Cloud Agents is a browser-based coding agent.

It keeps ongoing chats connected to repositories.

Each chat owns an independent Git branch, checkout, and sandbox environment.

Pi Agent Core runs the agent loop.

OpenRouter provides the language model.

OpenRouter requests prefer Baseten as the upstream inference provider.

Neon Postgres stores sessions, messages, runs, tools, events, approvals, and checkpoints.

Docker isolates repository commands.

## V0 features

- Persistent repositories and chat sessions.
- Branching message history through parent message IDs.
- Live assistant, tool, command, and file events through SSE.
- Pi tools for listing, reading, searching, writing, commands, and Git diffs.
- Docker CPU, memory, process, capability, network, and time limits.
- User approval for network access and broad commands.
- One internal Git branch and local clone per chat.
- Git checkpoint commits at the end of each run.
- Diffs generated from Git on demand instead of stored patch artifacts.
- Safe Postgres run claiming with `FOR UPDATE SKIP LOCKED`.
- Run cancellation, token totals, model cost, and worker leases.

## Requirements

- Node.js 22 or newer.
- pnpm.
- Docker.
- A Neon Postgres database.
- An OpenRouter API key.

## Setup

1. Copy `.env.example` to `.env`.

2. Add the Neon connection string.

3. Add the OpenRouter API key.

4. Install dependencies.

```sh
pnpm install
```

5. Add a Better Auth secret.

```sh
openssl rand -base64 32
```

Set the value as `BETTER_AUTH_SECRET`.

6. Add the Google and GitHub sign-in credentials described in [Authentication](#authentication).

7. Add the GitHub App credentials described in [GitHub App](#github-app) if you need private repositories.

8. Apply the database migration.

```sh
pnpm db:migrate
```

9. Start the application.

```sh
pnpm dev
```

Open `http://localhost:5173`.

## Model routing

`OPENROUTER_MODEL` picks the model. OpenRouter then picks one of its upstream inference providers for that model.

The provider table on an OpenRouter model page is informational. A provider is chosen only with the `provider` field on the request body, which the backend adds to every request.

| Variable | Meaning |
| --- | --- |
| `OPENROUTER_PROVIDERS` | Comma-separated provider slugs, most preferred first. Defaults to `baseten`. Empty accepts OpenRouter's own routing. |
| `OPENROUTER_ALLOW_FALLBACKS` | `true` treats that list as a preference order and permits other providers. `false` pins requests to it and fails when none can serve the model. Defaults to `true`, matching OpenRouter. |

The default prefers Baseten, so every request carries:

```json
{
  "model": "deepseek/deepseek-v4-flash-0731",
  "provider": { "order": ["baseten"], "allow_fallbacks": true },
  "messages": []
}
```

Set `OPENROUTER_ALLOW_FALLBACKS=false` to force Baseten and refuse every other provider:

```json
"provider": { "only": ["baseten"], "allow_fallbacks": false }
```

A pinned provider that does not serve the selected model fails the request instead of silently routing elsewhere. Check the model's provider list on OpenRouter before pinning, and use the Request Builder under Provider Preferences to try a combination first.

Each run logs the routing it used under `providerRouting`.

## Authentication

Better Auth owns sign-in, sessions, and account linking.

Users sign in with Google or GitHub. Both providers map to one internal user.

Sessions are stored in Neon in the `auth_sessions` table and carried in a secure, HttpOnly, SameSite=Lax cookie.

No authentication token is ever written to `localStorage` or `sessionStorage`.

Session cookie caching is disabled so revoking a session takes effect immediately.

Account linking is explicit. Signing in with a second provider does not merge accounts, even when the email address matches. An authenticated user connects the second provider from the account menu, and only when both providers report the same email address.

Provider tokens live only in the Better Auth `accounts` table and are encrypted with `account.encryptOAuthTokens`.

### Google configuration

Create an OAuth client in the Google Cloud console under APIs and services, Credentials, OAuth client ID, Web application.

Request identity scopes only. Cloud Agents never asks for Drive, Gmail, or any other Google API scope.

| Setting | Value |
| --- | --- |
| Authorised JavaScript origin | `http://localhost:5173` in development, `https://your-domain` in production |
| Authorised redirect URI | `http://localhost:5173/api/auth/callback/google` in development |
| Authorised redirect URI | `https://your-domain/api/auth/callback/google` in production |

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### GitHub sign-in configuration

GitHub sign-in is identity only. It never grants repository access.

Use the same GitHub App that provides repository access, and enable its user authorisation flow.

| Setting | Value |
| --- | --- |
| Callback URL | `http://localhost:5173/api/auth/callback/github` in development |
| Callback URL | `https://your-domain/api/auth/callback/github` in production |
| Account permission | Email addresses: Read-only |

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the app's OAuth credentials.

## GitHub App

Private repository access uses a GitHub App installation, never a user token.

Create the app under Settings, Developer settings, GitHub Apps.

| Setting | Value |
| --- | --- |
| Homepage URL | `https://your-domain` |
| Callback URL | `https://your-domain/api/auth/callback/github` |
| Setup URL | `https://your-domain/api/github/installations/callback` |
| Redirect on update | Enabled |
| Webhook URL | `https://your-domain/api/github/webhook` |
| Webhook secret | The value of `GITHUB_WEBHOOK_SECRET` |
| Repository permission | Contents: Read-only |
| Repository permission | Metadata: Read-only |
| Account permission | Email addresses: Read-only |
| Subscribed events | Installation, Installation repositories |

Cloud Agents requests read-only contents because it never pushes to a remote. Add write access only when remote pushing ships.

Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. The private key may be pasted with literal `\n` escapes.

### Connection flow

1. An authenticated user starts the connection from the repository dialog.
2. The backend issues a short-lived signed state bound to that user.
3. GitHub shows the installation page and the user picks repositories.
4. GitHub redirects to the setup URL, the backend validates the state, and stores the installation metadata.
5. The backend associates the installation with the user, so one installation can serve several users.
6. The user picks a repository, and the normal repository preparation and chat creation continue.

Webhook deliveries keep installation and repository availability current. Signatures are verified with `X-Hub-Signature-256` before the payload is read, and handling is idempotent.

### Installation tokens

The GitHub App ID and private key are the only stored GitHub credentials.

When Git needs a private repository, the backend confirms the user may use the installation, then mints an installation token scoped to that one repository with read-only contents.

The token is passed to the host-side Git child process through a fixed `GIT_ASKPASS` helper that reads it from the child environment. The helper lives in `WORKSPACE_ROOT/credentials`, outside every agent-writable checkout.

The token is never persisted, never placed in a remote URL or `.git/config`, never passed as a process argument, never given to a container, and never returned to the browser. `GIT_TERMINAL_PROMPT=0` keeps Git from prompting, and the credential material is cleared in a `finally` block.

## Ownership

Every repository has a required owner. Chats, runs, events, approvals, checkpoints, and artifacts inherit access through their repository.

Requests without a session get `401`. Requests for another user's data get `403`. Authorisation is enforced in the backend queries, not in the frontend.

Deleting a user cascades to their repositories and everything below them.

Validate the schema against a scratch schema at any time:

```sh
pnpm db:validate
```

## Logging

The backend writes structured operational logs to standard output.

Development uses readable Pino output when `LOG_PRETTY=true`.

Production uses JSON output when `LOG_PRETTY=false`.

Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error` to control verbosity.

Logs include request IDs, run IDs, chat IDs, repository IDs, tool names, timing, exit codes, token usage, and cost.

Logs do not include prompts, complete commands, file contents, command output, API keys, cookies, or database URLs.

Redaction also covers authorization headers, OAuth access and refresh tokens, GitHub installation and personal access tokens, private keys, client secrets, and credentials embedded in URLs.

## Production

Build and start the single Node.js service.

```sh
pnpm build
NODE_ENV=production pnpm start
```

Install Docker on the host.

Keep `WORKSPACE_ROOT` on a persistent disk.

Run one active agent at a time with `MAX_ACTIVE_RUNS=1` for the cheapest V0 deployment.

## Checkpoint design

Each chat uses a local branch named `agent/<chat-id>`.

The host keeps one protected bare mirror under `repos/<repository-id>.git`.

Each chat gets a separate local clone under `chats/<chat-id>/repository`.

At the end of a run, the worker stages every non-ignored change.

It creates an internal commit without running repository Git hooks.

It stores the commit SHA and base SHA in Neon.

It pushes the resulting commit into `refs/cloud-agents/chats/<chat-id>` in the mirror.

Neon stores only the base commit, checkpoint commit, and internal ref.

The UI requests a Git diff only when it needs to display code changes.

File-read contents, search results, and command streams are not stored in Neon.

Containers are disposable.

Chat checkouts can be restored from the protected repository mirror.

A complete host-disk loss is outside V0 recovery.

Object storage can back up Git bundles in a later version.

## Security boundaries

Cloud Agents accepts HTTPS GitHub repository URLs. Public repositories need no installation; private ones require the GitHub App.

Repository URLs containing embedded credentials are rejected.

Sandbox containers never receive session tokens, provider tokens, installation tokens, client secrets, the GitHub App private key, or the webhook secret.

Sandbox containers run without Linux capabilities or network access by default.

Network commands run in a separate temporary container after user approval.

Docker with a bind mount is a useful V0 boundary, but it is not a hostile multi-tenant security boundary.

Use gVisor or microVM isolation before allowing untrusted public users.
