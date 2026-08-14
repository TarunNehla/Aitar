import { config } from "../config.js";
import { errorForLog, logger } from "../logger.js";

const emailLogger = logger.child({ component: "email" });
const resendEndpoint = "https://api.resend.com/emails";
const productName = "Aitar";

export type EmailTemplate = "verify_email" | "reset_password";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Transactional email is not configured");
    this.name = "EmailNotConfiguredError";
  }
}

export class EmailDeliveryError extends Error {
  constructor(readonly status: number) {
    super("Transactional email delivery failed");
    this.name = "EmailDeliveryError";
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function greeting(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Hi ${trimmed},` : "Hi,";
}

function layout(input: { heading: string; paragraph: string; action: string; url: string; closing: string }): string {
  return [
    `<p>${escapeHtml(input.heading)}</p>`,
    `<p>${escapeHtml(input.paragraph)}</p>`,
    `<p><a href="${escapeHtml(input.url)}">${escapeHtml(input.action)}</a></p>`,
    `<p>${escapeHtml(input.url)}</p>`,
    `<p>${escapeHtml(input.closing)}</p>`,
    `<p>${escapeHtml(`${productName} · ${config.APP_URL}`)}</p>`,
  ].join("\n");
}

export function verificationEmail(input: { name: string; url: string }): Omit<EmailMessage, "to"> {
  const heading = greeting(input.name);
  const paragraph = `Confirm this address to finish setting up your ${productName} account.`;
  const action = `Verify your ${productName} email`;
  const closing = "This link expires in one hour. If you did not create this account, ignore this email.";

  return {
    subject: `Verify your ${productName} email`,
    text: [heading, "", paragraph, "", input.url, "", closing, "", `${productName} · ${config.APP_URL}`].join("\n"),
    html: layout({ heading, paragraph, action, url: input.url, closing }),
  };
}

export function resetPasswordEmail(input: { name: string; url: string }): Omit<EmailMessage, "to"> {
  const heading = greeting(input.name);
  const paragraph = `Use this link to choose a new ${productName} password.`;
  const action = `Reset your ${productName} password`;
  const closing =
    "This link expires in one hour and can be used once. If you did not ask for it, your password is unchanged.";

  return {
    subject: `Reset your ${productName} password`,
    text: [heading, "", paragraph, "", input.url, "", closing, "", `${productName} · ${config.APP_URL}`].join("\n"),
    html: layout({ heading, paragraph, action, url: input.url, closing }),
  };
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!config.RESEND_API_KEY || !config.AUTH_EMAIL_FROM) throw new EmailNotConfiguredError();

  const response = await fetch(resendEndpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.AUTH_EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) throw new EmailDeliveryError(response.status);
}

/**
 * Response timing must not reveal whether an account exists, so authentication
 * callbacks start delivery and return without waiting for the provider.
 */
export function deliverInBackground(message: EmailMessage, template: EmailTemplate): void {
  void sendEmail(message).catch((error: unknown) => {
    emailLogger.error({ template, error: errorForLog(error) }, "Authentication email delivery failed");
  });
}
