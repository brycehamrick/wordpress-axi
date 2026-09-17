import { describe, expect, it } from "vitest";
import { MissingConfigError, redact, resolveConfig, validateSiteUrl } from "../src/lib/config.js";
import { normalizeRoute } from "../src/lib/routes.js";
import { AxiError } from "axi-sdk-js";

/**
 * Ports of the original Python helper's unit tests, plus the new rules:
 * embedded credentials in the URL, the /wp-json suffix, and credential
 * redaction.
 */

describe("config validation", () => {
  const valid = {
    WORDPRESS_URL: "https://test.example",
    WORDPRESS_USERNAME: "user",
    WORDPRESS_APPLICATION_PASSWORD: "secret",
  };

  it("requires WORDPRESS_URL", () => {
    expect(() => resolveConfig({})).toThrow(MissingConfigError);
    expect(() => resolveConfig({})).toThrow(/WORDPRESS_URL/);
  });

  it("requires username and application password", () => {
    expect(() =>
      resolveConfig({ WORDPRESS_URL: "https://test.example" }),
    ).toThrow(MissingConfigError);
    expect(() =>
      resolveConfig({ WORDPRESS_URL: "https://test.example", WORDPRESS_USERNAME: "user" }),
    ).toThrow(/WORDPRESS_APPLICATION_PASSWORD/);
  });

  it("builds the full config when all variables are set", () => {
    const config = resolveConfig(valid);
    expect(config).toEqual({
      baseUrl: "https://test.example",
      username: "user",
      applicationPassword: "secret",
    });
  });

  it("rejects remote plain HTTP", () => {
    expect(() => validateSiteUrl("http://test.example")).toThrow(AxiError);
    expect(() => validateSiteUrl("http://test.example")).toThrow(/HTTPS/);
  });

  it("allows loopback HTTP for local development", () => {
    expect(validateSiteUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(validateSiteUrl("http://localhost")).toBe("http://localhost");
  });

  it("strips trailing slashes", () => {
    expect(validateSiteUrl("https://test.example/")).toBe("https://test.example");
    expect(validateSiteUrl("https://test.example///")).toBe("https://test.example");
  });

  it("rejects embedded credentials", () => {
    expect(() => validateSiteUrl("https://user:pass@test.example")).toThrow(/embedded credentials/);
  });

  it("rejects the /wp-json suffix", () => {
    expect(() => validateSiteUrl("https://test.example/wp-json")).toThrow(/wp-json/);
  });

  it("rejects non-http schemes", () => {
    expect(() => validateSiteUrl("ftp://test.example")).toThrow(AxiError);
  });
});

describe("route normalization", () => {
  it("expands common resources to wp/v2", () => {
    expect(normalizeRoute("posts")).toBe("wp/v2/posts");
    expect(normalizeRoute("posts/42")).toBe("wp/v2/posts/42");
    expect(normalizeRoute("media")).toBe("wp/v2/media");
  });

  it("preserves custom namespaces", () => {
    expect(normalizeRoute("woocommerce/v1/products")).toBe("woocommerce/v1/products");
    expect(normalizeRoute("/acf/v3/fields")).toBe("acf/v3/fields");
  });

  it("strips the wp-json prefix and leading slash", () => {
    expect(normalizeRoute("wp-json/wp/v2/posts")).toBe("wp/v2/posts");
    expect(normalizeRoute("/wp/v2/posts")).toBe("wp/v2/posts");
  });

  it("rejects absolute URLs", () => {
    expect(() => normalizeRoute("https://attacker.example/api")).toThrow(AxiError);
    expect(() => normalizeRoute("http://attacker.example/api")).toThrow(/relative/);
  });
});

describe("redaction", () => {
  it("scrubs Basic tokens", () => {
    const out = redact("Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZDEyMzQ1Njc4");
    expect(out).toContain("Basic ***");
  });

  it("scrubs space-grouped application passwords", () => {
    const out = redact("password abcd efgh ijkl mnop was leaked");
    expect(out).not.toContain("abcd efgh ijkl mnop");
  });

  it("scrubs the exact secret when known", () => {
    const out = redact("echo secret-value back", "secret-value");
    expect(out).not.toContain("secret-value");
  });
});
