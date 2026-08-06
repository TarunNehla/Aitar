import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

const askpassScript = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "\${GIT_CREDENTIAL_USERNAME:-x-access-token}" ;;
  *) printf '%s\\n' "\$GIT_CREDENTIAL_TOKEN" ;;
esac
`;

export function credentialDirectory(): string {
  return join(config.WORKSPACE_ROOT, "credentials");
}

export function askpassHelperPath(): string {
  return join(credentialDirectory(), "git-askpass.sh");
}

let helperReady: Promise<string> | null = null;

export async function ensureAskpassHelper(): Promise<string> {
  helperReady ??= (async () => {
    const path = askpassHelperPath();
    await mkdir(credentialDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(path, askpassScript, { encoding: "utf8", mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  })();
  return helperReady;
}

export function baseGitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "",
    GIT_CREDENTIAL_TOKEN: "",
    GIT_CREDENTIAL_USERNAME: "",
  };
}

export async function withInstallationCredentials<T>(
  token: string,
  operation: (gitEnvironment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const helper = await ensureAskpassHelper();
  const gitEnvironment: NodeJS.ProcessEnv = {
    ...baseGitEnvironment(),
    GIT_ASKPASS: helper,
    GIT_CREDENTIAL_USERNAME: "x-access-token",
    GIT_CREDENTIAL_TOKEN: token,
  };

  try {
    return await operation(gitEnvironment);
  } finally {
    gitEnvironment.GIT_CREDENTIAL_TOKEN = "";
    gitEnvironment.GIT_CREDENTIAL_USERNAME = "";
    gitEnvironment.GIT_ASKPASS = "";
  }
}
