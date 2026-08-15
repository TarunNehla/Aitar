export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  visionCostUsd: number;
  visionRequests: number;
  compactionCostUsd: number;
  compactions: number;
}

export interface VisionCharge {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class RunCostAccount {
  private inputTokens = 0;
  private outputTokens = 0;
  private modelCostUsd = 0;
  private visionCostUsd = 0;
  private visionRequests = 0;
  private compactionCostUsd = 0;
  private compactions = 0;

  constructor(readonly maxCostUsd: number) {}

  addModelUsage(usage: { input: number; output: number; cost: { total: number } }): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.modelCostUsd += usage.cost.total;
  }

  addVisionUsage(charge: VisionCharge): void {
    this.inputTokens += charge.inputTokens;
    this.outputTokens += charge.outputTokens;
    this.visionCostUsd += charge.costUsd;
    this.visionRequests += 1;
  }

  addCompactionUsage(usage: { input: number; output: number; cost: { total: number } }): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.compactionCostUsd += usage.cost.total;
    this.compactions += 1;
  }

  spentUsd(): number {
    return this.modelCostUsd + this.visionCostUsd + this.compactionCostUsd;
  }

  remainingUsd(): number {
    return Math.max(0, this.maxCostUsd - this.spentUsd());
  }

  canAfford(estimateUsd: number): boolean {
    return this.remainingUsd() >= estimateUsd;
  }

  exceededBudget(): boolean {
    return this.spentUsd() > this.maxCostUsd;
  }

  totals(): RunUsageTotals {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.spentUsd(),
      visionCostUsd: this.visionCostUsd,
      visionRequests: this.visionRequests,
      compactionCostUsd: this.compactionCostUsd,
      compactions: this.compactions,
    };
  }
}
