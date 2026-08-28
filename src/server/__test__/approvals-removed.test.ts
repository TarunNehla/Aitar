import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runProcess } from "../runtime/process.js";
import { schema } from "../db/schema.js";

const approvalWords = /approval|approvalBroker|waiting_for_approval|inspectCommand|command-policy/i;
// GitHub's own org-owner approval of an App installation is not an agent permission.
const allowedMatches = ['github_error: "approval_required"', 'code === "approval_required"'];

async function trackedSourceFiles(): Promise<string[]> {
  const result = await runProcess("git", ["ls-files", "src", "scripts", "drizzle"], { timeoutMs: 30_000 });
  return result.stdout
    .split("\n")
    .filter((path) => /\.(ts|tsx|css|sql)$/.test(path))
    .filter((path) => !/\.test\.tsx?$/.test(path));
}

describe("interactive permissions are gone", () => {
  it("keeps no approval source, broker, policy, or database table", async () => {
    const files = await trackedSourceFiles();
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8").catch(() => null);
      if (source === null) continue;
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!approvalWords.test(line)) return;
        if (allowedMatches.some((allowed) => line.includes(allowed))) return;
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);

    const names = files.map((path) => path.split("/").pop());
    expect(names).not.toContain("approval-broker.ts");
    expect(names).not.toContain("command-policy.ts");
    expect(Object.keys(schema)).not.toContain("approvalRequests");
  });

  it("keeps no approval route in the API surface", async () => {
    const source = await readFile("src/server/api.ts", "utf8");
    expect(source).not.toContain("/api/approvals");
  });

  it("keeps no approval state or card in the console", async () => {
    const app = await readFile("src/client/app/App.tsx", "utf8");
    const styles = await readFile("src/client/styles.css", "utf8");
    expect(app).not.toMatch(/Approval/);
    expect(styles).not.toContain(".approval-card");
  });
});
