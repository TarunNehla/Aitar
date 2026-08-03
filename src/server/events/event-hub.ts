import type { SessionEvent } from "../../shared/contracts.js";

type Listener = (event: SessionEvent) => void;

class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    const sessionListeners = this.listeners.get(sessionId) ?? new Set<Listener>();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);

    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  publish(event: SessionEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
  }
}

export const eventHub = new EventHub();
