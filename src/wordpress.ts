import { AxiError } from "axi-sdk-js";
import { redact, type WordPressConfig } from "./lib/config.js";
import { normalizeRoute, routeUrl } from "./lib/routes.js";

/**
 * Typed WordPress API error. Extends AxiError (so SDK error rendering and
 * exit codes are unchanged) while preserving the upstream `code` and any
 * structured `data` payload - e.g. `term_exists` carries the conflicting
 * term_id, which commands use for idempotent create handling.
 */
export class WpApiError extends AxiError {
  readonly wpCode: string;
  readonly payload: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    suggestions: string[],
    wpCode: string,
    payload: Record<string, unknown> = {},
  ) {
    super(message, code, suggestions);
    this.name = "WpApiError";
    this.wpCode = wpCode;
    this.payload = payload;
  }
}

/**
 * WordPress REST API client. One class, no runtime dependencies beyond Node's
 * global fetch. Authenticates with HTTP Basic over the configured site origin
 * using a dedicated user's Application Password.
 *
 * Behavior:
 * - List responses carry X-WP-Total / X-WP-TotalPages headers; both are
 *   surfaced as `meta` so commands can pre-compute aggregates (AXI
 *   principle 4) without a second round trip.
 * - Errors are mapped to typed AxiErrors with next-step suggestions
 *   (principle 6). WordPress errors look like { code, message, data.status }.
 * - All error text is scrubbed through redact() so the Application Password
 *   can never appear in output.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export type FetchLike = typeof fetch;

export interface WpMeta {
  status: number;
  total?: number;
  totalPages?: number;
}

export interface WpResult<T = unknown> {
  data: T;
  meta: WpMeta;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serializable request body (POST/PUT/PATCH). */
  body?: unknown;
  /** Raw binary body with explicit headers (media uploads). */
  raw?: { body: Uint8Array; contentType: string; disposition?: string };
  /** Replace the Basic Authorization header entirely (no-auth requests). */
  anonymous?: boolean;
}

export class WordPressClient {
  private readonly config: WordPressConfig;
  private readonly fetchImpl: FetchLike;
  private readonly authToken: string;

  constructor(options: {
    config: WordPressConfig;
    fetchImpl?: FetchLike;
    /** Precomputed Basic token override (tests). */
    authToken?: string;
  }) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authToken =
      options.authToken ??
      Buffer.from(`${options.config.username}:${options.config.applicationPassword}`).toString(
        "base64",
      );
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Perform one REST request and return the parsed body plus pagination
   * metadata. Route may use the `wp/v2/` shorthand or a full namespace.
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    options: RequestOptions = {},
  ): Promise<WpResult<T>> {
    const normalized = normalizeRoute(route);
    const url = new URL(routeUrl(this.config.baseUrl, normalized));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (!options.anonymous) {
      headers["Authorization"] = `Basic ${this.authToken}`;
    }
    let body: RequestInit["body"];
    if (options.raw) {
      headers["Content-Type"] = options.raw.contentType;
      if (options.raw.disposition) headers["Content-Disposition"] = options.raw.disposition;
      body = options.raw.body as unknown as RequestInit["body"];
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AxiError(
        `Could not reach the WordPress REST API at ${this.config.baseUrl}: ${redact(message, this.config.applicationPassword)}`,
        "NETWORK_ERROR",
        [
          "Check WORDPRESS_URL, network connectivity, and that REST access is not blocked",
          "Some hosts relocate or disable the API; verify {WORDPRESS_URL}/wp-json/ loads",
        ],
      );
    }

    const meta: WpMeta = { status: response.status };
    const total = response.headers.get("x-wp-total");
    const totalPages = response.headers.get("x-wp-totalpages");
    if (total !== null && /^\d+$/.test(total)) meta.total = Number(total);
    if (totalPages !== null && /^\d+$/.test(totalPages)) meta.totalPages = Number(totalPages);

    if (!response.ok) {
      throw await this.httpError(response, method, normalized || "/");
    }

    const text = await response.text();
    if (text.length === 0) {
      return { data: undefined as T, meta };
    }
    try {
      return { data: JSON.parse(text) as T, meta };
    } catch {
      throw new AxiError(
        `unexpected non-JSON response from /${normalized} (HTTP ${response.status})`,
        "NETWORK_ERROR",
        ["The site may be returning an HTML error or login page at the REST route"],
      );
    }
  }

  /**
   * Fetch one page of a collection. WordPress caps per_page at 100 and
   * reports the full match count in X-WP-Total.
   */
  async list<T = unknown>(
    route: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<WpResult<T[]>> {
    const result = await this.request<T[]>("GET", route, {
      query: { per_page: 100, ...query },
    });
    const data = Array.isArray(result.data) ? result.data : [];
    return { data, meta: result.meta };
  }

  private async httpError(response: Response, method: string, route: string): Promise<AxiError> {
    const text = await response.text();
    let code = "http_error";
    let message = `${method} /${route} failed with HTTP ${response.status}`;
    let dataStatus = response.status;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as {
        code?: unknown;
        message?: unknown;
        data?: { status?: unknown; params?: unknown; term_id?: unknown };
      };
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.message === "string" && parsed.message.length > 0) message = parsed.message;
      if (typeof parsed.data?.status === "number") dataStatus = parsed.data.status;
      if (parsed.data !== null && typeof parsed.data === "object") {
        payload = parsed.data as Record<string, unknown>;
      }
    } catch {
      // Non-JSON error body (proxy page, HTML error): keep the status message.
    }

    const clean = (input: string): string =>
      redact(input.length > 300 ? `${input.slice(0, 300)}\u2026` : input, this.config.applicationPassword);

    const typed = (
      error: AxiError,
    ): AxiError =>
      error instanceof WpApiError
        ? error
        : new WpApiError(error.message, error.code, error.suggestions, code, payload);

    if (response.status === 401 || dataStatus === 401) {
      return typed(
        new AxiError(`Authentication failed: ${clean(message)}`, "AUTH_REQUIRED", [
          "Verify WORDPRESS_USERNAME and WORDPRESS_APPLICATION_PASSWORD",
          "Application Passwords are created under Users > Profile in wp-admin",
          "Run `wordpress-axi me` to test credentials",
        ]),
      );
    }
    if (response.status === 403 || dataStatus === 403) {
      return typed(
        new AxiError(`Forbidden: ${clean(message)}`, "FORBIDDEN", [
          "The authenticated user lacks the capability for this operation",
          "Use a user with the minimum role that allows the action, or run `wordpress-axi me` to inspect roles",
        ]),
      );
    }
    if (response.status === 404 || dataStatus === 404) {
      return typed(
        new AxiError(`Not found: ${clean(message)}`, "NOT_FOUND", [
          "Check the ID, or run `wordpress-axi discover` to list available routes and types",
          "A 404 can also mean permalinks or web-server routing hide the REST API",
        ]),
      );
    }
    if (response.status === 429) {
      return typed(
        new AxiError(`Rate limited: ${clean(message)}`, "RATE_LIMITED", [
          "A security plugin or host firewall is throttling requests - wait and re-run",
        ]),
      );
    }
    if (response.status >= 500) {
      return typed(
        new AxiError(
          `WordPress server error (HTTP ${response.status}): ${clean(message)}`,
          "SERVER_ERROR",
          ["Re-run the command - transient server errors usually clear"],
        ),
      );
    }
    return typed(
      new AxiError(`WordPress API error (${code}): ${clean(message)}`, "API_ERROR", [
        "Run `wordpress-axi <command> --help` for accepted flags",
        "Run `wordpress-axi discover` to inspect routes and types",
      ]),
    );
  }
}
