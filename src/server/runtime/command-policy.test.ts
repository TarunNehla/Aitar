import { describe, expect, it } from "vitest";
import { inspectCommand } from "./command-policy.js";

describe("inspectCommand", () => {
  it("allows ordinary test commands", () => {
    expect(inspectCommand("npm test", false)).toEqual({ allowed: true, approvalRequired: false });
  });

  it("requires approval for dependency installation", () => {
    expect(inspectCommand("pnpm install", false).approvalRequired).toBe(true);
  });

  it("requires approval for network access", () => {
    expect(inspectCommand("npm test", true).approvalRequired).toBe(true);
  });

  it("blocks Docker and Git push", () => {
    expect(inspectCommand("docker ps", false).allowed).toBe(false);
    expect(inspectCommand("git push origin main", false).allowed).toBe(false);
  });
});
