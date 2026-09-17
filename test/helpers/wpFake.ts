import { createCommandContext, type CommandContext } from "../../src/context.js";
import type { FetchLike } from "../../src/wordpress.js";

/**
 * Fixture-backed fake WordPress REST API for tests: zero network, real
 * Response objects. IDs and slugs are obviously fake - never real data.
 */

export const TEST_ENV = {
  WORDPRESS_URL: "https://test.example",
  WORDPRESS_USERNAME: "api-user",
  WORDPRESS_APPLICATION_PASSWORD: "abcd efgh ijkl mnop",
};

export interface FakeCall {
  method: string;
  route: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FakeRoute {
  method: string;
  /** Exact route after /wp-json/ (query excluded). */
  route: string;
  respond: (context: { query: URLSearchParams; body: unknown }) => FakeResponse;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: FakeCall[];
}

export function createFakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const match = /^\/wp-json\/(.*)$/.exec(url.pathname);
    const route = match?.[1] ?? url.pathname.replace(/^\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let parsed: unknown;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    } else if (init?.body instanceof Uint8Array) {
      parsed = `<${init.body.byteLength} bytes>`;
    }
    calls.push({ method, route, query: url.searchParams, body: parsed, headers });

    const found = routes.find((candidate) => candidate.method === method && candidate.route === route);
    if (!found) {
      return jsonResponse(404, {
        code: "rest_no_route",
        message: `No test route for ${method} /${route}`,
        data: { status: 404 },
      });
    }
    const result = found.respond({ query: url.searchParams, body: parsed });
    return jsonResponse(result.status ?? 200, result.body ?? {}, result.headers);
  };
  return { fetch, calls };
}

/** Context with fake auth env and the given routes. */
export function contextFor(routes: FakeRoute[]): FakeContext {
  const fake = createFakeFetch(routes);
  const ctx = createCommandContext(TEST_ENV, { fetchImpl: fake.fetch });
  return { ctx, calls: fake.calls };
}

export interface FakeContext {
  ctx: CommandContext;
  calls: FakeCall[];
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...headers },
  });
}

/** Build one page of a WP collection with X-WP-Total headers. */
export function collection(items: unknown[], total = items.length): FakeResponse {
  return {
    body: items,
    headers: { "X-WP-Total": String(total), "X-WP-TotalPages": String(Math.max(1, Math.ceil(total / 100))) },
  };
}

/** A representative post row as WordPress returns it (view context). */
export function postRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    date: "2026-03-01T10:30:00",
    modified: "2026-03-02T08:00:00",
    slug: "hello-world",
    status: "publish",
    link: "https://test.example/2026/03/hello-world/",
    title: { rendered: "Hello <em>world</em>" },
    content: {
      rendered: "<p>This is the full content of the post.</p>\n<p>Second paragraph with more text to make the content long enough to be meaningful in truncation tests. ".repeat(20) + "</p>",
      protected: false,
    },
    excerpt: { rendered: "<p>This is the excerpt.</p>" },
    author: 1,
    featured_media: 0,
    categories: [4],
    tags: [9],
    ...overrides,
  };
}

export const API_INDEX = {
  name: "Test Site",
  description: "A site used by automated tests",
  url: "https://test.example",
  home: "https://test.example",
  namespaces: ["wp/v2", "wp-site-health/v1"],
  authentication: [],
  routes: {},
};
