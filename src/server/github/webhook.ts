import { verify } from "@octokit/webhooks-methods";
import { config } from "../config.js";
import {
  getGithubInstallation,
  revokeAllRepositoriesForInstallation,
  setGithubInstallationStatus,
  setRepositoryAccessForInstallation,
  upsertGithubInstallation,
} from "../db/github-store.js";
import { logger } from "../logger.js";

const webhookLogger = logger.child({ component: "github-webhook" });

export type WebhookOutcome = "applied" | "ignored";

export async function verifyWebhookSignature(input: {
  body: string;
  signature: string | undefined;
  secret?: string;
}): Promise<boolean> {
  const secret = input.secret ?? config.GITHUB_WEBHOOK_SECRET;
  if (!secret || !input.signature) return false;
  try {
    return await verify(secret, input.body, input.signature);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function repositoryIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Number(asRecord(entry).id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function installationFromPayload(payload: Record<string, unknown>) {
  const installation = asRecord(payload.installation);
  const account = asRecord(installation.account);
  const installationId = Number(installation.id);
  if (!Number.isFinite(installationId) || installationId <= 0) return null;
  return {
    installationId,
    accountId: Number(account.id ?? 0),
    accountLogin: String(account.login ?? account.slug ?? "unknown"),
    accountType: String(account.type ?? "Organization"),
    repositorySelection: String(installation.repository_selection ?? "selected"),
    suspended: Boolean(installation.suspended_at),
  };
}

async function handleInstallationEvent(
  action: string,
  payload: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const metadata = installationFromPayload(payload);
  if (!metadata) return "ignored";

  if (action === "deleted") {
    const existing = await getGithubInstallation(metadata.installationId);
    if (!existing) return "ignored";
    await setGithubInstallationStatus(metadata.installationId, "deleted");
    await revokeAllRepositoriesForInstallation(existing.id);
    return "applied";
  }

  if (action === "suspend" || action === "unsuspend") {
    const existing = await getGithubInstallation(metadata.installationId);
    if (!existing) return "ignored";
    await setGithubInstallationStatus(metadata.installationId, action === "suspend" ? "suspended" : "active");
    return "applied";
  }

  if (["created", "new_permissions_accepted", "added", "unsuspended"].includes(action)) {
    await upsertGithubInstallation({
      installationId: metadata.installationId,
      accountId: metadata.accountId,
      accountLogin: metadata.accountLogin,
      accountType: metadata.accountType,
      repositorySelection: metadata.repositorySelection,
      status: metadata.suspended ? "suspended" : "active",
    });
    return "applied";
  }

  return "ignored";
}

async function handleInstallationRepositoriesEvent(
  action: string,
  payload: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const metadata = installationFromPayload(payload);
  if (!metadata) return "ignored";

  const existing = await getGithubInstallation(metadata.installationId);
  if (!existing) return "ignored";

  const added = repositoryIds(payload.repositories_added);
  const removed = repositoryIds(payload.repositories_removed);

  if (removed.length > 0) {
    await setRepositoryAccessForInstallation({
      installationId: existing.id,
      githubRepositoryIds: removed,
      access: "revoked",
    });
  }
  if (added.length > 0) {
    await setRepositoryAccessForInstallation({
      installationId: existing.id,
      githubRepositoryIds: added,
      access: "granted",
    });
  }

  await upsertGithubInstallation({
    installationId: metadata.installationId,
    accountId: metadata.accountId,
    accountLogin: metadata.accountLogin,
    accountType: metadata.accountType,
    repositorySelection: metadata.repositorySelection,
    status: existing.status === "deleted" ? "active" : existing.status,
  });

  return added.length > 0 || removed.length > 0 || action === "added" || action === "removed"
    ? "applied"
    : "ignored";
}

export async function handleWebhookEvent(input: {
  event: string;
  payload: unknown;
}): Promise<WebhookOutcome> {
  const payload = asRecord(input.payload);
  const action = String(payload.action ?? "");

  const outcome =
    input.event === "installation"
      ? await handleInstallationEvent(action, payload)
      : input.event === "installation_repositories"
        ? await handleInstallationRepositoriesEvent(action, payload)
        : "ignored";

  webhookLogger.info({ event: input.event, action, outcome }, "GitHub webhook processed");
  return outcome;
}
