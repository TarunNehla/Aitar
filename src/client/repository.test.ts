import { describe, expect, it } from "vitest";
import { describeSetupError, repositoryNameFromUrl, repositoryUrlError } from "./repository";

describe("repositoryUrlError", () => {
  it("accepts a public GitHub repository URL", () => {
    expect(repositoryUrlError("https://github.com/owner/repository")).toBeNull();
    expect(repositoryUrlError("  https://github.com/owner/repository.git  ")).toBeNull();
  });

  it("rejects an empty or unparseable value", () => {
    expect(repositoryUrlError("")).toBe("Enter a repository URL");
    expect(repositoryUrlError("owner/repository")).toMatch(/full URL/);
  });

  it("rejects hosts and schemes the backend refuses", () => {
    expect(repositoryUrlError("http://github.com/owner/repository")).toMatch(/HTTPS GitHub/);
    expect(repositoryUrlError("https://gitlab.com/owner/repository")).toMatch(/HTTPS GitHub/);
    expect(repositoryUrlError("git@github.com:owner/repository.git")).toMatch(/full URL/);
  });

  it("rejects embedded credentials", () => {
    expect(repositoryUrlError("https://user:token@github.com/owner/repository")).toMatch(/credentials/);
  });

  it("requires an owner and a repository name", () => {
    expect(repositoryUrlError("https://github.com/owner")).toMatch(/owner and a repository/);
    expect(repositoryUrlError("https://github.com/owner/repository/tree/main")).toMatch(/owner and a repository/);
  });
});

describe("repositoryNameFromUrl", () => {
  it("takes the last path segment without the git suffix", () => {
    expect(repositoryNameFromUrl("https://github.com/owner/repository")).toBe("repository");
    expect(repositoryNameFromUrl("https://github.com/owner/repository.git")).toBe("repository");
  });

  it("returns nothing for an unparseable URL", () => {
    expect(repositoryNameFromUrl("not a url")).toBe("");
  });
});

describe("describeSetupError", () => {
  it("explains an unreachable private repository", () => {
    const error = new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    expect(describeSetupError(error, "main")).toMatch(/private/);
  });

  it("explains a missing repository", () => {
    const error = new Error("remote: Repository not found.\nfatal: repository not found");
    expect(describeSetupError(error, "main")).toMatch(/could not be found/);
  });

  it("names the branch that is missing", () => {
    const error = new Error("fatal: ambiguous argument 'refs/remotes/origin/release^{commit}': unknown revision");
    expect(describeSetupError(error, "release")).toContain("release");
  });

  it("falls back to the first line of an unrecognised failure", () => {
    const error = new Error("fatal: something else went wrong\nsecond line");
    expect(describeSetupError(error, "main")).toBe("fatal: something else went wrong");
  });
});
