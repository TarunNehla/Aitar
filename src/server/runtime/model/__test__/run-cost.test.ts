import { describe, expect, it } from "vitest";
import { RunCostAccount } from "../run-cost.js";

function usage(total: number, input = 100, output = 20) {
  return { input, output, cost: { total } };
}

describe("run cost account", () => {
  it("starts empty", () => {
    const account = new RunCostAccount(2);
    expect(account.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      visionCostUsd: 0,
      visionRequests: 0,
      compactionCostUsd: 0,
      compactions: 0,
    });
    expect(account.remainingUsd()).toBe(2);
    expect(account.exceededBudget()).toBe(false);
  });

  it("accumulates model usage", () => {
    const account = new RunCostAccount(2);
    account.addModelUsage(usage(0.4, 1_000, 100));
    account.addModelUsage(usage(0.1, 500, 50));
    expect(account.totals()).toMatchObject({ inputTokens: 1_500, outputTokens: 150, costUsd: 0.5 });
  });

  it("adds vision usage to the same run total", () => {
    const account = new RunCostAccount(2);
    account.addModelUsage(usage(0.4, 1_000, 100));
    account.addVisionUsage({ inputTokens: 1_100, outputTokens: 240, costUsd: 0.05 });

    expect(account.totals()).toEqual({
      inputTokens: 2_100,
      outputTokens: 340,
      costUsd: 0.45,
      visionCostUsd: 0.05,
      visionRequests: 1,
      compactionCostUsd: 0,
      compactions: 0,
    });
    expect(account.remainingUsd()).toBeCloseTo(1.55);
  });

  it("adds compaction usage to the same run total", () => {
    const account = new RunCostAccount(2);
    account.addModelUsage(usage(0.4, 1_000, 100));
    account.addCompactionUsage({ input: 8_000, output: 900, cost: { total: 0.12 } });

    expect(account.totals()).toMatchObject({
      inputTokens: 9_000,
      outputTokens: 1_000,
      costUsd: 0.52,
      compactionCostUsd: 0.12,
      compactions: 1,
    });
  });

  it("counts compaction spend towards exceeding the budget", () => {
    const account = new RunCostAccount(0.1);
    account.addCompactionUsage({ input: 10, output: 10, cost: { total: 0.2 } });
    expect(account.exceededBudget()).toBe(true);
  });

  it("counts each vision request separately", () => {
    const account = new RunCostAccount(2);
    account.addVisionUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    account.addVisionUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    expect(account.totals().visionRequests).toBe(2);
    expect(account.totals().visionCostUsd).toBeCloseTo(0.02);
  });

  it("reports affordability against the remaining budget", () => {
    const account = new RunCostAccount(1);
    account.addModelUsage(usage(0.9));
    expect(account.canAfford(0.05)).toBe(true);
    expect(account.canAfford(0.2)).toBe(false);
  });

  it("never reports a negative remaining budget", () => {
    const account = new RunCostAccount(1);
    account.addModelUsage(usage(3));
    expect(account.remainingUsd()).toBe(0);
    expect(account.canAfford(0.01)).toBe(false);
    expect(account.exceededBudget()).toBe(true);
  });

  it("counts vision spend towards exceeding the budget", () => {
    const account = new RunCostAccount(0.1);
    account.addVisionUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0.2 });
    expect(account.exceededBudget()).toBe(true);
  });
});
