import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { verifyResetTarget } from "./reset-safety.js";

const repository = "/srv/data/cloud-agents";

function verify(configuredValue: string, resolvedRoot = configuredValue) {
  return verifyResetTarget({ configuredValue, resolvedRoot, sourceRepositoryRoot: repository });
}

describe("development reset targets", () => {
  it("accepts a configured data directory", () => {
    expect(verify(".cloud-agent", "/srv/cloud-agents-data/.cloud-agent")).toEqual({
      ok: true,
      root: "/srv/cloud-agents-data/.cloud-agent",
    });
    expect(verify("/var/lib/cloud-agents")).toEqual({ ok: true, root: "/var/lib/cloud-agents" });
  });

  it("refuses the filesystem root, the home directory, and shallow paths", () => {
    expect(verify("/")).toMatchObject({ ok: false, reason: "WORKSPACE_ROOT is the filesystem root" });
    expect(verify(homedir())).toMatchObject({ ok: false, reason: "WORKSPACE_ROOT is the home directory" });
    expect(verify("/tmp")).toMatchObject({ ok: false });
    expect((verify("/tmp") as { reason: string }).reason).toContain("too close to the filesystem root");
  });

  it("refuses an unset or unresolved configuration", () => {
    expect(verify("", "/var/lib/cloud-agents")).toMatchObject({ ok: false, reason: "WORKSPACE_ROOT is empty" });
    expect(verify("   ", "/var/lib/cloud-agents")).toMatchObject({ ok: false });
    expect((verify("$DATA_DIR/agents", "/var/lib/cloud-agents") as { reason: string }).reason)
      .toContain("unresolved variable");
  });

  it("refuses anything that is or contains the source repository", () => {
    expect((verify(repository) as { reason: string }).reason).toContain("is the Cloud Agents source repository");
    expect((verify("/srv/data") as { reason: string }).reason).toContain("contains the Cloud Agents source repository");
  });

  it("allows a data directory nested inside the repository", () => {
    expect(verify(".cloud-agent", `${repository}/.cloud-agent`)).toEqual({
      ok: true,
      root: `${repository}/.cloud-agent`,
    });
  });
});
