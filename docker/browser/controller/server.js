import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 4000);
const TOKEN = process.env.BROWSER_CONTROLLER_TOKEN ?? "";
const MAX_TABS = Number(process.env.BROWSER_MAX_TABS ?? 2);
const ACTION_TIMEOUT_MS = Number(process.env.BROWSER_ACTION_TIMEOUT_SECONDS ?? 30) * 1_000;
const NAVIGATION_TIMEOUT_MS = Number(process.env.BROWSER_NAVIGATION_TIMEOUT_SECONDS ?? 60) * 1_000;
const SCREENSHOT_MAX_BYTES = Number(process.env.BROWSER_SCREENSHOT_MAX_BYTES ?? 10_485_760);
const HARD_IDLE_MS = Number(process.env.BROWSER_HARD_IDLE_MINUTES ?? 20) * 60_000;
const VIEWPORT = { width: 1280, height: 800 };
const MAX_CAPTURE_HEIGHT = 16_384;
const CONSOLE_BUFFER_LIMIT = 500;
const SNAPSHOT_ELEMENT_LIMIT = 200;

if (!TOKEN) {
  console.error("BROWSER_CONTROLLER_TOKEN is required");
  process.exit(1);
}

class ControllerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function blockedAddress(address) {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
    if (value.startsWith("::ffff:")) return blockedAddress(value.slice(7));
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

const SECRET_PATTERNS = [
  /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
  /(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',}]+/gi,
  /(\bcookie\s*[:=]\s*)[^\n]*/gi,
  /(\bset-cookie\s*[:=]\s*)[^\n]*/gi,
  /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
];

function redact(text) {
  let value = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, (match, prefix) => (prefix ? `${prefix}[REDACTED]` : "[REDACTED]"));
  }
  return value;
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function collectInteractive(limit) {
  const ROLE_BY_TAG = { a: "link", button: "button", select: "select", textarea: "input", summary: "button" };
  const seen = document.querySelectorAll("[data-aitar-ref]");
  for (const node of seen) node.removeAttribute("data-aitar-ref");

  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase().split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "input";
    }
    return ROLE_BY_TAG[tag] ?? "button";
  };

  const nameOf = (element) => {
    const labelled = element.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    const candidates = [
      element.getAttribute("aria-label"),
      element.labels?.[0]?.textContent,
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("alt"),
      element.tagName.toLowerCase() === "input" ? element.getAttribute("value") : null,
      element.textContent,
      element.getAttribute("name"),
    ];
    for (const candidate of candidates) {
      const text = (candidate ?? "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
    return "";
  };

  const visible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const selector = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=switch]",
    "[role=combobox]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");

  const counters = {};
  const elements = [];
  for (const element of document.querySelectorAll(selector)) {
    if (elements.length >= limit) break;
    if (!visible(element)) continue;
    const role = roleOf(element);
    counters[role] = (counters[role] ?? 0) + 1;
    const ref = `${role}-${counters[role]}`;
    element.setAttribute("data-aitar-ref", ref);
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.getAttribute("type") ?? "text").toLowerCase() : "";
    elements.push({
      ref,
      role,
      name: nameOf(element),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      password: type === "password",
      checked: element.checked === true,
    });
  }

  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);

  const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1_500);

  return {
    title: document.title,
    url: location.href,
    headings,
    bodyText,
    elements,
    truncated: document.querySelectorAll(selector).length > elements.length,
  };
}

