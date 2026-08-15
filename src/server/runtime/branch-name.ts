const maxWords = 6;
const maxLength = 40;
const namespace = "agent";

/** Names arrive decorated the way commits and branches are: "agent/", "fix:", "feat(auth)!:". */
const decoration = /^(?:[a-z][a-z0-9._-]*\/|[a-z]+(?:\([^)]*\))?!?:\s*)+/;
const determiners = new Set(["a", "an", "the", "this", "that", "these", "those", "my", "our", "its", "it"]);
const connectors = new Set([
  "and", "or", "but", "so", "as", "if", "when", "while",
  "to", "for", "with", "of", "in", "on", "at", "from", "into", "by",
]);

export function branchSlug(text: string): string {
  const line = text.split("\n").find((entry) => /[a-z0-9]/i.test(entry));
  if (!line) return "";

  const words = line
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(decoration, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !determiners.has(word));

  const kept: string[] = [];
  for (const word of words.slice(0, maxWords)) {
    if (kept.length > 0 && [...kept, word].join("-").length > maxLength) break;
    kept.push(word);
  }
  // Cutting at the word limit can leave a connector dangling: "remove-old-router-and".
  while (kept.length > 1 && connectors.has(kept[kept.length - 1])) kept.pop();

  return kept.join("-").slice(0, maxLength).replace(/-+$/, "");
}

/**
 * The model proposes the name; the platform decides where that name may live.
 * The namespace and the chat suffix are what keep a proposal from landing on a
 * protected branch or on the branch belonging to another chat.
 */
export function pullRequestBranchName(input: {
  chatId: string;
  proposedName?: string | null;
  title?: string | null;
}): string {
  const slug = branchSlug(input.proposedName ?? "") || branchSlug(input.title ?? "") || "chat";
  const suffix = input.chatId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `${namespace}/${slug}${suffix ? `-${suffix}` : ""}`;
}
