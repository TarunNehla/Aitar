import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Exercises the real Docker path end to end. Off by default because it builds
 * containers: run with BROWSER_DOCKER_TESTS=1 after scripts/build-browser-image.sh.
 */
const enabled = process.env.BROWSER_DOCKER_TESTS === "1";

const config = {
  BROWSER_ENABLED: true,
  BROWSER_IMAGE: process.env.BROWSER_IMAGE ?? "aitar-browser:chromium",
  BROWSER_MEMORY_MB: 1024,
  BROWSER_CPUS: 0.5,
  BROWSER_PIDS_LIMIT: 256,
  BROWSER_IDLE_MINUTES: 10,
  BROWSER_MAX_TABS: 2,
  BROWSER_ACTION_TIMEOUT_SECONDS: 30,
  BROWSER_NAVIGATION_TIMEOUT_SECONDS: 60,
  BROWSER_SCREENSHOT_MAX_BYTES: 10_485_760,
  SANDBOX_IMAGE: process.env.SANDBOX_IMAGE ?? "node:22-bookworm-slim",
  SANDBOX_MEMORY_MB: 1024,
  SANDBOX_CPUS: 1,
  SANDBOX_PIDS_LIMIT: 512,
  SANDBOX_DISK_GB: 10,
  WORKSPACE_ROOT: "",
  LOG_LEVEL: "silent",
  LOG_PRETTY: false,
  NODE_ENV: "test",
};

const savedArtifacts: Array<Record<string, unknown>> = [];
vi.mock("../config.js", () => ({ config }));
vi.mock("../db/store.js", () => ({
  saveArtifact: async (input: Record<string, unknown>) => {
    savedArtifacts.push(input);
    return { id: input.id };
  },
}));

const { runProcess } = await import("./process.js");
const { sandbox, containerName } = await import("./sandbox.js");
const { browserSessions } = await import("./browser-session.js");
const { browserSidecar, browserContainerName, browserNetworkName } = await import("./browser-sidecar.js");

const CHAT_A = "docker-chat-a";
const CHAT_B = "docker-chat-b";

function appSource(marker: string): string {
  return `const http = require("http");
const page = \`<!doctype html><html><head><title>${marker} app</title></head><body>
<h1>${marker}</h1>
<label for="email">Email address</label>
<input id="email" name="email" placeholder="Email address">
<button id="go">Sign in</button>
<p id="out"></p>
<script>
document.getElementById("go").addEventListener("click", () => {
  document.getElementById("out").textContent = "signed in";
});
console.error("boom: ${marker} console error");
</script>
</body></html>\`;
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(page);
}).listen(3000, "0.0.0.0");
`;
}

async function containerExists(name: string): Promise<boolean> {
  const listed = await runProcess("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], {
    timeoutMs: 30_000,
  });
  return listed.stdout.trim() === name;
}

async function networkExists(name: string): Promise<boolean> {
  const listed = await runProcess("docker", ["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"], {
    timeoutMs: 30_000,
  });
  return listed.stdout.trim() === name;
}

async function startApp(chatId: string, repositoryPath: string, marker: string): Promise<void> {
  await writeFile(join(repositoryPath, "server.js"), appSource(marker));
  await sandbox.ensureContainer(chatId, repositoryPath);
  await sandbox.detach(chatId, repositoryPath, "node /workspace/server.js >/tmp/app.log 2>&1 &");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await sandbox.script(chatId, repositoryPath, "node -e \"require('http').get('http://127.0.0.1:3000', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))\"");
    if (probe.exitCode === 0) return;
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error(`The test application in ${chatId} never became ready`);
}

