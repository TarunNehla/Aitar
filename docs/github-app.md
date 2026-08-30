# GitHub App & repo access

How the backend earns the right to touch a repository. Human login is a **separate** system — see [`authentication.md`](authentication.md).

## This is not OAuth

| | OAuth (login with GitHub) | GitHub App installation |
|---|---|---|
| Question | who is this human? | which repos may this app touch? |
| Granted by | the user | the **account owner** (personal or org) |
| Acts as | the user | the app itself |
| Scope | whatever that user can see | exactly the repos ticked at install time |
| Stored | `accounts.accessToken` | **nowhere** — minted per operation |
| User leaves the org | token dies, automation breaks | installation belongs to the org, keeps working |

At install time the account owner picks **which repositories**, not which permissions. Permissions are fixed in the app's own settings and accepted wholesale.

## The three secrets

| | Proves | Lives | Lifetime |
|---|---|---|---|
| **Private key** (`.pem`) | I am this app | `GITHUB_APP_PRIVATE_KEY` in `.env` | until rotated |
| **App JWT** | I am app `<App ID>` | memory, regenerated | ~10 min |
| **Installation token** (`ghs_…`) | I may touch repo X | one child process's env | ~1 hour |
| **Webhook secret** | this payload really is from GitHub | `.env` + GitHub settings | until rotated |

Chain: **private key → App JWT → installation token → git.** Each step narrows what is possible. Only the last can read a line of code, for one repo, for an hour.

The `.pem` is downloaded once from GitHub and is never retrievable again. Paste its contents into `.env` (`config.ts:147` normalises the newlines) and delete the file. `*.pem` is gitignored.

## Install flow (once per account)

```
1.  POST /api/github/installations/start          (behind the auth gate)
2.  Backend builds a signed state:
      base64url({ userId, nonce, expiresAt })  +  "."  +  HMAC-SHA256(payload, BETTER_AUTH_SECRET)
    → { url: "https://github.com/apps/<slug>/installations/new?state=…" }
3.  User picks the account and repositories on GitHub.
4.  GET /api/github/installations/callback?installation_id=…&state=…
      - timingSafeEqual on the HMAC, then check expiresAt (TTL 600s)
      - GET /app/installations/{id} using the App JWT
      - upsert github_installations, insert github_installation_users
5.  Redirect home with ?github_installation=<id>
```

**Why `state` carries the userId:** GitHub's callback says *which installation* but never *which of our users*. There is no server-side row to look it up in, and the cookie may not survive the trip. So the userId rides inside the state and the HMAC makes it unforgeable. That is also why this route sits **above** the auth gate — the HMAC is the authentication.

### Tables

| Table | Means |
|---|---|
| `github_installations` | the installation: `installation_id`, account login/type, `repository_selection`, `status` |
| `github_installation_users` | many-to-many — which of our users may use this installation |
| `repositories.github_access` | per-repo `granted` / `revoked` |

`repositories.githubInstallationId` is the **uuid** FK. GitHub's numeric id lives on the installation row.

## Minting a token (every git operation)

```
①  Load the installation, run four checks     installationForRepository()
      1. row exists                                      else 409
      2. status === "active"                             else 409
      3. repository.githubAccess === "granted"           else 409
      4. user ∈ github_installation_users                else 409

②  Sign the App JWT       local, no network. RS256 over { iat, exp, iss: <App ID> }

③  POST /app/installations/{id}/access_tokens    with the App JWT
      { repository_ids: [<one repo>],
        permissions: <only what this operation needs> }

④  ghs_…  →  env var of a git child process

⑤  finally { blank it }
```

Checks 1–3 mirror GitHub's state. Check **4 is ours** — the only thing stopping a logged-in stranger from passing someone else's `installationId`.

If `githubInstallationId` is null the whole thing is skipped and git runs uncredentialed. That is the public-repo path.

Two entry points in `github/repository-access.ts`:

| Function | Permissions |
|---|---|
| `withRepositoryGitAccess` | `contents: read, metadata: read` |
| `withRepositoryPullRequestAccess` | `contents: write, pull_requests: write, metadata: read` |

A clone token physically cannot push. Nothing is reused — a clone and a PR 30 minutes later mint two different tokens with two different permission sets.

## Where the token lives: exactly two places

Both RAM. `grep -r ghs_ /` across the VM finds nothing.

```
Place 1   a JS variable in the Node process        gone when the function returns
Place 2   an env var on the git child process      gone when git exits (~30s)
```

`spawn()` copies place 1 into place 2. GitHub's 1-hour expiry is *its* clock — we stop holding the token after seconds.

**Not** in: `.env`, `.cloud-agent/`, `.git/config`, the clone URL, Postgres, logs, the container, shell history.

The handoff (`runtime/workspace/git-credentials.ts`):

```sh
GIT_ASKPASS=$WORKSPACE_ROOT/credentials/git-askpass.sh   # 4 fixed lines, mode 0700, NO token in it
GIT_CREDENTIAL_USERNAME=x-access-token
GIT_CREDENTIAL_TOKEN=ghs_…                               # env of that one child process
GIT_TERMINAL_PROMPT=0                                    # fail fast, never hang
GIT_CONFIG_NOSYSTEM=1
```

git asks the script for a password; the script echoes the env var. Caveat: env vars are not a vault — root or a same-user process can read `/proc/<pid>/environ`. It is far better than disk, not unbreakable.

## Webhooks (revocation)

`POST /api/github/webhook`, above the auth gate. `express.raw()` because the HMAC (`x-hub-signature-256`) must be verified against the **raw** body — re-serialized JSON would not hash the same.

| Event | Effect |
|---|---|
| `installation` / `deleted` | `status = 'deleted'` + revoke every repo of it |
| `installation` / `suspend` \| `unsuspend` | flip `status` |
| `installation_repositories` / `added` \| `removed` | flip `repositories.github_access` |

Nothing is ever deleted — strings flip. Re-installing flips them back and all chats, sessions and PRs survive.

If the webhook never fired (misconfigured URL, server down), the DB lies: check 3 passes, we mint, and **GitHub rejects it**. `app.ts` catches 403/404/410 and raises the same `GitHubInstallationUnavailableError` → 409. GitHub is the real backstop; the DB checks are the fast path.

Working code ≠ working webhook — GitHub also needs a reachable URL in the App settings. Verify under **App settings → Advanced → Recent Deliveries**.

## Deployment shape

One VM. Docker, Node, Postgres, git installed.

```
/opt/cloud-agents/                  the project code
  ├── .env                          GITHUB_APP_PRIVATE_KEY lives here (chmod 600, gitignored)
  └── .cloud-agent/                 $WORKSPACE_ROOT — disposable
        ├── repos/<repoId>.git      bare mirror, cloned once
        ├── chats/<chatId>/repository/     bind-mounted into the container as /workspace
        └── credentials/git-askpass.sh
/var/lib/postgresql/
/var/lib/docker/                    image layers + one dir per chat container
```

**Git runs on the host, never in the container.** Node clones, commits and pushes; the container edits the same folder through the bind mount (`sandbox.ts:242`), under a different name.

The container is handed a **folder, not a credential** — no token, no `.env`, no `.pem`. A fully rogue agent inside `/workspace` cannot reach GitHub: no key to sign a JWT, no token to authenticate, no git process of its own.
