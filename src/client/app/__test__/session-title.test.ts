import { describe, expect, it } from "vitest";
import { defaultSessionTitle, deriveSessionTitle } from "../session-title";

describe("deriveSessionTitle", () => {
  it("keeps the default when there is nothing to read", () => {
    expect(deriveSessionTitle("")).toBe(defaultSessionTitle);
    expect(deriveSessionTitle("   \n\n  ")).toBe(defaultSessionTitle);
  });

  it("drops the request lead-in and capitalises the remainder", () => {
    expect(deriveSessionTitle("I want to make the background a bluish colour")).toBe(
      "Make the background a bluish colour",
    );
    expect(deriveSessionTitle("can you please add retry logic")).toBe("Add retry logic");
    expect(deriveSessionTitle("Please help me rename the auth module")).toBe("Rename the auth module");
  });

  it("normalises whitespace and strips leading Markdown bullets", () => {
    expect(deriveSessionTitle("- fix   the   flaky test")).toBe("Fix the flaky test");
    expect(deriveSessionTitle("## Upgrade the router")).toBe("Upgrade the router");
    expect(deriveSessionTitle("\n\n  2. Split the bundle  ")).toBe("Split the bundle");
  });

  it("uses the first meaningful sentence", () => {
    expect(deriveSessionTitle("Add a health check. Then deploy it to staging.")).toBe("Add a health check");
    expect(deriveSessionTitle("Hi. Fix the login redirect")).toBe("Hi. Fix the login redirect");
  });

  it("keeps titles to whole words within the length budget", () => {
    const title = deriveSessionTitle(
      "Refactor the entire authentication middleware so every request revalidates its session token",
    );
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title.split(" ").length).toBeLessThanOrEqual(8);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe("Refactor the entire authentication middleware…");
  });

  it("adds no ellipsis when the whole message fits", () => {
    expect(deriveSessionTitle("Add retry logic to the upload queue")).toBe("Add retry logic to the upload queue");
  });

  it("truncates a single oversized word", () => {
    const title = deriveSessionTitle("a".repeat(80));
    expect(title).toHaveLength(50);
    expect(title.endsWith("…")).toBe(true);
  });
});
