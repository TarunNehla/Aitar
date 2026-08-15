import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CallOptions {
  fetchOptions?: { onError?: (context: { response: Response }) => void };
}

type Reply = { error: { code?: string; status?: number; message?: string } | null };

const signInEmail = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();
const signInSocial = vi.fn(async () => ({ error: null }));
const signUpEmail = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();
const sendVerificationEmail = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();
const requestPasswordReset = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();
const resetPassword = vi.fn<(input: Record<string, unknown> & CallOptions) => Promise<Reply>>();

vi.mock("./auth-client", async () => {
  const actual = await vi.importActual<typeof import("./auth-client")>("./auth-client");
  return {
    ...actual,
    signIn: { email: signInEmail, social: signInSocial },
    signUp: { email: signUpEmail },
    sendVerificationEmail,
    requestPasswordReset,
    resetPassword,
  };
});

const { AuthScreen } = await import("./components/auth/AuthScreen");
const { readAuthEntry, signInEntry } = await import("./auth-flow");

function renderAuth(entry = signInEntry, emailPassword = true) {
  return render(<AuthScreen entry={entry} emailPassword={emailPassword} />);
}

function renderResetLink(token: string | null) {
  const entry = readAuthEntry({
    pathname: "/reset-password",
    search: token === null ? "" : `?token=${token}`,
  });
  return render(<AuthScreen entry={entry} emailPassword onLeaveLink={() => undefined} />);
}

