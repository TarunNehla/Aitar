interface WaitingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

class ApprovalBroker {
  private readonly waiting = new Map<string, WaitingApproval>();

  wait(id: string, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        const entry = this.waiting.get(id);
        if (entry) clearTimeout(entry.timer);
        this.waiting.delete(id);
        resolve(approved);
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      this.waiting.set(id, { resolve: finish, timer });
      signal?.addEventListener("abort", () => finish(false), { once: true });
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    entry.resolve(approved);
    return true;
  }

  has(id: string): boolean {
    return this.waiting.has(id);
  }
}

export const approvalBroker = new ApprovalBroker();
