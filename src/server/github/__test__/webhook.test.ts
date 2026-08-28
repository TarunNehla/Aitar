import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface InstallationRow {
  id: string;
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  status: string;
}

const installations = new Map<number, InstallationRow>();
const repositoryAccess = new Map<number, string>();

vi.mock("../../db/github-store.js", () => ({
  upsertGithubInstallation: async (input: Omit<InstallationRow, "id">) => {
    const existing = installations.get(input.installationId);
    const row: InstallationRow = { id: existing?.id ?? `installation-${input.installationId}`, ...input };
    installations.set(input.installationId, row);
    return row;
  },
  setGithubInstallationStatus: async (installationId: number, status: string) => {
    const existing = installations.get(installationId);
    if (!existing) return undefined;
    const row = { ...existing, status };
    installations.set(installationId, row);
    return row;
  },
  getGithubInstallation: async (installationId: number) => installations.get(installationId),
  setRepositoryAccessForInstallation: async (input: {
    githubRepositoryIds: number[];
    access: string;
  }) => {
    for (const id of input.githubRepositoryIds) repositoryAccess.set(id, input.access);
    return input.githubRepositoryIds.length;
  },
  revokeAllRepositoriesForInstallation: async () => {
    for (const id of repositoryAccess.keys()) repositoryAccess.set(id, "revoked");
    return repositoryAccess.size;
  },
}));

const { handleWebhookEvent, verifyWebhookSignature } = await import("../webhook.js");

const secret = "test-webhook-secret";

function sign(body: string, withSecret = secret): string {
  return `sha256=${createHmac("sha256", withSecret).update(body).digest("hex")}`;
}

function installationPayload(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    installation: {
      id: 4242,
      repository_selection: "selected",
      account: { id: 99, login: "acme", type: "Organization" },
      ...(extra.installation as Record<string, unknown> | undefined),
    },
    ...extra,
  };
}

beforeEach(() => {
  installations.clear();
  repositoryAccess.clear();
});

describe("GitHub webhook signature verification", () => {
  it("accepts a correctly signed payload", async () => {
    const body = JSON.stringify(installationPayload("created"));
    await expect(verifyWebhookSignature({ body, signature: sign(body), secret })).resolves.toBe(true);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const body = JSON.stringify(installationPayload("created"));
    await expect(
      verifyWebhookSignature({ body, signature: sign(body, "wrong-secret"), secret }),
    ).resolves.toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const body = JSON.stringify(installationPayload("created"));
    const signature = sign(body);
    const tampered = JSON.stringify(installationPayload("deleted"));
    await expect(verifyWebhookSignature({ body: tampered, signature, secret })).resolves.toBe(false);
  });

  it("rejects a missing signature", async () => {
    const body = JSON.stringify(installationPayload("created"));
    await expect(verifyWebhookSignature({ body, signature: undefined, secret })).resolves.toBe(false);
  });

  it("rejects a malformed signature", async () => {
    const body = JSON.stringify(installationPayload("created"));
    await expect(verifyWebhookSignature({ body, signature: "sha256=not-hex", secret })).resolves.toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    const body = JSON.stringify(installationPayload("created"));
    await expect(verifyWebhookSignature({ body, signature: sign(body), secret: "" })).resolves.toBe(false);
  });
});

describe("GitHub installation webhooks", () => {
  it("stores a new installation", async () => {
    const outcome = await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });

    expect(outcome).toBe("applied");
    expect(installations.get(4242)).toMatchObject({
      installationId: 4242,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      status: "active",
    });
  });

  it("handles repeated delivery of the same installation event idempotently", async () => {
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });
    const first = installations.get(4242);

    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });

    expect(installations.size).toBe(1);
    expect(installations.get(4242)?.id).toBe(first?.id);
    expect(installations.get(4242)?.status).toBe("active");
  });

  it("suspends and unsuspends an installation", async () => {
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });

    await handleWebhookEvent({ event: "installation", payload: installationPayload("suspend") });
    expect(installations.get(4242)?.status).toBe("suspended");

    await handleWebhookEvent({ event: "installation", payload: installationPayload("unsuspend") });
    expect(installations.get(4242)?.status).toBe("active");
  });

  it("marks a deleted installation and revokes its repositories", async () => {
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });
    repositoryAccess.set(1, "granted");

    const outcome = await handleWebhookEvent({ event: "installation", payload: installationPayload("deleted") });

    expect(outcome).toBe("applied");
    expect(installations.get(4242)?.status).toBe("deleted");
    expect(repositoryAccess.get(1)).toBe("revoked");
  });

  it("ignores events for unknown installations", async () => {
    const outcome = await handleWebhookEvent({ event: "installation", payload: installationPayload("suspend") });
    expect(outcome).toBe("ignored");
    expect(installations.size).toBe(0);
  });

  it("ignores unrelated event types", async () => {
    const outcome = await handleWebhookEvent({ event: "push", payload: installationPayload("created") });
    expect(outcome).toBe("ignored");
  });
});

describe("GitHub installation repository webhooks", () => {
  it("revokes repositories removed from an installation", async () => {
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });
    repositoryAccess.set(11, "granted");
    repositoryAccess.set(12, "granted");

    const outcome = await handleWebhookEvent({
      event: "installation_repositories",
      payload: installationPayload("removed", { repositories_removed: [{ id: 12 }] }),
    });

    expect(outcome).toBe("applied");
    expect(repositoryAccess.get(11)).toBe("granted");
    expect(repositoryAccess.get(12)).toBe("revoked");
  });

  it("restores access when repositories are added back", async () => {
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });
    repositoryAccess.set(12, "revoked");

    await handleWebhookEvent({
      event: "installation_repositories",
      payload: installationPayload("added", { repositories_added: [{ id: 12 }] }),
    });

    expect(repositoryAccess.get(12)).toBe("granted");
  });

  it("applies a repeated removal delivery without changing the outcome", async () => {
    await handleWebhookEvent({ event: "installation", payload: installationPayload("created") });
    repositoryAccess.set(12, "granted");

    const payload = installationPayload("removed", { repositories_removed: [{ id: 12 }] });
    await handleWebhookEvent({ event: "installation_repositories", payload });
    await handleWebhookEvent({ event: "installation_repositories", payload });

    expect(repositoryAccess.get(12)).toBe("revoked");
    expect(installations.size).toBe(1);
  });
});
