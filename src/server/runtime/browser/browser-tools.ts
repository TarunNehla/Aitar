import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { config } from "../../config.js";
import { browserSessions } from "./browser-session.js";
import { safeUrlPreview } from "../output-policy.js";
import {
  DEFAULT_INSPECTION_QUESTION,
  loadImageArtifact,
  type RunVisionRouter,
  type VisionOutcome,
} from "../model/vision-router.js";

export interface BrowserToolContext {
  chatId: string;
  repositoryPath: string;
  runId: string;
  vision: RunVisionRouter;
  writer: { live: (type: string, payload: Record<string, unknown>) => void };
}

type ToolResult = Awaited<ReturnType<AgentTool["execute"]>>;

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function imageResult(
  text: string,
  image: { data: string; mimeType: string },
  details: Record<string, unknown> = {},
): ToolResult {
  return {
    content: [
      { type: "text" as const, text },
      { type: "image" as const, data: image.data, mimeType: image.mimeType },
    ],
    details,
  };
}

const QUESTION_LIMIT = 400;

function inspectionQuestion(value: unknown): string {
  const question = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!question) return DEFAULT_INSPECTION_QUESTION;
  return question.length <= QUESTION_LIMIT ? question : `${question.slice(0, QUESTION_LIMIT - 1)}…`;
}

function visionDetails(outcome: VisionOutcome): Record<string, unknown> {
  return {
    routing: outcome.decision,
    structured: outcome.structured,
    visionDurationMs: outcome.durationMs,
    ...(outcome.visionModelId === undefined ? {} : { visionModel: outcome.visionModelId }),
    ...(outcome.usage === undefined
      ? {}
      : {
          visionInputTokens: outcome.usage.inputTokens,
          visionOutputTokens: outcome.usage.outputTokens,
          visionCostUsd: outcome.usage.costUsd,
        }),
    ...(outcome.analysis === undefined
      ? {}
      : {
          confidence: outcome.analysis.confidence,
          visualProblems: outcome.analysis.visualProblems.length,
          visionSummary: outcome.analysis.answer,
        }),
  };
}

const SENSITIVE_NAME = /pass|secret|token|otp|pin|cvv|card|credential|security\s*code/i;
const SENSITIVE_VALUE = /^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|eyJ[A-Za-z0-9_-]{6,}\.)/;

export function redactsTypedText(input: {
  sensitive?: boolean;
  password?: boolean;
  elementName?: string;
  text: string;
}): boolean {
  if (input.sensitive) return true;
  if (input.password) return true;
  if (input.elementName && SENSITIVE_NAME.test(input.elementName)) return true;
  if (SENSITIVE_VALUE.test(input.text.trim())) return true;
  return input.text.trim().length >= 24 && /^[A-Za-z0-9_\-./+=]+$/.test(input.text.trim());
}

function elementLabel(element: { role?: string; name?: string } | undefined): string {
  const name = String(element?.name ?? "").trim();
  if (name) return name;
  return String(element?.role ?? "element");
}

function summaryLine(summary: { heading?: string; text?: string } | undefined): string {
  const heading = String(summary?.heading ?? "").trim();
  const text = String(summary?.text ?? "").trim();
  if (heading && text) return `${heading} — ${text.slice(0, 240)}`;
  return heading || text.slice(0, 240) || "(no readable text)";
}