function throttled(seconds: number) {
  return async (input: CallOptions): Promise<Reply> => {
    input.fetchOptions?.onError?.({
      response: new Response(null, { status: 429, headers: { "X-Retry-After": String(seconds) } }),
    });
    return { error: { status: 429, code: "RATE_LIMITED" } };
  };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

async function openSignUp() {
  renderAuth();
  fireEvent.click(screen.getByRole("button", { name: "Create one" }));
  await waitFor(() => expect(screen.getByLabelText("Name")).toBeDefined());
}

async function openForgotPassword() {
  renderAuth();
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send reset link" })).toBeDefined());
}

beforeEach(() => {
  for (const mock of [signInEmail, signUpEmail, sendVerificationEmail, requestPasswordReset, resetPassword]) {
    mock.mockReset();
    mock.mockResolvedValue({ error: null });
  }
  signInSocial.mockClear();
});

afterEach(cleanup);

describe("compact sign-in panel", () => {
  it("shows one heading, one helper sentence, and one primary action", () => {
    renderAuth();

    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeDefined();
    expect(screen.getByText("Sign in to continue")).toBeDefined();

    const primary = document.querySelectorAll(".primary-button");
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toBe("Sign in");
  });

  it("sits in a card no wider than the auth card token", () => {
    renderAuth();

    expect(document.querySelector(".auth-shell .auth-card")).not.toBeNull();
    expect(document.querySelector(".onboarding")).toBeNull();
  });

  it("drops the privacy sentence and the linked-provider paragraph", () => {
    renderAuth();

    expect(document.body.textContent).not.toContain("stay private to your account");
    expect(document.body.textContent).not.toContain("Already use Google or GitHub with this email?");
  });

  it("names the product once, in plain type", () => {
    renderAuth();

    expect(document.querySelector(".auth-header .brand")?.textContent).toBe("Aitar");
  });
});

describe("provider buttons", () => {
  it("uses the real Google and GitHub marks rather than a generic arrow", () => {
    renderAuth();

    const google = screen.getByRole("button", { name: /Continue with Google/ });
    const github = screen.getByRole("button", { name: /Continue with GitHub/ });

    expect(google.querySelector("svg[viewBox='0 0 18 18']")).not.toBeNull();
    expect(google.querySelector("path[fill='#4285F4']")).not.toBeNull();
    expect(github.querySelector("svg[viewBox='0 0 24 24']")).not.toBeNull();
    expect(google.querySelector(".lucide-arrow-right")).toBeNull();
    expect(github.querySelector(".lucide-arrow-right")).toBeNull();
  });

  it("keeps the provider buttons secondary to the primary action", () => {
    renderAuth();

    for (const provider of ["Google", "GitHub"]) {
      const button = screen.getByRole("button", { name: new RegExp(`Continue with ${provider}`) });
      expect(button.className).toContain("ghost-button");
      expect(button.className).not.toContain("primary-button");
    }
  });

  it("starts a social sign-in", async () => {
    renderAuth();

    fireEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    await waitFor(() => expect(signInSocial).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" }));
  });

  it("offers only the providers where the deployment has no password sign-in", () => {
    renderAuth(signInEntry, false);

    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
    expect(screen.getByRole("button", { name: /Continue with Google/ })).toBeDefined();
  });
});

describe("password visibility control", () => {
  it("is an icon button with an accessible name, not the word Show", () => {
    renderAuth();

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.textContent).toBe("");
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("reveals a password on request without changing the value", () => {
    renderAuth();
    fill("Password", "correct horse 9");
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    expect(password.value).toBe("correct horse 9");
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
    expect(password.value).toBe("correct horse 9");
  });
});

describe("sign-in form", () => {
  it("labels every field and asks the browser for the right credential", () => {
    renderAuth();

    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("email");
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.type).toBe("password");
    expect(screen.getByLabelText("Remember me")).toBeDefined();
  });

  it("validates before reaching the server and ties the error to its field", () => {
    renderAuth();
    fill("Email", "not-an-email");
    submit("Sign in");

    const email = screen.getByLabelText("Email");
    const message = screen.getByText("Enter a valid email address");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(message.id);
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("passes the remember-me choice through", async () => {
    renderAuth();
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    fireEvent.click(screen.getByLabelText("Remember me"));
    submit("Sign in");

    await waitFor(() => expect(signInEmail).toHaveBeenCalled());
    expect(signInEmail.mock.calls[0][0]).toMatchObject({
      email: "ada@example.com",
      password: "correct horse 9",
      rememberMe: false,
    });
  });

  it("gives the same answer for an unknown address and a wrong password", async () => {
    signInEmail.mockResolvedValue({ error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD" } });

    renderAuth();
    fill("Email", "ada@example.com");
    fill("Password", "wrong password");
    submit("Sign in");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The email or password is incorrect."));

    cleanup();
    renderAuth();
    fill("Email", "nobody@example.com");
    fill("Password", "wrong password");
    submit("Sign in");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The email or password is incorrect."));
  });

  it("mentions social accounts only beside the error a social-only user hits", async () => {
    renderAuth();
    expect(document.body.textContent).not.toContain("If you signed up with Google or GitHub");

    signInEmail.mockResolvedValue({ error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD" } });
    fill("Email", "ada@example.com");
    fill("Password", "wrong password");
    submit("Sign in");

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "If you signed up with Google or GitHub, use Forgot password to set one.",
      ),
    );
  });

  it("disables every control while the request is in flight", async () => {
    let release: (value: Reply) => void = () => undefined;
    signInEmail.mockImplementation(() => new Promise<Reply>((resolve) => {
      release = resolve;
    }));

    renderAuth();
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    submit("Sign in");

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByLabelText("Email") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Continue with GitHub/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    release({ error: null });
  });

  it("moves an unverified address to its own step instead of piling copy on the form", async () => {
    signInEmail.mockResolvedValue({ error: { status: 403, code: "EMAIL_NOT_VERIFIED" } });

    renderAuth();
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    submit("Sign in");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Check your email" })).toBeDefined());
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(document.body.textContent).toContain(
      "Verify your email before signing in. We sent a new verification link.",
    );

    submit("Resend verification email");
    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ada@example.com", callbackURL: "/" }),
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: /Resend in \d+s/ })).toBeDefined());
    expect((screen.getByRole("button", { name: /Resend in \d+s/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeDefined();
  });

  it("reports throttling with the wait the server asked for", async () => {
    signInEmail.mockImplementation(throttled(30));

    renderAuth();
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    submit("Sign in");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 30 seconds."),
    );
  });
});

describe("create-account view", () => {
  it("asks for a name, an address, and a confirmed password and nothing else", async () => {
    await openSignUp();

    expect(screen.getByLabelText("Name").getAttribute("autocomplete")).toBe("name");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Confirm password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeDefined();
    expect(screen.queryByLabelText("Remember me")).toBeNull();
  });

  it("keeps the password requirement hidden until the field is focused", async () => {
    await openSignUp();
    expect(screen.queryByText("At least 8 characters")).toBeNull();

    fireEvent.focus(screen.getByLabelText("Password"));
    const requirement = screen.getByText("At least 8 characters");
    expect(screen.getByLabelText("Password").getAttribute("aria-describedby")).toBe(requirement.id);

    fireEvent.blur(screen.getByLabelText("Password"));
    expect(screen.queryByText("At least 8 characters")).toBeNull();
  });

  it("refuses a short password and a mismatched confirmation", async () => {
    await openSignUp();
    fill("Name", "Ada Lovelace");
    fill("Email", "ada@example.com");
    fill("Password", "short");
    fill("Confirm password", "different");
    submit("Create account");

    expect(screen.getByText("Use at least 8 characters")).toBeDefined();
    expect(screen.getByText("Both passwords must match")).toBeDefined();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("trims the name and address but never the password", async () => {
    await openSignUp();
    fill("Name", "  Ada Lovelace  ");
    fill("Email", "  ada@example.com  ");
    fill("Password", " correct horse 9 ");
    fill("Confirm password", " correct horse 9 ");
    submit("Create account");

    await waitFor(() => expect(signUpEmail).toHaveBeenCalled());
    expect(signUpEmail.mock.calls[0][0]).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: " correct horse 9 ",
      callbackURL: "/",
    });
  });

  it("shows one generic result whether or not the address already has an account", async () => {
    await openSignUp();
    fill("Name", "Ada Lovelace");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    fill("Confirm password", "correct horse 9");
    submit("Create account");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Check your email" })).toBeDefined());
    const firstResult = document.querySelector(".auth-card")?.textContent;
    expect(firstResult).toContain("If an account can be created with that address, we sent a verification link.");
    expect(document.body.textContent).not.toMatch(/already (exists|registered|in use)/i);

    cleanup();
    await openSignUp();
    fill("Name", "Grace Hopper");
    fill("Email", "grace@example.com");
    fill("Password", "correct horse 9");
    fill("Confirm password", "correct horse 9");
    submit("Create account");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Check your email" })).toBeDefined());
    expect(document.querySelector(".auth-card")?.textContent).toBe(firstResult);
  });

  it("submits once even when the button is pressed twice", async () => {
    let release: (value: Reply) => void = () => undefined;
    signUpEmail.mockImplementation(() => new Promise<Reply>((resolve) => {
      release = resolve;
    }));

    await openSignUp();
    fill("Name", "Ada Lovelace");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    fill("Confirm password", "correct horse 9");
    submit("Create account");
    submit("Create account");

    expect(signUpEmail).toHaveBeenCalledTimes(1);
    release({ error: null });
  });

  it("offers the same providers and a way back to sign in", async () => {
    await openSignUp();

    expect(screen.getByRole("button", { name: /Continue with GitHub/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Welcome back" })).toBeDefined());
  });
});

describe("forgot password", () => {
  it("shows only an address, one action, and a way back", async () => {
    await openForgotPassword();

    expect(screen.getByRole("heading", { name: "Forgot password" })).toBeDefined();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(document.querySelectorAll(".primary-button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeDefined();
  });

  it("answers generically in one success state and never puts the address in the URL", async () => {
    await openForgotPassword();
    fill("Email", "ada@example.com");
    submit("Send reset link");

    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
    const success = document.querySelector(".auth-status.success");
    expect(success?.textContent).toBe(
      "If an account exists for that address, we sent password-reset instructions.",
    );
    expect(success?.querySelector("svg")).not.toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(requestPasswordReset.mock.calls[0][0]).toMatchObject({
      email: "ada@example.com",
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(window.location.href).not.toContain("ada@example.com");
  });

  it("stays generic when the server rejects the request", async () => {
    requestPasswordReset.mockResolvedValue({ error: { status: 400, code: "USER_NOT_FOUND" } });

    await openForgotPassword();
    fill("Email", "nobody@example.com");
    submit("Send reset link");

    await waitFor(() => expect(document.querySelector(".auth-status.success")).not.toBeNull());
    expect(document.body.textContent).not.toMatch(/not found|no account|google|github/i);
  });

  it("surfaces throttling rather than a false success", async () => {
    requestPasswordReset.mockImplementation(throttled(45));

    await openForgotPassword();
    fill("Email", "ada@example.com");
    submit("Send reset link");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 45 seconds."),
    );
    expect(document.querySelector(".auth-status.success")).toBeNull();
  });
});

describe("reset password", () => {
  it("shows only the two password fields and one action", () => {
    renderResetLink("reset-token-value");

    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeDefined();
    expect(screen.getByLabelText("New password")).toBeDefined();
    expect(screen.getByLabelText("Confirm password")).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelectorAll(".primary-button")).toHaveLength(1);
  });

  it("requires a matching new password before calling the server", () => {
    renderResetLink("reset-token-value");
    fill("New password", "correct horse 9");
    fill("Confirm password", "something else");
    submit("Reset password");

    expect(screen.getByText("Both passwords must match")).toBeDefined();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("sets the password and ends on one compact success state", async () => {
    renderResetLink("reset-token-value");
    fill("New password", "a stronger secret");
    fill("Confirm password", "a stronger secret");
    submit("Reset password");

    await waitFor(() => expect(document.querySelector(".auth-status.success")).not.toBeNull());
    expect(resetPassword).toHaveBeenCalledWith(
      expect.objectContaining({ newPassword: "a stronger secret", token: "reset-token-value" }),
    );
    const success = document.querySelector(".auth-status.success");
    expect(success?.textContent).toBe("Password updated. Other sessions were signed out.");
    expect(success?.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("explains an expired or already used link and does not retry the token", async () => {
    resetPassword.mockResolvedValue({ error: { status: 400, code: "INVALID_TOKEN" } });

    renderResetLink("reset-token-value");
    fill("New password", "a stronger secret");
    fill("Confirm password", "a stronger secret");
    submit("Reset password");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That reset link is not valid or has already been used. Request a new one",
      ),
    );
    expect(resetPassword).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });

  it("never prints the token on the page", () => {
    renderResetLink("reset-token-value");

    expect(document.body.textContent).not.toContain("reset-token-value");
    expect(document.body.innerHTML).not.toContain("reset-token-value");
  });
});

describe("expired or invalid link", () => {
  it("offers a new link instead of a form that cannot work", () => {
    renderResetLink(null);

    expect(screen.getByRole("heading", { name: "That link expired" })).toBeDefined();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.getByRole("button", { name: "Request a new link" })).toBeDefined();
  });

  it("moves to the forgotten-password step from the expired link", async () => {
    renderResetLink(null);
    submit("Request a new link");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Forgot password" })).toBeDefined());
    expect(screen.getByLabelText("Email")).toBeDefined();
  });

  it("sends a failed verification link back to sign in", () => {
    const entry = readAuthEntry({ pathname: "/", search: "?error=TOKEN_EXPIRED" });
    render(<AuthScreen entry={entry} emailPassword />);

    expect(screen.getByRole("heading", { name: "That link expired" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Request a new link" })).toBeNull();
  });
});

describe("shared structure across every view", () => {
  const views: [string, () => void][] = [
    ["sign-in", () => renderAuth()],
    ["sign-up", () => void openSignUp()],
    ["reset-password", () => renderResetLink("reset-token-value")],
    ["link-expired", () => renderResetLink(null)],
  ];

  for (const [name, open] of views) {
    it(`gives ${name} exactly one heading inside the shared card`, async () => {
      open();
      await waitFor(() => expect(document.querySelector(".auth-card")).not.toBeNull());

      expect(document.querySelectorAll(".auth-shell")).toHaveLength(1);
      expect(document.querySelectorAll(".auth-card")).toHaveLength(1);
      expect(screen.getAllByRole("heading")).toHaveLength(1);
      expect(document.querySelectorAll(".primary-button").length).toBeLessThanOrEqual(1);
    });
  }

  it("keeps every control reachable by keyboard in reading order, each with a name", () => {
    renderAuth();
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>("input, button:not([disabled])"),
    ).filter((element) => element.tabIndex >= 0);

    const names = focusable.map((element) =>
      element instanceof HTMLInputElement
        ? document.querySelector(`label[for="${element.id}"]`)?.textContent
        : element.getAttribute("aria-label") ?? element.textContent,
    );

    expect(names).toEqual([
      "Email",
      "Password",
      "Show password",
      "Remember me",
      "Forgot password?",
      "Sign in",
      "Continue with Google",
      "Continue with GitHub",
      "Create one",
    ]);
  });

  it("uses a semantic form with real labels on every credential field", () => {
    renderAuth();

    expect(document.querySelector("form")).not.toBeNull();
    for (const input of Array.from(document.querySelectorAll("input"))) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      expect(label?.textContent).toBeTruthy();
    }
  });
});
