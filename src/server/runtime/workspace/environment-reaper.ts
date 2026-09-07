import { config } from "../../config.js";
import { getSession, updateSessionEnvironment } from "../../db/store.js";
import { errorForLog, logger } from "../../logger.js";
import { containerPool } from "../container-pool.js";
import { workspaceManager } from "./workspace-manager.js";

const reaperLogger = logger.child({ component: "environment-reaper" });

class EnvironmentReaper {
  private timer?: NodeJS.Timeout;

  start(): void {
    this.timer = setInterval(() => void this.tick(), config.EVICTION_INTERVAL_SECONDS * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const maxIdleMs = config.CHAT_IDLE_MINUTES * 60_000;
    const evicted = containerPool.reapIdle(maxIdleMs);

    for (const slot of evicted) {
      try {
        const relation = await getSession(slot.sessionId);
        const headCommit = relation?.session.headCommit;
        if (!headCommit) {
          reaperLogger.info({ chatId: slot.chatId }, "Skipping eviction — no head commit");
          continue;
        }

        await workspaceManager.evictChat({
          chatId: slot.chatId,
          repositoryId: slot.repositoryId,
          expectedHeadCommit: headCommit,
        });
        await updateSessionEnvironment({ sessionId: slot.sessionId, envStatus: "evicted" });
        reaperLogger.info({ chatId: slot.chatId, repositoryId: slot.repositoryId }, "Idle chat environment evicted");
      } catch (error) {
        reaperLogger.warn({ error: errorForLog(error), chatId: slot.chatId }, "Chat environment eviction failed");
      }
    }
  }
}

export const environmentReaper = new EnvironmentReaper();
