import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../../config.js";
import { errorForLog, logger } from "../../logger.js";
import { containerName } from "../sandbox/sandbox.js";
import { AGENT_NETWORK_ALIAS } from "./browser-url.js";
import { runChecked, runProcess } from "../process.js";

const sidecarLogger = logger.child({ component: "browser-sidecar" });

export const BROWSER_CONTAINER_PREFIX = "cloud-agent-browser-";
export const BROWSER_NETWORK_PREFIX = "cloud-agent-net-";
const CONTROLLER_PORT = 4000;
const SIDECAR_ALIAS = "browser";
const READY_TIMEOUT_MS = 60_000;

export function browserContainerName(chatId: string): string {
  return `${BROWSER_CONTAINER_PREFIX}${chatId}`;
}

export function browserNetworkName(chatId: string): string {
  return `${BROWSER_NETWORK_PREFIX}${chatId}`;
}

export function seccompProfilePath(): string {
  return resolve("docker/browser/seccomp.json");
}

export interface SidecarHandle {
  chatId: string;
  container: string;
  network: string;
  endpoint: string;
  token: string;
}

export function browserIsolationArguments(): string[] {
  return [
    "--user", "10001:10001",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--security-opt", `seccomp=${seccompProfilePath()}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs", "/home/pw:rw,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
    "--shm-size", "128m",
    "--ipc", "private",
    "--init",
    "--memory", `${config.BROWSER_MEMORY_MB}m`,
    "--memory-swap", `${config.BROWSER_MEMORY_MB}m`,
    "--cpus", String(config.BROWSER_CPUS),
    "--pids-limit", String(config.BROWSER_PIDS_LIMIT),
  ];
}

function controllerEnvironment(token: string): Record<string, string> {
  return {
    BROWSER_CONTROLLER_TOKEN: token,
    BROWSER_MAX_TABS: String(config.BROWSER_MAX_TABS),
    BROWSER_ACTION_TIMEOUT_SECONDS: String(config.BROWSER_ACTION_TIMEOUT_SECONDS),
    BROWSER_NAVIGATION_TIMEOUT_SECONDS: String(config.BROWSER_NAVIGATION_TIMEOUT_SECONDS),
    BROWSER_SCREENSHOT_MAX_BYTES: String(config.BROWSER_SCREENSHOT_MAX_BYTES),
    BROWSER_HARD_IDLE_MINUTES: String(config.BROWSER_IDLE_MINUTES * 2),
  };
}

export class BrowserSidecar {
  private readonly starting = new Map<string, Promise<SidecarHandle>>();
  private readonly handles = new Map<string, SidecarHandle>();

  active(chatId: string): SidecarHandle | undefined {
    return this.handles.get(chatId);
  }

  activeCount(): number {
    return this.handles.size;
  }

  async ensure(chatId: string): Promise<SidecarHandle> {
    const running = this.handles.get(chatId);
    if (running) return running;

    const existing = this.starting.get(chatId);
    if (existing) return existing;

    const started = this.start(chatId)
      .then((handle) => {
        this.handles.set(chatId, handle);
        return handle;
      })
      .finally(() => {
        this.starting.delete(chatId);
      });

    this.starting.set(chatId, started);
    return started;
  }

  async remove(chatId: string): Promise<void> {
    this.handles.delete(chatId);
    await runProcess("docker", ["rm", "-f", browserContainerName(chatId)], { timeoutMs: 60_000 });
    await this.removeNetwork(browserNetworkName(chatId));
  }

