import { describe, expect, it } from "vitest";
import { branchSlug, pullRequestBranchName } from "../branch-name.js";
import { validateBranchName } from "../workspace-manager.js";

const chatId = "78a2a00d-b791-4ef5-92b9-b81d39d08ddd";

describe("pull request branch names", () => {
  it("keeps the name the model chose", () => {
    expect(pullRequestBranchName({ chatId, proposedName: "fix-login-screen-flicker" })).toBe(
      "agent/fix-login-screen-flicker-78a2a00d",
    );
  });

  it("drops the decoration a model puts in front of a name", () => {
    expect(branchSlug("agent/fix-login-screen")).toBe("fix-login-screen");
    expect(branchSlug("feature/add-password-reset")).toBe("add-password-reset");
    expect(branchSlug("fix: login screen flicker")).toBe("login-screen-flicker");
    expect(branchSlug("feat(auth): add password reset")).toBe("add-password-reset");
    expect(branchSlug("refactor!: split the vision router")).toBe("split-vision-router");
  });

  it("keeps a word that only looks like decoration", () => {
    expect(branchSlug("Fix the login screen")).toBe("fix-login-screen");
    expect(branchSlug("Test coverage for the parser")).toBe("test-coverage-for-parser");
  });

  it("shortens a name that runs long, without leaving a word dangling", () => {
    expect(branchSlug("Remove the deprecated vision router and its tests")).toBe("remove-deprecated-vision-router");
    expect(branchSlug("Add a dark mode toggle to the settings page")).toBe("add-dark-mode-toggle-to-settings");
    expect(branchSlug("and")).toBe("and");
  });

  it("falls back to the title when the name it was given reads as nothing", () => {
    for (const proposedName of ["", "   ", "?!", "///", null, undefined]) {
      expect(pullRequestBranchName({ chatId, proposedName, title: "Add caching" })).toBe(
        "agent/add-caching-78a2a00d",
      );
    }
  });

  it("still names a change when neither the name nor the title can be read", () => {
    expect(pullRequestBranchName({ chatId, proposedName: "?!", title: "" })).toBe("agent/chat-78a2a00d");
    expect(pullRequestBranchName({ chatId })).toBe("agent/chat-78a2a00d");
  });

  it("gives the same change the same branch every time", () => {
    const proposedName = "add-dashboard-caching";
    expect(pullRequestBranchName({ chatId, proposedName })).toBe(pullRequestBranchName({ chatId, proposedName }));
  });

  it("separates chats that proposed the same name", () => {
    const proposedName = "fix-login-screen";
    const other = "0880dc02-c71f-416c-b03c-9012120900c6";
    expect(pullRequestBranchName({ chatId, proposedName })).not.toBe(
      pullRequestBranchName({ chatId: other, proposedName }),
    );
  });

  it("never carries the whole chat id", () => {
    const name = pullRequestBranchName({ chatId, proposedName: "fix-login-screen" });
    expect(name).not.toContain(chatId);
    expect(name.split("-").pop()).toHaveLength(8);
  });

  it("cannot be talked onto a branch that is not its own", () => {
    const escapes = ["main", "refs/heads/main", "../../main", "agent/fix-login-screen-0880dc02", "HEAD"];

    for (const proposedName of escapes) {
      const name = pullRequestBranchName({ chatId, proposedName });
      expect(name.startsWith("agent/"), proposedName).toBe(true);
      expect(name.endsWith("-78a2a00d"), proposedName).toBe(true);
    }
  });

  it("stays a branch name Git and the platform both accept", () => {
    const proposals = [
      "Fix the `login` screen: it breaks!",
      "Ship ../../etc/passwd",
      "-- upload-pack=touch /tmp/x",
      "Do the thing with ~^:?*[ characters",
      "A change that keeps going and going and going and going and going and going",
      "日本語のリクエスト",
    ];

    for (const proposedName of proposals) {
      const name = pullRequestBranchName({ chatId, proposedName });
      expect(() => validateBranchName(name), proposedName).not.toThrow();
      expect(name.startsWith("agent/"), proposedName).toBe(true);
      expect(name.length, proposedName).toBeLessThanOrEqual(60);
    }
  });
});
