import { describe, expect, it } from "vitest";
import {
  AGENT_NETWORK_ALIAS,
  BrowserUrlError,
  displayUrlFor,
  isBlockedAddress,
  isBlockedHostname,
  isLocalHostname,
  prepareNavigation,
} from "../browser-url.js";

describe("localhost translation", () => {
  it("sends localhost to the chat container alias while the chat keeps the original URL", () => {
    const prepared = prepareNavigation("http://localhost:3000/dashboard?tab=1");
    expect(prepared.requestUrl).toBe(`http://${AGENT_NETWORK_ALIAS}:3000/dashboard?tab=1`);
    expect(prepared.displayUrl).toBe("http://localhost:3000/dashboard?tab=1");
    expect(prepared.translated).toBe(true);
  });

  it("translates every loopback spelling the agent might use", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "127.0.0.5", "app.localhost", "[::1]"]) {
      const prepared = prepareNavigation(`http://${host}:8080/`);
      expect(new URL(prepared.requestUrl).hostname, host).toBe(AGENT_NETWORK_ALIAS);
      expect(prepared.translated, host).toBe(true);
    }
  });

  it("keeps the port, path, query, and scheme when translating", () => {
    const prepared = prepareNavigation("https://localhost:8443/a/b?x=1#top");
    expect(prepared.requestUrl).toBe(`https://${AGENT_NETWORK_ALIAS}:8443/a/b?x=1#top`);
  });

  it("leaves public URLs alone", () => {
    const prepared = prepareNavigation("https://example.com/docs");
    expect(prepared.requestUrl).toBe("https://example.com/docs");
    expect(prepared.translated).toBe(false);
  });

  it("adds a scheme when the agent omits one", () => {
    expect(prepareNavigation("localhost:3000").requestUrl).toBe(`http://${AGENT_NETWORK_ALIAS}:3000/`);
  });

  it("turns a sidecar URL back into the localhost form for the chat", () => {
    expect(displayUrlFor(`http://${AGENT_NETWORK_ALIAS}:3000/login`, "http://localhost:3000/")).toBe(
      "http://localhost:3000/login",
    );
    expect(displayUrlFor("https://example.com/a", "https://example.com/")).toBe("https://example.com/a");
  });

  it("never leaks the container alias when the original URL is unknown", () => {
    const alias = `http://${AGENT_NETWORK_ALIAS}:3000/dashboard`;
    for (const original of [alias, "", "not a url"]) {
      expect(displayUrlFor(alias, original), original).toBe("http://localhost:3000/dashboard");
    }
    expect(displayUrlFor(alias, alias)).not.toContain(AGENT_NETWORK_ALIAS);
  });
});

describe("URL validation", () => {
  it("rejects schemes that are not http or https", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<h1>x", "javascript:alert(1)", "ftp://example.com"]) {
      expect(() => prepareNavigation(url), url).toThrow(BrowserUrlError);
    }
  });

  it("rejects cloud metadata, the host gateway, and private ranges", () => {
    for (const host of [
      "169.254.169.254",
      "metadata.google.internal",
      "host.docker.internal",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "100.64.0.1",
      "consul.service.internal",
      "printer.local",
    ]) {
      expect(() => prepareNavigation(`http://${host}/`), host).toThrow(BrowserUrlError);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => prepareNavigation("https://user:secret@example.com/")).toThrow(BrowserUrlError);
  });

  it("rejects an empty or unparseable URL", () => {
    expect(() => prepareNavigation("")).toThrow(BrowserUrlError);
    expect(() => prepareNavigation("http://")).toThrow(BrowserUrlError);
  });

  it("classifies addresses without misreading public ones as private", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("notlocalhost.com")).toBe(false);
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});