  /** The chat container keeps running, so it has to leave the network before it can go. */
  private async removeNetwork(network: string): Promise<void> {
    const inspected = await runProcess(
      "docker",
      ["network", "inspect", "-f", "{{range .Containers}}{{.Name}}\n{{end}}", network],
      { timeoutMs: 30_000 },
    );
    if (inspected.exitCode === 0) {
      const attached = inspected.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const container of attached) {
        await runProcess("docker", ["network", "disconnect", "-f", network, container], { timeoutMs: 30_000 });
      }
    }
    await runProcess("docker", ["network", "rm", network], { timeoutMs: 30_000 });
  }

  /** Removes sidecars and chat networks a previous backend process left behind. */
  async sweepOrphans(): Promise<{ containers: number; networks: number }> {
    if (!config.BROWSER_ENABLED) return { containers: 0, networks: 0 };

    const listed = await runProcess(
      "docker",
      ["ps", "-a", "--filter", `name=^/${BROWSER_CONTAINER_PREFIX}`, "--format", "{{.Names}}"],
      { timeoutMs: 30_000 },
    );
    const containers = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const container of containers) {
      await runProcess("docker", ["rm", "-f", container], { timeoutMs: 60_000 });
    }

    const networks = await runProcess(
      "docker",
      ["network", "ls", "--filter", `name=^${BROWSER_NETWORK_PREFIX}`, "--format", "{{.Name}}"],
      { timeoutMs: 30_000 },
    );
    const names = networks.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const network of names) {
      await this.removeNetwork(network);
    }

    if (containers.length > 0 || names.length > 0) {
      sidecarLogger.info(
        { containers: containers.length, networks: names.length },
        "Removed orphaned browser sidecars",
      );
    }
    return { containers: containers.length, networks: names.length };
  }

  private async start(chatId: string): Promise<SidecarHandle> {
    await this.assertImagePresent();

    const network = browserNetworkName(chatId);
    const container = browserContainerName(chatId);
    const token = randomBytes(32).toString("hex");

    await this.ensureNetwork(network);
    await this.attachAgentContainer(network, chatId);

    await runProcess("docker", ["rm", "-f", container], { timeoutMs: 30_000 });

    const environmentFile = join(config.WORKSPACE_ROOT, "browser", `${chatId}.env`);
    await mkdir(join(config.WORKSPACE_ROOT, "browser"), { recursive: true });
    const variables = controllerEnvironment(token);
    await writeFile(
      environmentFile,
      Object.entries(variables).map(([key, value]) => `${key}=${value}`).join("\n"),
      { mode: 0o600 },
    );

    try {
      await runChecked(
        "docker",
        [
          "run", "-d",
          "--name", container,
          "--network", network,
          "--network-alias", SIDECAR_ALIAS,
          "--publish", `127.0.0.1::${CONTROLLER_PORT}`,
          "--env-file", environmentFile,
          "--restart", "no",
          ...browserIsolationArguments(),
          config.BROWSER_IMAGE,
        ],
        { timeoutMs: 120_000 },
      );
    } finally {
      await rm(environmentFile, { force: true });
    }

    const endpoint = await this.publishedEndpoint(container);
    const handle: SidecarHandle = { chatId, container, network, endpoint, token };
    await this.waitUntilReady(handle);
    sidecarLogger.info({ chatId, container, network }, "Browser sidecar started");
    return handle;
  }

  private async assertImagePresent(): Promise<void> {
    const inspected = await runProcess("docker", ["image", "inspect", config.BROWSER_IMAGE], { timeoutMs: 30_000 });
    if (inspected.exitCode === 0) return;
    throw new Error(
      `Browser image ${config.BROWSER_IMAGE} is not available. Build it once with scripts/build-browser-image.sh.`,
    );
  }

  private async ensureNetwork(network: string): Promise<void> {
    const inspected = await runProcess("docker", ["network", "inspect", network], { timeoutMs: 30_000 });
    if (inspected.exitCode === 0) return;
    const created = await runProcess("docker", ["network", "create", "--driver", "bridge", network], {
      timeoutMs: 60_000,
    });
    if (created.exitCode !== 0 && !created.stderr.includes("already exists")) {
      throw new Error(`Could not create the browser network: ${created.stderr.trim().slice(0, 200)}`);
    }
  }

  /**
   * The agent container keeps its original network, so the sidecar reaches the
   * dev server through an added alias rather than a republished port.
   */
  private async attachAgentContainer(network: string, chatId: string): Promise<void> {
    const connected = await runProcess(
      "docker",
      ["network", "connect", "--alias", AGENT_NETWORK_ALIAS, network, containerName(chatId)],
      { timeoutMs: 30_000 },
    );
    if (connected.exitCode === 0) return;
    if (connected.stderr.includes("already exists") || connected.stderr.includes("already connected")) return;
    throw new Error(`Could not attach the chat container to the browser network: ${connected.stderr.trim().slice(0, 200)}`);
  }

  private async publishedEndpoint(container: string): Promise<string> {
    const published = await runChecked("docker", ["port", container, String(CONTROLLER_PORT)], { timeoutMs: 30_000 });
    const line = published.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)[0] ?? "";
    const port = line.slice(line.lastIndexOf(":") + 1);
    if (!/^\d+$/.test(port)) throw new Error("The browser sidecar did not publish a controller port");
    return `http://127.0.0.1:${port}`;
  }

  private async waitUntilReady(handle: SidecarHandle): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = "the controller did not answer";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${handle.endpoint}/health`, {
          method: "POST",
          headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return;
        lastError = `the controller answered ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((settle) => setTimeout(settle, 250));
    }
    await this.remove(handle.chatId).catch(() => {});
    throw new Error(`The browser did not become ready: ${lastError}`);
  }
}

export const browserSidecar = new BrowserSidecar();

export async function removeBrowserEnvironment(chatId: string): Promise<void> {
  if (!config.BROWSER_ENABLED) return;
  try {
    await browserSidecar.remove(chatId);
  } catch (error) {
    sidecarLogger.warn({ error: errorForLog(error), chatId }, "Browser sidecar removal failed");
  }
}
