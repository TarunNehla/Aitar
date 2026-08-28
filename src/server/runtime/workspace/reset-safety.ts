import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ResetTarget =
  | { ok: true; root: string }
  | { ok: false; reason: string };

/**
 * A development reset may only delete inside a workspace root that is explicitly
 * configured, absolute, deep enough to be a data directory, and neither the home
 * directory, the filesystem root, nor anywhere that holds the source repository.
 */
export function verifyResetTarget(input: {
  configuredValue: string | undefined;
  resolvedRoot: string;
  sourceRepositoryRoot: string;
}): ResetTarget {
  const configured = input.configuredValue ?? "";
  if (!configured.trim()) return { ok: false, reason: "WORKSPACE_ROOT is empty" };
  if (configured.includes("$")) {
    return { ok: false, reason: `WORKSPACE_ROOT contains an unresolved variable: ${configured}` };
  }

  const root = resolve(input.resolvedRoot);
  if (!isAbsolute(root)) return { ok: false, reason: `WORKSPACE_ROOT did not resolve to an absolute path: ${root}` };
  if (root === sep) return { ok: false, reason: "WORKSPACE_ROOT is the filesystem root" };
  if (root === resolve(homedir())) return { ok: false, reason: "WORKSPACE_ROOT is the home directory" };
  if (root.split(sep).filter(Boolean).length < 2) {
    return { ok: false, reason: `WORKSPACE_ROOT is too close to the filesystem root: ${root}` };
  }

  const repository = resolve(input.sourceRepositoryRoot);
  if (root === repository) return { ok: false, reason: "WORKSPACE_ROOT is the Cloud Agents source repository" };
  const repositoryFromRoot = relative(root, repository);
  if (repositoryFromRoot === "" || (!repositoryFromRoot.startsWith("..") && !isAbsolute(repositoryFromRoot))) {
    return { ok: false, reason: `WORKSPACE_ROOT contains the Cloud Agents source repository: ${root}` };
  }

  return { ok: true, root };
}
