import { describe, expect, it } from "vitest";
import { WordPressClient, WpApiError } from "../src/wordpress.js";
import { AxiError } from "axi-sdk-js";
import { createFakeFetch, TEST_ENV, type FakeRoute } from "./helpers/wpFake.js";
import { resolveConfig } from "../src/lib/config.js";

function clientWith(routes: FakeRoute[]): { client: WordPressClient; calls: ReturnType<typeof createFakeFetch>["calls"] } {
  const fake = createFakeFetch(routes);
  const client = new WordPressClient({ config: resolveConfig(TEST_ENV), fetchImpl: fake.fetch });
  return { client, calls: fake.calls };
}

const config = resolveConfig(TEST_ENV);

describe("WordPressClient", () => {
  it("sends Basic auth with the username and application password", async () => {
    const { client, calls } = clientWith([
      {
        method: "GET",
        route: "wp/v2/posts",
        respond: () => ({ body: [] }),
      },
    ]);
    await client.list("wp/v2/posts");
    expect(calls).toHaveLength(1);
    const expected = Buffer.from(`${config.username}:${config.applicationPassword}`).toString("base64");
    expect(calls[0]?.headers["Authorization"]).toBe(`Basic ${expected}`);
  });

  it("defaults lists to per_page=100 and parses X-WP-Total", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        route: "wp/v2/posts",
        respond: () => ({
          body: [{ id: 1 }],
          headers: { "X-WP-Total": "87", "X-WP-TotalPages": "5" },
        }),
      },
    ]);
    const result = await client.list("wp/v2/posts", { per_page: 10, status: "publish" });
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.meta).toEqual({ status: 200, total: 87, totalPages: 5 });
  });

  it("maps 401 to AUTH_REQUIRED with credential suggestions", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        route: "wp/v2/users/me",
        respond: () => ({
          status: 401,
          body: { code: "rest_forbidden", message: "Sorry, you are not allowed to do that.", data: { status: 401 } },
        }),
      },
    ]);
    const error = await client.request("GET", "wp/v2/users/me").catch((e) => e);
    expect(error).toBeInstanceOf(AxiError);
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.suggestions.join(" ")).toContain("WORDPRESS_USERNAME");
  });

  it("maps 403 to FORBIDDEN and 404 to NOT_FOUND", async () => {
    const forbidden = clientWith([
      {
        method: "GET",
        route: "wp/v2/settings",
        respond: () => ({ status: 403, body: { code: "rest_forbidden_context", message: "forbidden", data: { status: 403 } } }),
      },
    ]).client;
    await expect(forbidden.request("GET", "wp/v2/settings")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const missing = clientWith([
      {
        method: "GET",
        route: "wp/v2/posts/9999",
        respond: () => ({ status: 404, body: { code: "rest_post_invalid_id", message: "Invalid post ID.", data: { status: 404 } } }),
      },
    ]).client;
    await expect(missing.request("GET", "wp/v2/posts/9999")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves the upstream code and data payload for term_exists", async () => {
    const { client } = clientWith([
      {
        method: "POST",
        route: "wp/v2/categories",
        respond: () => ({
          status: 400,
          body: {
            code: "term_exists",
            message: "A term with the name provided already exists in this taxonomy.",
            data: { status: 400, term_id: 7 },
          },
        }),
      },
    ]);
    const error = await client.request("POST", "wp/v2/categories", { body: { name: "News" } }).catch((e) => e);
    expect(error).toBeInstanceOf(WpApiError);
    expect(error.wpCode).toBe("term_exists");
    expect(error.payload["term_id"]).toBe(7);
  });

  it("never leaks the application password in network errors", async () => {
    const fake = createFakeFetch([]);
    const failing = async () => {
      throw new Error(`connect ECONNREFUSED with token ${TEST_ENV.WORDPRESS_APPLICATION_PASSWORD}`);
    };
    const client = new WordPressClient({ config, fetchImpl: failing as unknown as typeof fetch });
    const error = await client.request("GET", "wp/v2/posts").catch((e) => e);
    expect(error).toBeInstanceOf(AxiError);
    expect(error.code).toBe("NETWORK_ERROR");
    expect(String(error.message)).not.toContain(TEST_ENV.WORDPRESS_APPLICATION_PASSWORD);
    void fake;
  });

  it("sends JSON bodies with the right content type", async () => {
    const { client, calls } = clientWith([
      { method: "POST", route: "wp/v2/posts", respond: () => ({ body: { id: 5, status: "draft" } }) },
    ]);
    await client.request("POST", "wp/v2/posts", { body: { title: "Hello", status: "draft" } });
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ title: "Hello", status: "draft" });
  });

  it("sends raw upload payloads with content type and disposition", async () => {
    const { client, calls } = clientWith([
      { method: "POST", route: "wp/v2/media", respond: () => ({ body: { id: 91 } }) },
    ]);
    const bytes = new Uint8Array([1, 2, 3]);
    await client.request("POST", "wp/v2/media", {
      raw: { body: bytes, contentType: "image/png", disposition: "attachment; filename=\"x.png\"" },
    });
    expect(calls[0]?.headers["Content-Type"]).toBe("image/png");
    expect(calls[0]?.headers["Content-Disposition"]).toBe("attachment; filename=\"x.png\"");
  });

  it("expands shorthand routes in requests", async () => {
    const { client, calls } = clientWith([
      { method: "GET", route: "wp/v2/posts/42", respond: () => ({ body: { id: 42 } }) },
    ]);
    await client.request("GET", "posts/42");
    expect(calls[0]?.route).toBe("wp/v2/posts/42");
  });
});