class BrowserController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.consoleMessages = [];
    this.consoleSequence = 0;
    this.snapshotGeneration = 0;
    this.snapshotRefs = new Set();
    this.lastActivityAt = Date.now();
    this.appAlias = "";
    this.starting = null;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  async ensure(appAlias) {
    this.touch();
    if (appAlias) this.appAlias = appAlias;
    if (this.context) return this.context;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.browser = await chromium.launch({
        chromiumSandbox: true,
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      this.context = await this.browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: false,
      });
      this.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      this.context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      this.context.on("page", (page) => this.attachPage(page));
      const page = await this.context.newPage();
      this.attachPage(page);
      return this.context;
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  attachPage(page) {
    page.on("console", (message) => this.recordConsole(message.type(), message.text()));
    page.on("pageerror", (error) => this.recordConsole("error", error.message));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.invalidateRefs();
    });
    void this.enforceTabLimit();
  }

  async enforceTabLimit() {
    if (!this.context) return;
    const pages = this.context.pages();
    for (const extra of pages.slice(MAX_TABS)) {
      await extra.close().catch(() => {});
    }
  }

  recordConsole(level, text) {
    this.consoleSequence += 1;
    this.consoleMessages.push({
      sequence: this.consoleSequence,
      level: level === "warning" ? "warning" : level === "error" ? "error" : "info",
      text: redact(text).slice(0, 2_000),
    });
    if (this.consoleMessages.length > CONSOLE_BUFFER_LIMIT) {
      this.consoleMessages.splice(0, this.consoleMessages.length - CONSOLE_BUFFER_LIMIT);
    }
  }

  invalidateRefs() {
    this.snapshotGeneration += 1;
    this.snapshotRefs = new Set();
  }

  async page() {
    const context = await this.ensure();
    const pages = context.pages();
    if (pages.length === 0) {
      const created = await context.newPage();
      this.attachPage(created);
      return created;
    }
    return pages[pages.length - 1];
  }

  async locator(ref) {
    if (typeof ref !== "string" || !/^[a-z]+-\d+$/.test(ref)) {
      throw new ControllerError(400, "invalid_ref", `Reference ${JSON.stringify(String(ref))} is not a valid element reference.`);
    }
    if (!this.snapshotRefs.has(ref)) {
      throw new ControllerError(409, "stale_ref", `Reference ${ref} is no longer valid. Call browser_snapshot to read the current page.`);
    }
    const page = await this.page();
    const locator = page.locator(`[data-aitar-ref="${ref}"]`);
    if ((await locator.count()) === 0) {
      throw new ControllerError(409, "stale_ref", `Reference ${ref} is no longer on the page. Call browser_snapshot to read the current page.`);
    }
    return { page, locator: locator.first() };
  }

  async describe(locator) {
    return locator.evaluate((element) => {
      const candidates = [
        element.getAttribute("aria-label"),
        element.labels?.[0]?.textContent,
        element.getAttribute("placeholder"),
        element.getAttribute("title"),
        element.getAttribute("alt"),
        element.textContent,
        element.getAttribute("name"),
      ];
      let name = "";
      for (const candidate of candidates) {
        const text = (candidate ?? "").replace(/\s+/g, " ").trim();
        if (text) {
          name = text.slice(0, 120);
          break;
        }
      }
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      return {
        role: element.getAttribute("data-aitar-ref")?.split("-")[0] ?? "element",
        name,
        password: element.tagName.toLowerCase() === "input" && type === "password",
      };
    });
  }

  async assertNavigable(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ControllerError(400, "invalid_url", `${rawUrl} is not a valid URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ControllerError(400, "invalid_url", "Only http and https URLs can be opened.");
    }
    if (this.appAlias && parsed.hostname === this.appAlias) return parsed;

    let addresses;
    try {
      addresses = await lookup(parsed.hostname, { all: true });
    } catch {
      throw new ControllerError(502, "dns_failed", `Could not resolve ${parsed.hostname}.`);
    }
    for (const entry of addresses) {
      if (blockedAddress(entry.address)) {
        throw new ControllerError(403, "blocked_host", `${parsed.hostname} resolves to a private address the browser cannot reach.`);
      }
    }
    return parsed;
  }

  async navigate({ url, waitUntil, timeout }) {
    await this.ensure();
    await this.assertNavigable(url);
    const page = await this.page();
    const startedAt = Date.now();
    let timedOut = false;
    let status = null;
    try {
      const response = await page.goto(url, {
        waitUntil: waitUntil ?? "domcontentloaded",
        timeout: Math.min(timeout ?? NAVIGATION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS),
      });
      status = response?.status() ?? null;
    } catch (error) {
      if (!String(error?.message ?? "").toLowerCase().includes("timeout")) throw error;
      timedOut = true;
    }
    this.invalidateRefs();
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      status,
      durationMs: Date.now() - startedAt,
      timedOut,
      summary: await this.summary(page),
    };
  }

  async summary(page) {
    return page
      .evaluate(() => {
        const heading = document.querySelector("h1,h2")?.textContent ?? "";
        const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
        return { heading: heading.replace(/\s+/g, " ").trim().slice(0, 120), text: text.slice(0, 400) };
      })
      .catch(() => ({ heading: "", text: "" }));
  }

  async snapshot() {
    const page = await this.page();
    const result = await page.evaluate(collectInteractive, SNAPSHOT_ELEMENT_LIMIT);
    this.snapshotGeneration += 1;
    this.snapshotRefs = new Set(result.elements.map((element) => element.ref));
    return result;
  }

  async click({ ref }) {
    const { page, locator } = await this.locator(ref);
    const described = await this.describe(locator);
    const before = page.url();
    const startedAt = Date.now();
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    const after = page.url();
    return {
      element: described,
      url: after,
      navigated: before !== after,
      durationMs: Date.now() - startedAt,
    };
  }

  async type({ ref, text, clear, submit }) {
    const { page, locator } = await this.locator(ref);
    const described = await this.describe(locator);
    const startedAt = Date.now();
    if (clear) await locator.fill("", { timeout: ACTION_TIMEOUT_MS });
    await locator.fill(String(text), { timeout: ACTION_TIMEOUT_MS });
    let navigated = false;
    const before = page.url();
    if (submit) {
      await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
      await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
      navigated = page.url() !== before;
    }
    return {
      element: described,
      url: page.url(),
      navigated,
      characters: String(text).length,
      durationMs: Date.now() - startedAt,
    };
  }

  async select({ ref, values }) {
    const { locator } = await this.locator(ref);
    const described = await this.describe(locator);
    const startedAt = Date.now();
    const selected = await locator.selectOption(values.map(String), { timeout: ACTION_TIMEOUT_MS });
    return { element: described, selected, durationMs: Date.now() - startedAt };
  }

  async press({ key }) {
    const page = await this.page();
    const startedAt = Date.now();
    const before = page.url();
    await page.keyboard.press(String(key));
    await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    return { key: String(key), url: page.url(), navigated: page.url() !== before, durationMs: Date.now() - startedAt };
  }

  async scroll({ direction, amount }) {
    const page = await this.page();
    const distance = Number.isFinite(amount) && amount > 0 ? Math.min(Number(amount), 20_000) : null;
    const startedAt = Date.now();
    const moved = await page.evaluate(
      ({ direction, distance, viewport }) => {
        const step = distance ?? (direction === "left" || direction === "right" ? viewport.width : viewport.height);
        const before = { x: window.scrollX, y: window.scrollY };
        const delta = {
          up: [0, -step],
          down: [0, step],
          left: [-step, 0],
          right: [step, 0],
        }[direction] ?? [0, step];
        window.scrollBy(delta[0], delta[1]);
        return { x: window.scrollX, y: window.scrollY, movedX: window.scrollX - before.x, movedY: window.scrollY - before.y };
      },
      { direction, distance, viewport: VIEWPORT },
    );
    return { direction, ...moved, durationMs: Date.now() - startedAt };
  }

  async wait({ text, ref, timeout }) {
    const page = await this.page();
    const budget = Math.min(timeout ?? ACTION_TIMEOUT_MS, ACTION_TIMEOUT_MS * 4);
    const startedAt = Date.now();
    if (ref) {
      const { locator } = await this.locator(ref);
      await locator.waitFor({ state: "visible", timeout: budget });
      return { matched: "ref", durationMs: Date.now() - startedAt };
    }
    await page.getByText(String(text), { exact: false }).first().waitFor({ state: "visible", timeout: budget });
    return { matched: "text", durationMs: Date.now() - startedAt };
  }

  async screenshot({ fullPage }) {
    const page = await this.page();
    const startedAt = Date.now();
    let clip;
    if (fullPage) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
      if (height > MAX_CAPTURE_HEIGHT) {
        clip = { x: 0, y: 0, width: VIEWPORT.width, height: MAX_CAPTURE_HEIGHT };
      }
    }
    const buffer = await page.screenshot({
      type: "png",
      scale: "css",
      animations: "disabled",
      caret: "hide",
      timeout: ACTION_TIMEOUT_MS,
      ...(clip ? { clip } : { fullPage: Boolean(fullPage) }),
    });
    if (buffer.length > SCREENSHOT_MAX_BYTES) {
      throw new ControllerError(413, "screenshot_too_large", `The screenshot is ${buffer.length} bytes, over the ${SCREENSHOT_MAX_BYTES} byte limit.`);
    }
    const { width, height } = pngDimensions(buffer);
    return {
      data: buffer.toString("base64"),
      width,
      height,
      bytes: buffer.length,
      url: page.url(),
      truncated: Boolean(clip),
      durationMs: Date.now() - startedAt,
    };
  }

  consoleSince({ cursor, level, limit }) {
    const after = Number(cursor ?? 0);
    const wanted = level && level !== "all" ? level : null;
    const filtered = this.consoleMessages.filter(
      (message) => message.sequence > after && (!wanted || message.level === wanted),
    );
    const bounded = filtered.slice(0, Math.min(Number(limit) || 50, 200));
    return {
      messages: bounded,
      nextCursor: String(bounded.length > 0 ? bounded[bounded.length - 1].sequence : after),
      remaining: filtered.length - bounded.length,
      errors: this.consoleMessages.filter((message) => message.level === "error").length,
    };
  }

  async shutdown() {
    const context = this.context;
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    if (context) {
      for (const page of context.pages()) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
  }
}

const controller = new BrowserController();

const ROUTES = {
  "/session": async (body) => {
    await controller.ensure(String(body.appAlias ?? ""));
    return { ready: true, maxTabs: MAX_TABS };
  },
  "/navigate": (body) => controller.navigate(body),
  "/snapshot": () => controller.snapshot(),
  "/click": (body) => controller.click(body),
  "/type": (body) => controller.type(body),
  "/select": (body) => controller.select(body),
  "/press": (body) => controller.press(body),
  "/scroll": (body) => controller.scroll(body),
  "/wait": (body) => controller.wait(body),
  "/screenshot": (body) => controller.screenshot(body),
  "/console": (body) => controller.consoleSince(body),
  "/health": () => ({ ready: Boolean(controller.context), lastActivityAt: controller.lastActivityAt }),
  "/close": async () => {
    await controller.shutdown();
    return { closed: true };
  },
};

function authorized(request) {
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(TOKEN);
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new ControllerError(413, "body_too_large", "Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ControllerError(400, "invalid_json", "Request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

const server = createServer((request, response) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  };

  void (async () => {
    try {
      if (!authorized(request)) return send(401, { error: { code: "unauthorized", message: "Invalid controller token." } });
      const route = ROUTES[request.url ?? ""];
      if (!route) return send(404, { error: { code: "unknown_action", message: "Unknown controller action." } });
      if (request.method !== "POST" && request.url !== "/health") {
        return send(405, { error: { code: "method_not_allowed", message: "Controller actions use POST." } });
      }
      const body = await readBody(request);
      controller.touch();
      send(200, await route(body));
    } catch (error) {
      const status = error instanceof ControllerError ? error.status : 500;
      const code = error instanceof ControllerError ? error.code : "action_failed";
      send(status, { error: { code, message: redact(error?.message ?? "Browser action failed.") } });
    }
  })();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "browser controller listening", port: PORT }));
});

const idleTimer = setInterval(() => {
  if (Date.now() - controller.lastActivityAt > HARD_IDLE_MS) {
    void controller.shutdown().finally(() => process.exit(0));
  }
}, 60_000);
idleTimer.unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close();
    void controller.shutdown().finally(() => process.exit(0));
  });
}
