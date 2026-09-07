import { config } from "../config.js";
import { logger } from "../logger.js";
import type { RepositoryRow } from "../db/store.js";
import { updateSessionEnvironment } from "../db/store.js";
import { withRepositoryGitAccess } from "../github/repository-access.js";
import { workspaceManager } from "./workspace/workspace-manager.js";
import { sandbox } from "./sandbox/sandbox.js";

const poolLogger = logger.child({ component: "container-pool" });

interface Slot {
  chatId: string;
  sessionId: string;
  repositoryId: string;
  lastActiveAt: number;
  runActive: boolean;
}

export class ContainerPool {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly maxSlots: number) {}

  get(chatId: string): Slot | undefined {
    return this.slots.get(chatId);
  }

  /**
   * Acquire a container slot for a chat. If the chat already holds a slot,
   * touches it and returns true. If the pool is full, evicts the least
   * recently active idle slot. Returns false only when every slot has an
   * active run.
   */
  acquire(chatId: string, sessionId: string, repositoryId: string): boolean {
    const existing = this.slots.get(chatId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return true;
    }

    if (this.slots.size < this.maxSlots) {
      this.slots.set(chatId, { chatId, sessionId, repositoryId, lastActiveAt: Date.now(), runActive: false });
      poolLogger.info({ chatId, slotsUsed: this.slots.size, maxSlots: this.maxSlots }, "Container slot acquired");
      return true;
    }

    const evicted = this.oldestIdle();
    if (!evicted) return false;

    poolLogger.info({ chatId: evicted.chatId, idleMs: Date.now() - evicted.lastActiveAt }, "Evicting idle slot for new chat");
    this.slots.delete(evicted.chatId);
    this.slots.set(chatId, { chatId, sessionId, repositoryId, lastActiveAt: Date.now(), runActive: false });
    return true;
  }

  release(chatId: string): void {
    if (this.slots.delete(chatId)) {
      poolLogger.info({ chatId, slotsUsed: this.slots.size }, "Container slot released");
    }
  }

  touch(chatId: string): void {
    const slot = this.slots.get(chatId);
    if (slot) slot.lastActiveAt = Date.now();
  }

  markRunActive(chatId: string): void {
    const slot = this.slots.get(chatId);
    if (slot) {
      slot.runActive = true;
      slot.lastActiveAt = Date.now();
    }
  }

  markRunIdle(chatId: string): void {
    const slot = this.slots.get(chatId);
    if (slot) {
      slot.runActive = false;
      slot.lastActiveAt = Date.now();
    }
  }

  reapIdle(maxIdleMs: number): Slot[] {
    const now = Date.now();
    const reaped: Slot[] = [];
    for (const slot of this.slots.values()) {
      if (!slot.runActive && now - slot.lastActiveAt > maxIdleMs) {
        reaped.push(slot);
      }
    }
    for (const slot of reaped) {
      this.slots.delete(slot.chatId);
    }
    return reaped;
  }

  get size(): number {
    return this.slots.size;
  }

  get available(): number {
    return this.maxSlots - this.slots.size;
  }

  private oldestIdle(): Slot | null {
    let oldest: Slot | null = null;
    for (const slot of this.slots.values()) {
      if (slot.runActive) continue;
      if (!oldest || slot.lastActiveAt < oldest.lastActiveAt) oldest = slot;
    }
    return oldest;
  }
}

export const containerPool = new ContainerPool(config.MAX_CONTAINER_SLOTS);

const warming = new Map<string, Promise<void>>();

export interface WarmSessionInput {
  chatId: string;
  sessionId: string;
  repository: RepositoryRow;
  baseBranch: string;
  baseCommit: string | null;
  headCommit: string | null;
}

export async function warmSession(input: WarmSessionInput): Promise<void> {
  const existing = warming.get(input.chatId);
  if (existing) return existing;

  const task = doWarm(input).finally(() => warming.delete(input.chatId));
  warming.set(input.chatId, task);
  return task;
}

async function doWarm(input: WarmSessionInput): Promise<void> {
  const startedAt = Date.now();
  poolLogger.info({ chatId: input.chatId, sessionId: input.sessionId }, "Warming session");

  await updateSessionEnvironment({ sessionId: input.sessionId, envStatus: "starting" });

  const checkout = await withRepositoryGitAccess(
    { repository: input.repository },
    (gitEnvironment) =>
      workspaceManager.ensureChatCheckout({
        chatId: input.chatId,
        repositoryId: input.repository.id,
        repositoryUrl: input.repository.repositoryUrl,
        baseBranch: input.baseBranch,
        baseCommit: input.baseCommit,
        headCommit: input.headCommit,
        gitEnvironment,
      }),
  );

  await sandbox.ensureContainer(input.chatId, checkout.repository);

  await updateSessionEnvironment({
    sessionId: input.sessionId,
    envStatus: "ready",
    baseCommit: checkout.baseCommit,
    headCommit: checkout.headCommit,
  });

  poolLogger.info(
    { chatId: input.chatId, sessionId: input.sessionId, durationMs: Date.now() - startedAt },
    "Session warmed",
  );
}
