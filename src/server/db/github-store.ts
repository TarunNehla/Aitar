import { and, eq, inArray } from "drizzle-orm";
import { db } from "./client.js";
import { githubInstallationUsers, githubInstallations, repositories } from "./schema.js";

export type GitHubInstallationRow = typeof githubInstallations.$inferSelect;

export async function upsertGithubInstallation(input: {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  status: string;
}): Promise<GitHubInstallationRow> {
  const [installation] = await db
    .insert(githubInstallations)
    .values(input)
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        accountId: input.accountId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection,
        status: input.status,
        updatedAt: new Date(),
      },
    })
    .returning();
  return installation;
}

export async function setGithubInstallationStatus(installationId: number, status: string) {
  const [installation] = await db
    .update(githubInstallations)
    .set({ status, updatedAt: new Date() })
    .where(eq(githubInstallations.installationId, installationId))
    .returning();
  return installation;
}

export async function getGithubInstallation(installationId: number) {
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  return installation;
}

export async function linkUserToGithubInstallation(input: { installationId: string; userId: string }) {
  await db.insert(githubInstallationUsers).values(input).onConflictDoNothing({
    target: [githubInstallationUsers.installationId, githubInstallationUsers.userId],
  });
}

export async function listGithubInstallationsForUser(userId: string) {
  return db
    .select({ installation: githubInstallations })
    .from(githubInstallationUsers)
    .innerJoin(githubInstallations, eq(githubInstallationUsers.installationId, githubInstallations.id))
    .where(eq(githubInstallationUsers.userId, userId))
    .then((rows) => rows.map((row) => row.installation));
}

export async function getGithubInstallationForUser(input: { installationId: number; userId: string }) {
  const [row] = await db
    .select({ installation: githubInstallations })
    .from(githubInstallations)
    .innerJoin(
      githubInstallationUsers,
      eq(githubInstallationUsers.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(githubInstallations.installationId, input.installationId),
        eq(githubInstallationUsers.userId, input.userId),
      ),
    )
    .limit(1);
  return row?.installation;
}

export async function setRepositoryAccessForInstallation(input: {
  installationId: string;
  githubRepositoryIds: number[];
  access: "granted" | "revoked";
}) {
  if (input.githubRepositoryIds.length === 0) return 0;
  const updated = await db
    .update(repositories)
    .set({ githubAccess: input.access, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.githubInstallationId, input.installationId),
        inArray(repositories.githubRepositoryId, input.githubRepositoryIds),
      ),
    )
    .returning({ id: repositories.id });
  return updated.length;
}

export async function revokeAllRepositoriesForInstallation(installationId: string) {
  const updated = await db
    .update(repositories)
    .set({ githubAccess: "revoked", updatedAt: new Date() })
    .where(eq(repositories.githubInstallationId, installationId))
    .returning({ id: repositories.id });
  return updated.length;
}
