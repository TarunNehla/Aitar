export const AGENT_NETWORK_ALIAS = "workspace";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::", "[::1]", "[::]"]);

const BLOCKED_HOSTNAMES = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
  "vm.docker.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

export class BrowserUrlError extends Error {}

function unwrapIpv6(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isLocalHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(value)) return true;
  if (value === "localhost.localdomain" || value.endsWith(".localhost")) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export function isBlockedAddress(hostname: string): boolean {
  const value = unwrapIpv6(hostname.toLowerCase());

  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
    if (value.startsWith("::ffff:")) return isBlockedAddress(value.slice(7));
    return false;
  }

  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  if (parts.map(Number).some((part) => part > 255)) return true;
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const value = unwrapIpv6(hostname.toLowerCase());
  if (BLOCKED_HOSTNAMES.has(value)) return true;
  if (value.endsWith(".internal") || value.endsWith(".local")) return true;
  return isBlockedAddress(value);
}

export interface PreparedNavigation {
  requestUrl: string;
  displayUrl: string;
  translated: boolean;
}

/**
 * The agent works in localhost terms because that is where its dev server listens.
 * The sidecar reaches the same server across the private network, so the request
 * URL swaps the host for the agent container's alias while the chat keeps the
 * original URL.
 */
export function prepareNavigation(rawUrl: unknown, alias: string = AGENT_NETWORK_ALIAS): PreparedNavigation {
  const value = String(rawUrl ?? "").trim();
  if (!value) throw new BrowserUrlError("A URL is required.");

  // "localhost:3000" looks like a scheme, so only a "//" separator counts as one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new BrowserUrlError(`${value} is not a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserUrlError("Only http and https URLs can be opened.");
  }
  if (parsed.username || parsed.password) {
    throw new BrowserUrlError("Credentials in a URL are not supported. Sign in through the page instead.");
  }

  const displayUrl = parsed.toString();

  if (isLocalHostname(parsed.hostname)) {
    const translated = new URL(displayUrl);
    translated.hostname = alias;
    return { requestUrl: translated.toString(), displayUrl, translated: true };
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new BrowserUrlError(
      `${parsed.hostname} is a private or infrastructure address the browser cannot reach. ` +
        "Use the application's localhost URL or a public address.",
    );
  }

  return { requestUrl: displayUrl, displayUrl, translated: false };
}

/** Turns a sidecar-side URL back into the localhost form the chat and the agent recognise. */
export function displayUrlFor(rawUrl: unknown, originalUrl: string, alias: string = AGENT_NETWORK_ALIAS): string {
  const value = String(rawUrl ?? "").trim();
  if (!value) return originalUrl;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return originalUrl;
  }
  if (parsed.hostname !== alias) return parsed.toString();

  // The caller does not always know the URL the agent asked for, so the alias
  // falls back to localhost rather than reaching the chat as an internal name.
  parsed.hostname = "localhost";
  try {
    const original = new URL(originalUrl);
    if (original.hostname !== alias) parsed.hostname = original.hostname;
  } catch {
    // Keep localhost.
  }
  return parsed.toString();
}
