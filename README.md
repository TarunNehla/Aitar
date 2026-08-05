# Cloud Agents V0

Cloud Agents is a browser-based coding agent.

It keeps an ongoing chat connected to a persistent repository workspace.

Pi Agent Core runs the agent loop.

OpenRouter provides the language model.

Neon Postgres stores sessions, messages, runs, tools, events, approvals, and checkpoints.

Docker isolates repository commands.

## V0 features

- Persistent projects, workspaces, and chat sessions.
- Branching message history through parent message IDs.
- Live assistant, tool, command, and file events through SSE.
- Pi tools for listing, reading, searching, writing, commands, and Git diffs.
- Docker CPU, memory, process, capability, network, and time limits.
- User approval for network access and broad commands.
- Internal Git checkpoint commits after file-changing tools.
- Git patch artifacts at the end of every run.
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

Logs include request IDs, run IDs, workspace IDs, tool names, timing, exit codes, token usage, and cost.

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

Each workspace uses a local branch named `cloud-agent/<workspace-id>`.

After a file-changing tool, the worker stages every change.

It creates an internal commit without running repository Git hooks.

It stores the commit SHA and base SHA in Neon.

It writes a binary Git patch into the workspace artifact directory.

The internal branch is never pushed to GitHub.

Process and container crashes recover from the persistent workspace and Neon records.

A complete host-disk loss is outside V0 recovery.

Object storage can protect checkpoint patches in the next version.

## Security boundaries

V0 accepts public HTTPS GitHub repositories only.

Sandbox containers run without Linux capabilities or network access by default.

Network commands run in a separate temporary container after user approval.

Docker with a bind mount is a useful V0 boundary, but it is not a hostile multi-tenant security boundary.

Use gVisor or microVM isolation before allowing untrusted public users.
