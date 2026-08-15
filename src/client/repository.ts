export function repositoryUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a repository URL";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Enter a full URL, like https://github.com/owner/repository";
  }

  if (url.username || url.password) return "Remove the credentials from the repository URL";
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    return "Aitar supports public HTTPS GitHub repositories";
  }
  if (url.pathname.split("/").filter(Boolean).length !== 2) {
    return "The URL needs an owner and a repository name";
  }
  return null;
}

export function repositoryNameFromUrl(value: string): string {
  try {
    const segments = new URL(value.trim()).pathname.split("/").filter(Boolean);
    return (segments[segments.length - 1] ?? "").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

function firstLine(message: string): string {
  const line = message.split("\n").map((entry) => entry.trim()).find(Boolean) ?? message;
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

export function describeSetupError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const lowered = message.toLowerCase();

  if (lowered.includes("could not read username") || lowered.includes("authentication failed")) {
    return "That repository is private. Aitar can only reach public GitHub repositories";
  }
  if (lowered.includes("repository not found") || lowered.includes("not found")) {
    return "That repository could not be found. Check the owner and repository name";
  }
  if (lowered.includes("could not resolve host") || lowered.includes("failed to connect")) {
    return "GitHub could not be reached. Check the connection and try again";
  }
  if (lowered.includes("timed out")) {
    return "Cloning timed out. Try again, or start from a smaller repository";
  }
  return firstLine(message);
}
