import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  askpassHelperPath,
  baseGitEnvironment,
  credentialDirectory,
  ensureAskpassHelper,
  withInstallationCredentials,
} from "./git-credentials.js";
import { runChecked, runProcess } from "./process.js";

const token = "ghs_credentialhelpertesttoken000000000";

afterEach(async () => {
  await rm(join(config.WORKSPACE_ROOT, "credential-probe"), { recursive: true, force: true });
});

describe("Git credential helper", () => {
  it("lives outside every agent-writable checkout", async () => {
    const helper = await ensureAskpassHelper();
    const chatRoot = join(config.WORKSPACE_ROOT, "chats");

    expect(helper).toBe(askpassHelperPath());
    expect(helper.startsWith(credentialDirectory())).toBe(true);
    expect(helper.startsWith(chatRoot)).toBe(false);

    const helperStat = await stat(helper);
    expect(helperStat.mode & 0o077).toBe(0);
  });

  it("never writes the token into the helper script", async () => {
    await withInstallationCredentials(token, async () => {
      const script = await readFile(askpassHelperPath(), "utf8");
      expect(script).not.toContain(token);
    });
  });

  it("supplies the token to the Git child process without process arguments", async () => {
    const observed = await withInstallationCredentials(token, async (gitEnvironment) => {
      const username = await runProcess("sh", [askpassHelperPath(), "Username for 'https://github.com': "], {
        env: gitEnvironment,
      });
      const password = await runProcess("sh", [askpassHelperPath(), "Password for 'https://github.com': "], {
        env: gitEnvironment,
      });
      return { username: username.stdout.trim(), password: password.stdout.trim() };
    });

    expect(observed.username).toBe("x-access-token");
    expect(observed.password).toBe(token);
  });

  it("clears the credential material after a successful operation", async () => {
    let captured: NodeJS.ProcessEnv | null = null;

    await withInstallationCredentials(token, async (gitEnvironment) => {
      captured = gitEnvironment;
      expect(gitEnvironment.GIT_CREDENTIAL_TOKEN).toBe(token);
    });

    expect(captured!.GIT_CREDENTIAL_TOKEN).toBe("");
    expect(captured!.GIT_CREDENTIAL_USERNAME).toBe("");
    expect(captured!.GIT_ASKPASS).toBe("");
  });

  it("clears the credential material after a failed operation", async () => {
    let captured: NodeJS.ProcessEnv | null = null;

    await expect(
      withInstallationCredentials(token, async (gitEnvironment) => {
        captured = gitEnvironment;
        throw new Error("fetch failed");
      }),
    ).rejects.toThrow("fetch failed");

    expect(captured!.GIT_CREDENTIAL_TOKEN).toBe("");
    expect(captured!.GIT_CREDENTIAL_USERNAME).toBe("");
    expect(captured!.GIT_ASKPASS).toBe("");
  });

  it("never leaks the token into the ambient process environment", async () => {
    await withInstallationCredentials(token, async () => {
      expect(process.env.GIT_CREDENTIAL_TOKEN).toBeUndefined();
      expect(JSON.stringify(process.env)).not.toContain(token);
    });
  });

  it("disables interactive Git prompts by default", () => {
    expect(baseGitEnvironment().GIT_TERMINAL_PROMPT).toBe("0");
    expect(baseGitEnvironment().GIT_CREDENTIAL_TOKEN).toBe("");
  });

  it("keeps the token out of Git remote URLs and .git/config", async () => {
    const probe = join(config.WORKSPACE_ROOT, "credential-probe");
    const remote = "https://github.com/acme/service.git";

    await withInstallationCredentials(token, async (gitEnvironment) => {
      await runChecked("git", ["init", "--bare", probe], { env: gitEnvironment });
      await runChecked("git", ["remote", "add", "origin", remote], { cwd: probe, env: gitEnvironment });
    });

    const gitConfig = await readFile(join(probe, "config"), "utf8");
    expect(gitConfig).toContain(remote);
    expect(gitConfig).not.toContain(token);
    expect(gitConfig).not.toContain("x-access-token");

    const storedRemote = await runChecked("git", ["remote", "get-url", "origin"], { cwd: probe });
    expect(storedRemote.stdout.trim()).toBe(remote);
  });
});
