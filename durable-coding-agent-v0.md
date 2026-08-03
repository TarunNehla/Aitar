# Durable Sandboxed Coding Agent Cloud — V0

## Main goal

A user gives a GitHub repository URL.

A user gives a task description.

The system runs one coding agent.

The agent edits the repository inside a sandbox.

The agent runs tests.

The user sees the logs and final Git diff.

---

## Agent loop decision

Use **Pi Agent Core** for V0.

Do not use the full Pi Coding Agent application.

Pi Agent Core gives us the basic tool-calling loop.

We still write our own tools.

We still write our own sandbox runner.

We still write our own permissions.

We still write our own persistence.

We still write our own user interface.

This keeps V0 small.

It also keeps the important project work under our control.

Pi Agent Core is written in TypeScript.

The V0 agent worker should therefore use TypeScript.

---

## Simple architecture

```text
Browser
  ↓
API server
  ↓
Task worker
  ↓
Pi agent loop
  ↓
Docker + gVisor sandbox
  ↓
Repository files
```

PostgreSQL stores tasks, messages, tool results, and logs.

---

## User story 1: Create a task

The user enters a repository URL.

The user enters a task description.

The user presses **Start**.

### We build

**UI:** A small task form.

**Logic:** Validate the repository URL.

**Infra:** Create a task row in PostgreSQL.

---

## User story 2: Prepare the repository

The worker receives the task.

The worker clones the repository.

The worker creates a separate workspace folder.

### We build

**Logic:** Git clone and workspace creation.

**Infra:** One workspace directory per task.

---

## User story 3: Start the sandbox

The worker starts one container.

The container uses the gVisor runtime.

The repository is mounted at `/workspace`.

The container gets CPU, memory, process, and time limits.

### We build

**Infra:** Docker and gVisor setup.

**Logic:** Sandbox create, execute, stop, and delete functions.

---

## User story 4: Set up the repository

The sandbox installs project dependencies.

The setup commands come from a project configuration file.

The agent does not guess setup commands in V0.

Example:

```yaml
setup:
  - npm install

test:
  - npm test
```

### We build

**Logic:** Read and run the configured setup commands.

**Sandbox:** Execute setup commands inside the container.

---

## User story 5: Let the agent work

The worker sends the task and repository context to the model.

The model requests tools.

The Pi loop executes the approved tools.

The tool result is sent back to the model.

This repeats until the task finishes or reaches a limit.

### V0 tools

- `list_files`
- `read_file`
- `search_files`
- `write_file`
- `run_command`
- `git_diff`
- `finish`

### We build

**Agent logic:** Configure Pi Agent Core.

**Tool logic:** Implement every tool ourselves.

**Security logic:** Reject invalid paths and blocked commands.

**Sandbox logic:** Run file and shell tools inside the container.

---

## User story 6: Save progress

Every model response is saved.

Every tool request is saved.

Every tool result is saved.

The current task status is saved.

### We build

**Infra:** PostgreSQL tables.

**Logic:** Save state after every agent turn.

**Recovery:** Restart from the saved message history after a worker crash.

---

## User story 7: Show live progress

The user sees the current task status.

The user sees model messages.

The user sees commands and test output.

### We build

**UI:** A simple task timeline.

**API:** An endpoint that returns new events.

**V0 choice:** Use polling every two seconds.

---

## User story 8: Show the result

The agent runs the configured tests.

The system collects the final Git diff.

The user sees whether the tests passed.

The user sees the changed files.

### We build

**Logic:** Run tests and collect their output.

**Logic:** Run `git diff` inside the sandbox.

**UI:** Show test results and the final patch.

---

## User story 9: Clean up

The sandbox stops when the task finishes.

The sandbox also stops after a timeout.

The workspace remains on disk for debugging.

### We build

**Logic:** Timeout and cleanup handling.

**Infra:** A scheduled cleanup job for old workspaces.

---

## V0 limits

Only one task runs at a time.

Only public GitHub repositories are supported.

Only one repository template is supported.

Only one model provider is supported.

The sandbox has no internet access after setup.

There is no GitHub App.

There is no pull-request creation.

There is no Kubernetes.

There is no Temporal.

There is no Firecracker.

There is no multi-user support.

---

## V0 stack

**Frontend:** React.

**API and worker:** TypeScript and Node.js.

**Agent loop:** Pi Agent Core.

**Database:** PostgreSQL.

**Sandbox:** Docker with gVisor.

**Model:** One hosted model API.

**Deployment:** Docker Compose.

---

## V0 completion checklist

- The user can submit a repository and task.
- The repository is cloned.
- The sandbox starts.
- Dependencies are installed.
- The agent can read and edit files.
- The agent can run commands and tests.
- Every turn is saved.
- Logs appear in the browser.
- The final Git diff appears in the browser.
- The sandbox is stopped and cleaned up.

---

## Pi references

- Pi monorepo: https://github.com/badlogic/pi-mono
- Pi agent loop: https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts
