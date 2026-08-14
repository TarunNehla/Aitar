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

const { SignIn } = await import("./components/SignIn");
const { ResetPassword } = await import("./components/ResetPassword");

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
  render(<SignIn emailPassword />);
  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
  await waitFor(() => expect(screen.getByLabelText("Name")).toBeDefined());
}

async function openForgotPassword() {
  render(<SignIn emailPassword />);
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send reset instructions" })).toBeDefined());
}

beforeEach(() => {
  for (const mock of [signInEmail, signUpEmail, sendVerificationEmail, requestPasswordReset, resetPassword]) {
    mock.mockReset();
    mock.mockResolvedValue({ error: null });
  }
  signInSocial.mockClear();
});

afterEach(cleanup);

describe("sign-in form", () => {
  it("labels every field and asks the browser for the right credential", () => {
    render(<SignIn emailPassword />);

    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("email");
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.type).toBe("password");
    expect(screen.getByLabelText("Remember me")).toBeDefined();
  });

  it("reveals a password on request without changing the value", () => {
    render(<SignIn emailPassword />);
    fill("Password", "correct horse 9");
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    expect(password.value).toBe("correct horse 9");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
    expect(password.value).toBe("correct horse 9");
  });

  it("validates before reaching the server", () => {
    render(<SignIn emailPassword />);
    fill("Email", "not-an-email");
    submit("Sign in");

    expect(screen.getByText("Enter a valid email address")).toBeDefined();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("passes the remember-me choice through", async () => {
    render(<SignIn emailPassword />);
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

    render(<SignIn emailPassword />);
    fill("Email", "ada@example.com");
    fill("Password", "wrong password");
    submit("Sign in");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The email or password is incorrect."));

    cleanup();
    render(<SignIn emailPassword />);
    fill("Email", "nobody@example.com");
    fill("Password", "wrong password");
    submit("Sign in");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The email or password is incorrect."));
  });

  it("offers a way out when the address is not verified yet", async () => {
    signInEmail.mockResolvedValue({ error: { status: 403, code: "EMAIL_NOT_VERIFIED" } });

    render(<SignIn emailPassword />);
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    submit("Sign in");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Verify your email before signing in. We sent a new verification link.",
      ),
    );
    submit("Resend verification email");

    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ada@example.com", callbackURL: "/" }),
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: /Resend in \d+s/ })).toBeDefined());
    expect((screen.getByRole("button", { name: /Resend in \d+s/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports throttling with the wait the server asked for", async () => {
    signInEmail.mockImplementation(throttled(30));

    render(<SignIn emailPassword />);
    fill("Email", "ada@example.com");
    fill("Password", "correct horse 9");
    submit("Sign in");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 30 seconds."),
    );
  });

  it("tells an existing provider user how to add a password", () => {
    render(<SignIn emailPassword />);

    expect(screen.getByText("Already use Google or GitHub with this email?")).toBeDefined();
    expect(document.body.textContent).toContain("Use “Forgot password” to create a password for the same Aitar account");
  });

  it("keeps the provider buttons working beside the form", async () => {
    render(<SignIn emailPassword />);
    expect(screen.getByText("or continue with")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    await waitFor(() => expect(signInSocial).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" }));
  });
});

describe("sign-up form", () => {
  it("asks for a name, an address, and a confirmed password", async () => {
    await openSignUp();

    expect(screen.getByLabelText("Name").getAttribute("autocomplete")).toBe("name");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Confirm password").getAttribute("autocomplete")).toBe("new-password");
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

    await waitFor(() => expect(screen.getByText("Check your email")).toBeDefined());
    const firstResult = document.querySelector(".auth-notice")?.textContent;
    expect(firstResult).toContain("If an account can be created with that address, we sent a verification link.");
    expect(document.body.textContent).not.toMatch(/already (exists|registered|in use)/i);

    cleanup();
    await openSignUp();
    fill("Name", "Grace Hopper");
    fill("Email", "grace@example.com");
    fill("Password", "correct horse 9");
    fill("Confirm password", "correct horse 9");
    submit("Create account");

    await waitFor(() => expect(screen.getByText("Check your email")).toBeDefined());
    expect(document.querySelector(".auth-notice")?.textContent).toBe(firstResult);
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
});

describe("forgotten password", () => {
  it("answers generically and never puts the address in the URL", async () => {
    await openForgotPassword();
    fill("Email", "ada@example.com");
    submit("Send reset instructions");

    await waitFor(() => expect(screen.getByText("Check your email")).toBeDefined());
    expect(document.body.textContent).toContain(
      "If an account exists for that address, we sent password-reset instructions.",
    );
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
    submit("Send reset instructions");

    await waitFor(() => expect(screen.getByText("Check your email")).toBeDefined());
    expect(document.body.textContent).not.toMatch(/not found|no account|google|github/i);
  });

  it("surfaces throttling rather than a false success", async () => {
    requestPasswordReset.mockImplementation(throttled(45));

    await openForgotPassword();
    fill("Email", "ada@example.com");
    submit("Send reset instructions");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 45 seconds."),
    );
    expect(screen.queryByText("Check your email")).toBeNull();
  });
});

describe("reset password", () => {
  it("requires a matching new password before calling the server", () => {
    render(<ResetPassword token="reset-token-value" onDone={() => undefined} />);
    fill("New password", "correct horse 9");
    fill("Confirm new password", "something else");
    submit("Set new password");

    expect(screen.getByText("Both passwords must match")).toBeDefined();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("sets the password and points the user back to sign in", async () => {
    render(<ResetPassword token="reset-token-value" onDone={() => undefined} />);
    fill("New password", "a stronger secret");
    fill("Confirm new password", "a stronger secret");
    submit("Set new password");

    await waitFor(() => expect(screen.getByText("Password updated")).toBeDefined());
    expect(resetPassword).toHaveBeenCalledWith(
      expect.objectContaining({ newPassword: "a stronger secret", token: "reset-token-value" }),
    );
    expect(screen.getByRole("button", { name: "Sign in with your new password" })).toBeDefined();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("explains an expired or already used link and does not retry the token", async () => {
    resetPassword.mockResolvedValue({ error: { status: 400, code: "INVALID_TOKEN" } });

    render(<ResetPassword token="reset-token-value" onDone={() => undefined} />);
    fill("New password", "a stronger secret");
    fill("Confirm new password", "a stronger secret");
    submit("Set new password");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That reset link is not valid or has already been used. Request a new one",
      ),
    );
    expect(resetPassword).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });

  it("never prints the token on the page", () => {
    render(<ResetPassword token="reset-token-value" onDone={() => undefined} />);

    expect(document.body.textContent).not.toContain("reset-token-value");
    expect(document.body.innerHTML).not.toContain("reset-token-value");
  });
});
