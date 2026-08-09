import { appendEvent } from "../db/store.js";
import { eventHub } from "../events/event-hub.js";

let transientSequence = 0;

/** Live-only delivery: nothing here is replayable, so nothing here reaches Postgres. */
export function publishTransient(
  sessionId: string,
  runId: string | null,
  type: string,
  payload: Record<string, unknown> = {},
): void {
  eventHub.publish({
    id: `live-${Date.now()}-${transientSequence++}`,
    sessionId,
    runId,
    sequence: 0,
    type,
    payload,
    createdAt: new Date().toISOString(),
    transient: true,
  });
}

export class EventWriter {
  private queue = Promise.resolve();
  private pendingDelta: { type: string; key: string; value: string; payload: Record<string, unknown> } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
  ) {}

  emit(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    this.flushDelta();
    this.queue = this.queue.then(async () => {
      await appendEvent({ sessionId: this.sessionId, runId: this.runId, type, payload });
    });
    return this.queue;
  }

  live(type: string, payload: Record<string, unknown> = {}): void {
    publishTransient(this.sessionId, this.runId, type, payload);
  }

  delta(type: string, key: string, value: string, payload: Record<string, unknown> = {}): void {
    if (
      this.pendingDelta &&
      (this.pendingDelta.type !== type ||
        this.pendingDelta.key !== key ||
        JSON.stringify(this.pendingDelta.payload) !== JSON.stringify(payload))
    ) {
      this.flushDelta();
    }

    if (!this.pendingDelta) {
      this.pendingDelta = { type, key, value: "", payload };
    }
    this.pendingDelta.value += value;

    if (this.pendingDelta.value.length >= 2_048) {
      this.flushDelta();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flushDelta(), 200);
      this.timer.unref();
    }
  }

  liveDelta(type: string, key: string, value: string, payload: Record<string, unknown> = {}): void {
    this.live(type, { ...payload, [key]: value });
  }

  private flushDelta(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pendingDelta;
    this.pendingDelta = null;
    if (!pending || !pending.value) return;

    this.queue = this.queue.then(async () => {
      await appendEvent({
        sessionId: this.sessionId,
        runId: this.runId,
        type: pending.type,
        payload: { ...pending.payload, [pending.key]: pending.value },
      });
    });
  }

  async drain(): Promise<void> {
    this.flushDelta();
    await this.queue;
  }
}