describe.skipIf(!enabled)("browser sidecar over Docker", () => {
  let workspaceRoot = "";
  let repositoryA = "";
  let repositoryB = "";

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cloud-agents-browser-"));
    config.WORKSPACE_ROOT = workspaceRoot;
    repositoryA = join(workspaceRoot, "chat-a");
    repositoryB = join(workspaceRoot, "chat-b");
    await runProcess("mkdir", ["-p", repositoryA, repositoryB], { timeoutMs: 10_000 });
    await startApp(CHAT_A, repositoryA, "alpha");
  }, 600_000);

  afterAll(async () => {
    for (const chatId of [CHAT_A, CHAT_B]) {
      await browserSessions.close(chatId).catch(() => {});
      await runProcess("docker", ["rm", "-f", containerName(chatId)], { timeoutMs: 60_000 });
      await runProcess("docker", ["network", "rm", browserNetworkName(chatId)], { timeoutMs: 30_000 });
    }
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 300_000);

  it("runs the application without ever starting a browser container", async () => {
    expect(await containerExists(containerName(CHAT_A))).toBe(true);
    expect(await containerExists(browserContainerName(CHAT_A))).toBe(false);
    expect(await networkExists(browserNetworkName(CHAT_A))).toBe(false);
  });

  it("starts the sidecar only on the first browser tool call and reaches the app by alias", async () => {
    const outcome = await browserSessions.navigate({
      chatId: CHAT_A,
      repositoryPath: repositoryA,
      url: "http://localhost:3000/",
    });

    expect(outcome.status).toBe(200);
    expect(outcome.title).toBe("alpha app");
    expect(outcome.url).toContain("localhost:3000");
    expect(outcome.url).not.toContain("workspace");

    expect(await containerExists(browserContainerName(CHAT_A))).toBe(true);
    expect(await networkExists(browserNetworkName(CHAT_A))).toBe(true);
  }, 300_000);

  it("reads the page structure with stable references", async () => {
    const snapshot = await browserSessions.snapshot({ chatId: CHAT_A, repositoryPath: repositoryA });
    const refs = snapshot.elements.map((element: any) => element.ref);

    expect(refs).toContain("input-1");
    expect(refs).toContain("button-1");
    expect(snapshot.elements.find((element: any) => element.ref === "button-1").name).toBe("Sign in");
    expect(snapshot.elements.find((element: any) => element.ref === "input-1").name).toBe("Email address");
    expect(snapshot.url).toContain("localhost:3000");
    expect(snapshot.url).not.toContain("workspace");
  }, 120_000);

  it("types into a field and clicks a button", async () => {
    const typed = await browserSessions.act({
      chatId: CHAT_A,
      repositoryPath: repositoryA,
      action: "type",
      body: { ref: "input-1", text: "ada@example.com", clear: true },
    });
    expect(typed.element.name).toBe("Email address");

    const clicked = await browserSessions.act({
      chatId: CHAT_A,
      repositoryPath: repositoryA,
      action: "click",
      body: { ref: "button-1" },
    });
    expect(clicked.element.name).toBe("Sign in");
  }, 120_000);

  it("captures a screenshot as an artifact on disk rather than in the database", async () => {
    const capture = await browserSessions.screenshot({
      chatId: CHAT_A,
      repositoryPath: repositoryA,
      runId: "run-1",
      callId: "call-1",
    });

    expect(capture.bytes).toBeGreaterThan(0);
    expect(capture.width).toBeGreaterThan(0);
    expect(capture.height).toBeGreaterThan(0);

    const artifact = savedArtifacts.at(-1) as any;
    expect(artifact.mimeType).toBe("image/png");
    expect(artifact.storagePath).toContain(workspaceRoot);
    expect(artifact.storagePath).not.toContain(repositoryA);
    expect(JSON.stringify(artifact)).not.toContain(capture.base64);
  }, 120_000);

  it("reports the console error the page produced", async () => {
    const messages = await browserSessions.consoleMessages({
      chatId: CHAT_A,
      repositoryPath: repositoryA,
      level: "error",
    });
    expect(messages.messages.some((message: any) => message.text.includes("boom: alpha"))).toBe(true);
  }, 120_000);

  it("keeps one chat out of another chat's application and controller", async () => {
    await startApp(CHAT_B, repositoryB, "beta");
    await browserSessions.navigate({ chatId: CHAT_B, repositoryPath: repositoryB, url: "http://localhost:3000/" });

    const first = browserSidecar.active(CHAT_A);
    const second = browserSidecar.active(CHAT_B);
    if (!first || !second) throw new Error("Both sidecars should be running");

    const beta = await browserSessions.snapshot({ chatId: CHAT_B, repositoryPath: repositoryB });
    expect(beta.title).toBe("beta app");

    const alpha = await browserSessions.snapshot({ chatId: CHAT_A, repositoryPath: repositoryA });
    expect(alpha.title).toBe("alpha app");

    const crossToken = await fetch(`${first.endpoint}/snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${second.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(crossToken.status).toBe(401);

    const noToken = await fetch(`${first.endpoint}/snapshot`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
  }, 600_000);

  it("removes the sidecar and its private network on close", async () => {
    expect(await browserSessions.close(CHAT_A)).toBe(true);

    expect(await containerExists(browserContainerName(CHAT_A))).toBe(false);
    expect(await networkExists(browserNetworkName(CHAT_A))).toBe(false);
    expect(await containerExists(containerName(CHAT_A))).toBe(true);
  }, 120_000);

  it("sweeps sidecars a previous backend process left behind", async () => {
    await browserSessions.navigate({ chatId: CHAT_A, repositoryPath: repositoryA, url: "http://localhost:3000/" });
    expect(await containerExists(browserContainerName(CHAT_A))).toBe(true);

    await browserSidecar.sweepOrphans();

    expect(await containerExists(browserContainerName(CHAT_A))).toBe(false);
    expect(await containerExists(browserContainerName(CHAT_B))).toBe(false);
    expect(await networkExists(browserNetworkName(CHAT_A))).toBe(false);
  }, 300_000);
});
