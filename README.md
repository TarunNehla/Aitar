# Cloud Agents V0

Cloud Agents is a browser-based coding agent.

It keeps ongoing chats connected to repositories.

Each chat owns an independent Git branch, checkout, and sandbox environment.

Pi Agent Core runs the agent loop.

OpenRouter provides the language model.

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

5. Apply the database migration.

```sh
pnpm db:migrate
```

6. Start the application.

```sh
pnpm dev
```

Open `http://localhost:5173`.

## Logging

The backend writes structured operational logs to standard output.

Development uses readable Pino output when `LOG_PRETTY=true`.

Production uses JSON output when `LOG_PRETTY=false`.

Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error` to control verbosity.

Logs include request IDs, run IDs, chat IDs, repository IDs, tool names, timing, exit codes, token usage, and cost.

Logs do not include prompts, complete commands, file contents, command output, API keys, cookies, or database URLs.

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

V0 accepts public HTTPS GitHub repositories only.

Sandbox containers run without Linux capabilities or network access by default.

Network commands run in a separate temporary container after user approval.

Docker with a bind mount is a useful V0 boundary, but it is not a hostile multi-tenant security boundary.

Use gVisor or microVM isolation before allowing untrusted public users.
