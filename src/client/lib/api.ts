import { authClient } from "../auth/auth-client";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    void authClient.getSession({ query: { disableCookieCache: true } });
    throw new Error("Your session ended. Sign in to continue");
  }

  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      throw new Error(`The server returned an invalid response (${response.status})`);
    }
  }
  if (!response.ok) throw new Error(body?.error ?? `Request failed with ${response.status}`);
  if (!body) throw new Error("The server returned an empty response");
  return body;
}
