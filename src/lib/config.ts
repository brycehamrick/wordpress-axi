import { AxiError } from "axi-sdk-js";

/**
 * Configuration for the WordPress REST API client.
 *
 * Security posture carried over from the original Python helper:
 * - WORDPRESS_URL must be an absolute http(s) URL; plain HTTP is allowed only
 *   for loopback development hosts.
 * - Credentials come exclusively from the environment, never argv or files.
 * - All error text is scrubbed through redact() so the Application Password
 *   can never appear in output even if an upstream error echoed it.
 */

export interface WordPressConfig {
  baseUrl: string;
  username: string;
  applicationPassword: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Redact anything that looks like a credential from error text. */
export function redact(text: string, secret?: string): string {
  let out = text.replace(/\bBasic\s+([A-Za-z0-9._~+/=-]{16,})\b/g, "Basic ***");
  // Application Passwords are displayed in four-char space-separated groups.
  out = out.replace(/[A-Za-z0-9]{4}( [A-Za-z0-9]{4}){2,5}/g, "*** **** ****");
  if (secret && secret.length >= 4) {
    out = out.split(secret).join("***");
  }
  return out;
}

export class MissingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingConfigError";
  }
}

/** Validate a user-supplied site URL. Exported for tests. */
export function validateSiteUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AxiError(
      `WORDPRESS_URL is not a valid URL: ${redact(raw)}`,
      "VALIDATION_ERROR",
      ["Set WORDPRESS_URL=https://example.com (site origin, without /wp-json)"],
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AxiError(
      `WORDPRESS_URL must use http or https, got protocol ${parsed.protocol}`,
      "VALIDATION_ERROR",
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""))
  ) {
    throw new AxiError(
      "WORDPRESS_URL must use HTTPS (HTTP is allowed only for loopback development)",
      "VALIDATION_ERROR",
      [
        "Application Passwords sent over plain HTTP can be intercepted",
        "Set WORDPRESS_URL=https://... or use http://localhost for local development",
      ],
    );
  }
  if (parsed.username || parsed.password) {
    throw new AxiError(
      "WORDPRESS_URL must not contain embedded credentials",
      "VALIDATION_ERROR",
      ["Pass the username and Application Password via WORDPRESS_USERNAME and WORDPRESS_APPLICATION_PASSWORD"],
    );
  }
  if (trimmed.endsWith("/wp-json")) {
    throw new AxiError(
      "WORDPRESS_URL must be the site origin without the /wp-json suffix",
      "VALIDATION_ERROR",
    );
  }
  return trimmed;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): WordPressConfig {
  const rawUrl = env["WORDPRESS_URL"]?.trim() ?? "";
  if (rawUrl.length === 0) {
    throw new MissingConfigError(
      "WORDPRESS_URL is required - set it to your WordPress site origin",
    );
  }
  const baseUrl = validateSiteUrl(rawUrl);

  const username = env["WORDPRESS_USERNAME"]?.trim() ?? "";
  const password = env["WORDPRESS_APPLICATION_PASSWORD"]?.trim() ?? "";
  if (username.length === 0 || password.length === 0) {
    throw new MissingConfigError(
      "WORDPRESS_USERNAME and WORDPRESS_APPLICATION_PASSWORD are required",
    );
  }
  return { baseUrl, username, applicationPassword: password };
}