export function createBrowserTools(context: BrowserToolContext): AgentTool[] {
  const base = { chatId: context.chatId, repositoryPath: context.repositoryPath };

  const announce = (action: string, payload: Record<string, unknown>) =>
    context.writer.live("browser_action", { action, ...payload });

  const navigate: AgentTool = {
    name: "browser_navigate",
    label: "browser navigate",
    description:
      "Open a URL in this chat's browser. Use the application's normal localhost URL, such as http://localhost:3000; " +
      "the platform routes it to this chat's container. Call browser_snapshot afterwards to read the page.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1, description: "URL to open, for example http://localhost:3000" }),
      waitUntil: Type.Optional(
        Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")], {
          description: "When to consider the page ready. Defaults to domcontentloaded.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: config.BROWSER_NAVIGATION_TIMEOUT_SECONDS,
          description: `Timeout in seconds, capped at ${config.BROWSER_NAVIGATION_TIMEOUT_SECONDS}`,
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const outcome = await browserSessions.navigate({
        ...base,
        url: params.url,
        waitUntil: params.waitUntil === undefined ? undefined : String(params.waitUntil),
        timeout: params.timeout === undefined ? undefined : Number(params.timeout),
        signal,
      });
      announce("navigate", { callId, url: safeUrlPreview(outcome.url), title: outcome.title });

      const status = outcome.status === null ? "unknown" : String(outcome.status);
      const timedOut = outcome.timedOut ? " Navigation timed out before the page settled." : "";
      return textResult(
        `Opened ${outcome.url} — “${outcome.title}” (HTTP ${status}, ${outcome.durationMs} ms).${timedOut}\n\n` +
          `Page summary: ${summaryLine(outcome.summary)}`,
        {
          url: outcome.url,
          title: outcome.title,
          status: outcome.status,
          durationMs: outcome.durationMs,
          timedOut: Boolean(outcome.timedOut),
        },
      );
    },
  };

  const snapshot: AgentTool = {
    name: "browser_snapshot",
    label: "browser snapshot",
    description:
      "Read the current page as a bounded list of interactive elements with stable references such as [button-1]. " +
      "Use these references with browser_click, browser_type, and browser_select instead of guessing selectors or coordinates.",
    parameters: Type.Object({}),
    execute: async (callId, _params: any, signal) => {
      const outcome = await browserSessions.snapshot({ ...base, signal });
      announce("snapshot", { callId, url: safeUrlPreview(outcome.url), elements: outcome.elements.length });

      const lines = outcome.elements.map((element: any) => {
        const flags = [element.disabled ? "disabled" : "", element.checked ? "checked" : ""].filter(Boolean);
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `[${element.ref}] ${element.name || element.role}${suffix}`;
      });
      const headings = outcome.headings.length > 0 ? `Headings: ${outcome.headings.join(" · ")}\n` : "";
      const truncated = outcome.truncated ? "\n(more elements exist than are listed)" : "";

      return textResult(
        `${outcome.title || "Untitled page"} — ${outcome.url}\n${headings}\n` +
          `${lines.length > 0 ? lines.join("\n") : "(no interactive elements found)"}${truncated}\n\n` +
          `Text: ${String(outcome.bodyText ?? "").slice(0, 1_000)}`,
        { url: outcome.url, title: outcome.title, elements: outcome.elements.length, truncated: Boolean(outcome.truncated) },
      );
    },
  };

  const click: AgentTool = {
    name: "browser_click",
    label: "browser click",
    description: "Click an element from the most recent browser_snapshot, using its reference such as button-1.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1, description: "Element reference from browser_snapshot, for example button-1" }),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const outcome = await browserSessions.act({
        ...base,
        action: "click",
        body: { ref: String(params.ref) },
        signal,
      });
      const label = elementLabel(outcome.element);
      announce("click", { callId, label, url: safeUrlPreview(outcome.url) });
      return textResult(
        `Clicked “${label}”. ${outcome.navigated ? `The page navigated to ${outcome.url}.` : `Still on ${outcome.url}.`} ` +
          `(${outcome.durationMs} ms)`,
        { label, url: outcome.url, navigated: Boolean(outcome.navigated), durationMs: outcome.durationMs },
      );
    },
  };

  const type: AgentTool = {
    name: "browser_type",
    label: "browser type",
    description:
      "Type text into an input from the most recent browser_snapshot. " +
      "Set sensitive to true for anything private; the value is never written to the chat, the event log, or the database.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1, description: "Element reference from browser_snapshot, for example input-2" }),
      text: Type.String({ description: "Text to type into the field" }),
      clear: Type.Optional(Type.Boolean({ description: "Clear the field before typing" })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
      sensitive: Type.Optional(Type.Boolean({ description: "Treat the value as private and never record it" })),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const text = String(params.text ?? "");
      const outcome = await browserSessions.act({
        ...base,
        action: "type",
        body: {
          ref: String(params.ref),
          text,
          clear: Boolean(params.clear),
          submit: Boolean(params.submit),
        },
        signal,
      });
      const label = elementLabel(outcome.element);
      const redacted = redactsTypedText({
        sensitive: Boolean(params.sensitive),
        password: Boolean(outcome.element?.password),
        elementName: label,
        text,
      });
      announce("type", { callId, label, redacted, characters: text.length });
      return textResult(
        `Typed ${redacted ? "[REDACTED]" : `“${text.slice(0, 120)}”`} into “${label}”.` +
          `${outcome.navigated ? ` The page navigated to ${outcome.url}.` : ""} (${outcome.durationMs} ms)`,
        {
          label,
          characters: text.length,
          redacted,
          submit: Boolean(params.submit),
          navigated: Boolean(outcome.navigated),
          durationMs: outcome.durationMs,
        },
      );
    },
  };

  const select: AgentTool = {
    name: "browser_select",
    label: "browser select",
    description: "Choose one or more options in a select element from the most recent browser_snapshot.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1, description: "Element reference from browser_snapshot, for example select-1" }),
      values: Type.Array(Type.String(), { minItems: 1, description: "Option values or labels to select" }),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const values = (params.values as unknown[]).map(String);
      const outcome = await browserSessions.act({ ...base, action: "select", body: { ref: String(params.ref), values }, signal });
      const label = elementLabel(outcome.element);
      announce("select", { callId, label, values: values.length });
      return textResult(`Selected ${values.map((value) => `“${value}”`).join(", ")} in “${label}”. (${outcome.durationMs} ms)`, {
        label,
        values,
        durationMs: outcome.durationMs,
      });
    },
  };

  const press: AgentTool = {
    name: "browser_press",
    label: "browser press",
    description: "Press a keyboard key on the current page, such as Enter, Escape, Tab, ArrowDown, or PageDown.",
    parameters: Type.Object({
      key: Type.String({ minLength: 1, maxLength: 40, description: "Key name, for example Enter, Escape, Tab, ArrowDown" }),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const key = String(params.key);
      const outcome = await browserSessions.act({ ...base, action: "press", body: { key }, signal });
      announce("press", { callId, key });
      return textResult(
        `Pressed ${key}.${outcome.navigated ? ` The page navigated to ${outcome.url}.` : ""} (${outcome.durationMs} ms)`,
        { key, navigated: Boolean(outcome.navigated), durationMs: outcome.durationMs },
      );
    },
  };

  const scroll: AgentTool = {
    name: "browser_scroll",
    label: "browser scroll",
    description: "Scroll the current page. Omit amount to move by one viewport.",
    parameters: Type.Object({
      direction: Type.Union(
        [Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")],
        { description: "Direction to scroll" },
      ),
      amount: Type.Optional(Type.Number({ minimum: 1, description: "Distance in pixels" })),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const direction = String(params.direction);
      const outcome = await browserSessions.act({
        ...base,
        action: "scroll",
        body: { direction, amount: params.amount === undefined ? undefined : Number(params.amount) },
        signal,
      });
      announce("scroll", { callId, direction });
      return textResult(`Scrolled ${direction}. The page is now at x ${outcome.x}, y ${outcome.y}.`, {
        direction,
        x: outcome.x,
        y: outcome.y,
        durationMs: outcome.durationMs,
      });
    },
  };

  const wait: AgentTool = {
    name: "browser_wait",
    label: "browser wait",
    description:
      "Wait for text to appear on the page or for an element reference to become visible. Provide text or ref.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ minLength: 1, description: "Text to wait for" })),
      ref: Type.Optional(Type.String({ minLength: 1, description: "Element reference from browser_snapshot" })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "Timeout in seconds" })),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      if (params.text === undefined && params.ref === undefined) {
        throw new Error("Provide text or ref so browser_wait knows what to wait for.");
      }
      const outcome = await browserSessions.act({
        ...base,
        action: "wait",
        body: {
          text: params.text === undefined ? undefined : String(params.text),
          ref: params.ref === undefined ? undefined : String(params.ref),
          timeout: params.timeout === undefined ? undefined : Number(params.timeout) * 1_000,
        },
        signal,
      });
      announce("wait", { callId, matched: outcome.matched });
      return textResult(`Waited for the page to be ready (${outcome.durationMs} ms).`, {
        matched: outcome.matched,
        durationMs: outcome.durationMs,
      });
    },
  };

  const screenshot: AgentTool = {
    name: "browser_screenshot",
    label: "browser screenshot",
    description:
      "Capture a PNG of the current page and have it inspected visually. Use it for layout, spacing, colour, " +
      "overlapping elements, responsive behaviour, charts, and images; use browser_snapshot for text and structure. " +
      "Pass a question describing what to check. The image always appears in the chat, and the platform decides " +
      "whether to read it directly or have a vision model describe it.",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole scrollable page instead of the viewport" })),
      question: Type.Optional(
        Type.String({
          maxLength: QUESTION_LIMIT,
          description: "What to check in the screenshot, for example “Is the heading centred and is any text overflowing?”",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const question = inspectionQuestion(params.question);
      const capture = await browserSessions.screenshot({
        ...base,
        runId: context.runId,
        callId,
        fullPage: Boolean(params.fullPage),
        signal,
      });
      announce("screenshot", {
        callId,
        artifactId: capture.artifactId,
        url: safeUrlPreview(capture.url),
        width: capture.width,
        height: capture.height,
        bytes: capture.bytes,
      });

      const caption =
        `Captured ${capture.width}×${capture.height} screenshot of ${capture.url}.` +
        `${capture.truncated ? " The page was taller than the capture limit, so the top was captured." : ""}`;

      const outcome = await context.vision
        .inspect({
          question,
          image: { base64: capture.base64, mimeType: "image/png", bytes: capture.bytes },
          signal,
        })
        .catch((error: unknown) => {
          if (signal?.aborted) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          return {
            decision: "unavailable" as const,
            text:
              `The screenshot could not be analysed: ${reason.slice(0, 300)} ` +
              "It is available in the chat. Use browser_snapshot to reason about the page.",
            structured: false,
            durationMs: 0,
          };
        });

      const details = {
        artifactId: capture.artifactId,
        url: capture.url,
        width: capture.width,
        height: capture.height,
        bytes: capture.bytes,
        fullPage: Boolean(params.fullPage),
        truncated: capture.truncated,
        durationMs: capture.durationMs,
        question,
        primaryModel: context.vision.primaryModelId,
        ...visionDetails(outcome),
      };

      if (outcome.decision === "direct" && outcome.image) {
        context.vision.recordDirectDelivery({ artifactId: capture.artifactId, question });
        return imageResult(
          `${caption}\n\nInspect the attached image and answer: ${question}`,
          { data: outcome.image.base64, mimeType: outcome.image.mimeType },
          details,
        );
      }
      return textResult(`${caption}\n\n${outcome.text}`, details);
    },
  };

  const inspectImage: AgentTool = {
    name: "inspect_image",
    label: "inspect image",
    description:
      "Ask a question about a screenshot that was already captured in this chat, using the artifactId from an " +
      "earlier browser_screenshot result. Use this instead of capturing the same page again. Every call performs " +
      "a fresh inspection.",
    parameters: Type.Object({
      artifactId: Type.String({
        minLength: 1,
        maxLength: 64,
        description: "artifactId from an earlier browser_screenshot result",
      }),
      question: Type.String({
        minLength: 1,
        maxLength: QUESTION_LIMIT,
        description: "What to check in the image, for example “Do the two cards have equal padding?”",
      }),
    }),
    execute: async (callId, params: any, signal) => {
      const artifactId = String(params.artifactId ?? "").trim();
      const question = inspectionQuestion(params.question);
      const image = await loadImageArtifact({ artifactId, chatId: context.chatId });
      const outcome = await context.vision.inspect({ question, image, signal });

      announce("inspect_image", {
        callId,
        artifactId,
        routing: outcome.decision,
        bytes: image.bytes,
      });

      const details = {
        artifactId,
        bytes: image.bytes,
        mimeType: image.mimeType,
        question,
        primaryModel: context.vision.primaryModelId,
        ...visionDetails(outcome),
      };

      if (outcome.decision === "direct" && outcome.image) {
        context.vision.recordDirectDelivery({ artifactId, question });
        return imageResult(
          `Inspecting the stored screenshot ${artifactId}.\n\nInspect the attached image and answer: ${question}`,
          { data: outcome.image.base64, mimeType: outcome.image.mimeType },
          details,
        );
      }
      return textResult(`Inspected the stored screenshot ${artifactId}.\n\n${outcome.text}`, details);
    },
  };

  const consoleTool: AgentTool = {
    name: "browser_console",
    label: "browser console",
    description:
      "Read console messages and page errors collected since the browser opened. " +
      "Pass the cursor from the previous call to continue where you stopped.",
    parameters: Type.Object({
      cursor: Type.Optional(Type.String({ description: "Cursor from the previous browser_console call" })),
      level: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("error"), Type.Literal("warning")], {
          description: "Only return messages at this level. Defaults to all.",
        }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Maximum messages to return" })),
    }),
    execute: async (callId, params: any, signal) => {
      const outcome = await browserSessions.consoleMessages({
        ...base,
        cursor: params.cursor === undefined ? undefined : String(params.cursor),
        level: params.level === undefined ? undefined : String(params.level),
        limit: params.limit === undefined ? undefined : Number(params.limit),
        signal,
      });
      announce("console", { callId, messages: outcome.messages.length, errors: outcome.errors });

      const lines = outcome.messages.map((message: any) => `[${message.level}] ${message.text}`);
      return textResult(
        `${lines.length > 0 ? lines.join("\n") : "(no new console messages)"}\n\n` +
          `cursor: ${outcome.nextCursor}${outcome.remaining > 0 ? ` (${outcome.remaining} more waiting)` : ""}`,
        {
          messages: outcome.messages.length,
          errors: outcome.errors,
          nextCursor: outcome.nextCursor,
          remaining: outcome.remaining,
        },
      );
    },
  };

  const close: AgentTool = {
    name: "browser_close",
    label: "browser close",
    description: "Close this chat's browser and release it. Call this once browser verification is finished.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async (callId) => {
      const closed = await browserSessions.close(context.chatId);
      announce("close", { callId });
      return textResult(closed ? "Closed the browser." : "The browser was not running.", { closed });
    },
  };

  return [navigate, snapshot, click, type, select, press, scroll, wait, screenshot, inspectImage, consoleTool, close];
}
