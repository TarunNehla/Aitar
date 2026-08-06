import { config } from "../config.js";
import { claimIdleSessionForEviction, updateSessionEnvironment } from "../db/store.js";
import { errorForLog, logger } from "../logger.js";
import { workspaceManager } from "./workspace-manager.js";

class EnvironmentReaper {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = logger.child({ component: "environment-reaper" });

  start(): void {
    this.timer = setInterval(() => void this.tick(), config.EVICTION_INTERVAL_SECONDS * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let claimed: Awaited<ReturnType<typeof claimIdleSessionForEviction>> | undefined;
    try {
      const idleBefore = new Date(Date.now() - config.CHAT_IDLE_MINUTES * 60_000);
      claimed = await claimIdleSessionForEviction(idleBefore);
      if (!claimed) return;
      await workspaceManager.evictChat({
        chatId: claimed.id,
        repositoryId: claimed.repository_id,
        expectedHeadCommit: claimed.head_commit,
      });
      await updateSessionEnvironment({ sessionId: claimed.id, envStatus: "evicted" });
      this.log.info({ chatId: claimed.id, repositoryId: claimed.repository_id }, "Idle chat environment evicted");
    } catch (error) {
      if (claimed) await updateSessionEnvironment({ sessionId: claimed.id, envStatus: "ready" });
      this.log.warn({ error: errorForLog(error), chatId: claimed?.id }, "Chat environment eviction failed");
    } finally {
      this.running = false;
    }
  }
}

export const environmentReaper = new EnvironmentReaper();
