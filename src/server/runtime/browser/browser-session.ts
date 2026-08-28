import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.js";
import { saveArtifact } from "../../db/store.js";
import { errorForLog, logger } from "../../logger.js";
import { AGENT_NETWORK_ALIAS, displayUrlFor, prepareNavigation } from "./browser-url.js";
import { browserSidecar, removeBrowserEnvironment, type SidecarHandle } from "./browser-sidecar.js";
import { sandbox } from "../sandbox/sandbox.js";

const sessionLogger = logger.child({ component: "browser-session" });

export class BrowserDisabledError extends Error {
  constructor() {
    super("Browser tools are turned off for this deployment.");
  }
}

export interface ConsoleMessage {
  sequence: number;
  level: "info" | "warning" | "error";
  text: string;
}

export interface ScreenshotCapture {
  artifactId: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  base64: string;
  truncated: boolean;
  durationMs: number;
}

export function browserArtifactDirectory(chatId: string): string {
  return join(config.WORKSPACE_ROOT, "artifacts", chatId);
}

interface Activity {
  lastActivityAt: number;
}

export class BrowserSessions {
  private readonly activity = new Map<string, Activity>();
  private timer?: NodeJS.Timeout;

  startIdleReaper(): void {
    if (!config.BROWSER_ENABLED || this.timer) return;
    this.timer = setInterval(() => void this.reapIdle(), 60_000);
    this.timer.unref();
  }

  stopIdleReaper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reapIdle(): Promise<string[]> {
    const cutoff = Date.now() - config.BROWSER_IDLE_MINUTES * 60_000;
    const expired = [...this.activity.entries()]
      .filter(([, entry]) => entry.lastActivityAt <= cutoff)
      .map(([chatId]) => chatId);

    for (const chatId of expired) {
      try {
        await this.close(chatId);
        sessionLogger.info({ chatId }, "Idle browser sidecar removed");
      } catch (error) {
        sessionLogger.warn({ error: errorForLog(error), chatId }, "Idle browser sidecar removal failed");
      }
    }
    return expired;
  }

  private async ensure(chatId: string, repositoryPath: string): Promise<SidecarHandle> {
    if (!config.BROWSER_ENABLED) throw new BrowserDisabledError();
    await sandbox.ensureContainer(chatId, repositoryPath);
    const handle = await browserSidecar.ensure(chatId);
    this.activity.set(chatId, { lastActivityAt: Date.now() });
    await this.call(handle, "/session", { appAlias: AGENT_NETWORK_ALIAS });
    return handle;
  }

  private async call(
    handle: SidecarHandle,
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const timeoutMs = (config.BROWSER_NAVIGATION_TIMEOUT_SECONDS + config.BROWSER_ACTION_TIMEOUT_SECONDS) * 1_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${handle.endpoint}${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error("Browser action cancelled");
      throw new Error(`The browser did not respond: ${error instanceof Error ? error.message : String(error)}`);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message ?? `Browser action failed with status ${response.status}`;
      throw new Error(String(message));
    }
    this.activity.set(handle.chatId, { lastActivityAt: Date.now() });
    return payload;
  }

  async navigate(input: {
    chatId: string;
    repositoryPath: string;
    url: unknown;
    waitUntil?: string;
    timeout?: number;
    signal?: AbortSignal;
  }) {
    const handle = await this.ensure(input.chatId, input.repositoryPath);
    const prepared = prepareNavigation(input.url);
    const result = await this.call(
      handle,
      "/navigate",
      {
        url: prepared.requestUrl,
        waitUntil: input.waitUntil,
        timeout: input.timeout === undefined ? undefined : input.timeout * 1_000,
      },
      input.signal,
    );
    return {
      ...result,
      url: displayUrlFor(result.url, prepared.displayUrl),
      requestedUrl: prepared.displayUrl,
      translated: prepared.translated,
    };
  }

  async snapshot(input: { chatId: string; repositoryPath: string; signal?: AbortSignal }) {
    const handle = await this.ensure(input.chatId, input.repositoryPath);
    const result = await this.call(handle, "/snapshot", {}, input.signal);
    return { ...result, url: displayUrlFor(result.url, String(result.url ?? "")) };
  }

  async act(input: {
    chatId: string;
    repositoryPath: string;
    action: "click" | "type" | "select" | "press" | "scroll" | "wait";
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }) {
    const handle = await this.ensure(input.chatId, input.repositoryPath);
    const result = await this.call(handle, `/${input.action}`, input.body, input.signal);
    if (typeof result.url === "string") result.url = displayUrlFor(result.url, result.url);
    return result;
  }

  async screenshot(input: {
    chatId: string;
    repositoryPath: string;
    runId: string;
    callId: string;
    fullPage?: boolean;
    signal?: AbortSignal;
  }): Promise<ScreenshotCapture> {
    const handle = await this.ensure(input.chatId, input.repositoryPath);
    const result = await this.call(handle, "/screenshot", { fullPage: Boolean(input.fullPage) }, input.signal);

    const buffer = Buffer.from(String(result.data), "base64");
    if (buffer.byteLength > config.BROWSER_SCREENSHOT_MAX_BYTES) {
      throw new Error(`The screenshot is larger than the ${config.BROWSER_SCREENSHOT_MAX_BYTES} byte limit.`);
    }

    const artifactId = randomUUID();
    const directory = browserArtifactDirectory(input.chatId);
    const storagePath = join(directory, `${artifactId}.png`);
    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, buffer, { mode: 0o600 });

    const pageUrl = displayUrlFor(result.url, String(result.url ?? ""));
    await saveArtifact({
      id: artifactId,
      sessionId: input.chatId,
      runId: input.runId,
      name: `screenshot-${input.callId}.png`,
      type: "browser_screenshot",
      mimeType: "image/png",
      storagePath,
      size: buffer.byteLength,
      metadata: {
        callId: input.callId,
        url: pageUrl,
        width: Number(result.width) || 0,
        height: Number(result.height) || 0,
        fullPage: Boolean(input.fullPage),
        truncated: Boolean(result.truncated),
      },
    });

    return {
      artifactId,
      url: pageUrl,
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      bytes: buffer.byteLength,
      base64: String(result.data),
      truncated: Boolean(result.truncated),
      durationMs: Number(result.durationMs) || 0,
    };
  }

  async consoleMessages(input: {
    chatId: string;
    repositoryPath: string;
    cursor?: string;
    level?: string;
    limit?: number;
    signal?: AbortSignal;
  }) {
    const handle = await this.ensure(input.chatId, input.repositoryPath);
    return this.call(
      handle,
      "/console",
      { cursor: input.cursor, level: input.level, limit: input.limit },
      input.signal,
    );
  }

  async close(chatId: string): Promise<boolean> {
    const handle = browserSidecar.active(chatId);
    this.activity.delete(chatId);
    if (handle) {
      await this.call(handle, "/close", {}).catch(() => {});
    }
    await removeBrowserEnvironment(chatId);
    return Boolean(handle);
  }

  /** Screenshots outlive the sidecar, so they are only removed with the chat itself. */
  async removeArtifacts(chatId: string): Promise<void> {
    await rm(browserArtifactDirectory(chatId), { recursive: true, force: true });
  }
}

export const browserSessions = new BrowserSessions();
