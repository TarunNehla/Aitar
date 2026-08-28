import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CallOptions {
  fetchOptions?: { onError?: (context: { response: Response }) => void };
}

type Reply = { error: { code?: string; status?: number } | null };

let accounts: Array<{ providerId: string }> = [];
let authMethods: { emailPassword: boolean } | null = { emailPassword: true };

const changePassword = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();
const requestPasswordReset = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();

vi.mock("../auth-client", async () => {
  const actual = await vi.importActual<typeof import("../auth-client")>("../auth-client");
  return {
    ...actual,
    useAuthMethods: () => authMethods,
    listAccounts: vi.fn(async () => ({ data: accounts, error: null })),
    linkSocial: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => undefined),
    changePassword,
    requestPasswordReset,
  };
});

const { UserMenu } = await import("../components/UserMenu");

const user = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", image: null };

async function openMenu() {
  render(<UserMenu user={user} onSignedOut={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /Ada Lovelace/ }));
  await waitFor(() => expect(screen.getByText("Sign-in providers")).toBeDefined());
}

beforeEach(() => {
  authMethods = { emailPassword: true };
  accounts = [{ providerId: "credential" }, { providerId: "google" }];
  changePassword.mockReset();
  changePassword.mockResolvedValue({ error: null });
  requestPasswordReset.mockReset();
  requestPasswordReset.mockResolvedValue({ error: null });
});

afterEach(cleanup);

describe("password section", () => {
  it("changes a password and signs the other sessions out", async () => {
    await openMenu();
    await waitFor(() => expect(screen.getByRole("button", { name: "Change password" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct horse 9" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a stronger secret" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a stronger secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(changePassword).toHaveBeenCalled());
    expect(changePassword.mock.calls[0][0]).toMatchObject({
      currentPassword: "correct horse 9",
      newPassword: "a stronger secret",
      revokeOtherSessions: true,
    });
    await waitFor(() =>
      expect(screen.getByText("Password updated. Your other sessions were signed out")).toBeDefined(),
    );
  });

  it("refuses a mismatched confirmation before reaching the server", async () => {
    await openMenu();
    await waitFor(() => expect(screen.getByRole("button", { name: "Change password" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct horse 9" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a stronger secret" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Both passwords must match")).toBeDefined();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("reports a wrong current password without clearing the form's purpose", async () => {
    changePassword.mockResolvedValue({ error: { status: 400, code: "INVALID_PASSWORD" } });

    await openMenu();
    await waitFor(() => expect(screen.getByRole("button", { name: "Change password" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "wrong password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a stronger secret" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a stronger secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That password is incorrect"));
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("sends a social-only account through the emailed reset instead of a dead form", async () => {
    accounts = [{ providerId: "google" }];
    await openMenu();

    await waitFor(() => expect(screen.getByRole("button", { name: "Create a password" })).toBeDefined());
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create a password" }));

    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalled());
    expect(requestPasswordReset.mock.calls[0][0]).toMatchObject({
      email: "ada@example.com",
      redirectTo: `${window.location.origin}/reset-password`,
    });
    await waitFor(() => expect(screen.getByText("Check your email for a link to set a password")).toBeDefined());
  });

  it("hides the section where the deployment has no email authentication", async () => {
    authMethods = { emailPassword: false };
    await openMenu();

    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create a password" })).toBeNull();
  });

  it("offers no way to remove the last sign-in method", async () => {
    accounts = [{ providerId: "google" }];
    await openMenu();

    expect(screen.queryByRole("button", { name: /disconnect|unlink|remove/i })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeDefined();
  });
});
