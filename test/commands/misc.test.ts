import { afterAll, describe, expect, it } from "vitest";
import { mediaCommand } from "../../src/commands/media.js";
import { commentCommand } from "../../src/commands/comment.js";
import { userCommand, meCommand } from "../../src/commands/user.js";
import { searchCommand } from "../../src/commands/search.js";
import { settingsCommand } from "../../src/commands/settings.js";
import { pluginCommand } from "../../src/commands/plugin.js";
import { themeCommand } from "../../src/commands/theme.js";
import { discoverCommand } from "../../src/commands/discover.js";
import { requestCommand } from "../../src/commands/request.js";
import { homeCommand } from "../../src/commands/home.js";
import { API_INDEX, collection, contextFor } from "../helpers/wpFake.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dirname, "tmp-media");

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("media command", () => {
  it("uploads binary with RFC 5987 disposition then patches metadata", async () => {
    mkdirSync(TMP, { recursive: true });
    const file = join(TMP, "h\u00e9ro image.png");
    writeFileSync(file, Buffer.from([137, 80, 78, 71]));

    const { ctx, calls } = contextFor([
      {
        method: "POST",
        route: "wp/v2/media",
        respond: () => ({ body: { id: 91, mime_type: "image/png", source_url: "https://test.example/wp-content/uploads/hero.png", title: { rendered: "" } } }),
      },
      {
        method: "POST",
        route: "wp/v2/media/91",
        respond: () => ({ body: { id: 91, alt_text: "Team at the offsite", title: { rendered: "Team offsite" }, source_url: "https://test.example/wp-content/uploads/hero.png" } }),
      },
    ]);
    const out = (await mediaCommand(
      ["upload", file, "--title", "Team offsite", "--alt", "Team at the offsite"],
      ctx,
    )) as Record<string, unknown>;
    const uploaded = out["uploaded"] as Record<string, unknown>;
    expect(uploaded["id"]).toBe(91);
    expect(uploaded["alt_text"]).toBe("Team at the offsite");

    const uploadCall = calls.find((c) => c.route === "wp/v2/media" && c.method === "POST");
    expect(uploadCall?.headers["Content-Type"]).toBe("image/png");
    expect(uploadCall?.headers["Content-Disposition"]).toContain("filename*=");
    expect(decodeURIComponent(uploadCall?.headers["Content-Disposition"] ?? "")).toContain("h\u00e9ro image.png");

    const patchCall = calls.find((c) => c.route === "wp/v2/media/91");
    expect(patchCall?.body).toMatchObject({ title: "Team offsite", alt_text: "Team at the offsite" });
  });

  it("requires --confirm for permanent deletes", async () => {
    const { ctx, calls } = contextFor([
      { method: "DELETE", route: "wp/v2/media/91", respond: () => ({ body: { deleted: true, previous: { id: 91 } } }) },
    ]);
    await expect(mediaCommand(["delete", "91"], ctx)).rejects.toThrow(/--confirm/);
    await mediaCommand(["delete", "91", "--confirm"], ctx);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.query.get("force")).toBe("true");
  });
});

describe("comment command", () => {
  const routes = [
    {
      method: "POST",
      route: "wp/v2/comments/1042",
      respond: ({ body }) => ({ body: { id: 1042, status: (body as Record<string, unknown>)?.["status"], post: 42 } }),
    },
    {
      method: "GET",
      route: "wp/v2/comments/1042",
      respond: () => ({ body: { id: 1042, post: 42, parent: 0, status: "hold", author_name: "Reader", content: { rendered: "<p>Typo in paragraph two.</p>" } } }),
    },
    {
      method: "POST",
      route: "wp/v2/comments",
      respond: ({ body }) => ({ body: { id: 1100, post: (body as Record<string, unknown>)?.["post"], parent: (body as Record<string, unknown>)?.["parent"], status: "approved" } }),
    },
  ];

  it("moderation verbs require --confirm and send the right status", async () => {
    const { ctx, calls } = contextFor(routes);
    await expect(commentCommand(["approve", "1042"], ctx)).rejects.toThrow(/--confirm/);
    await expect(commentCommand(["spam", "1042"], ctx)).rejects.toThrow(/--confirm/);
    await commentCommand(["approve", "1042", "--confirm"], ctx);
    expect(calls[0]?.body).toEqual({ status: "approve" });
  });

  it("reply fetches the parent and posts with post + parent in one step", async () => {
    const { ctx, calls } = contextFor(routes);
    const out = (await commentCommand(["reply", "1042", "--content", "Fixed, thanks"], ctx)) as Record<string, unknown>;
    expect(out["created"]).toMatchObject({ id: 1100 });
    const createCall = calls.find((c) => c.method === "POST" && c.route === "wp/v2/comments");
    expect(createCall?.body).toMatchObject({ post: 42, parent: 1042, content: "Fixed, thanks" });
  });

  it("creates require --post", async () => {
    const { ctx } = contextFor(routes);
    await expect(commentCommand(["create", "--content", "x"], ctx)).rejects.toThrow(/--post/);
  });
});

describe("user command", () => {
  it("me verifies auth and counts capabilities", async () => {
    const { ctx } = contextFor([
      {
        method: "GET",
        route: "wp/v2/users/me",
        respond: () => ({ body: { id: 3, name: "API User", slug: "api-user", email: "api@test.example", roles: ["editor"], capabilities: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`cap${i}`, true])) } }),
      },
    ]);
    const out = (await meCommand([], ctx)) as Record<string, unknown>;
    const me = out["me"] as Record<string, unknown>;
    expect(me).toMatchObject({ id: 3, roles: ["editor"], capabilities: 31, site: "https://test.example" });
  });

  it("me rejects unknown flags before any network call", async () => {
    const { ctx } = contextFor([]);
    await expect(meCommand(["--definitely-bogus"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(meCommand(["--definitely-bogus"], ctx)).rejects.toThrow(/definitely-bogus/);
  });

  it("create requires --confirm and surfaces generated passwords once", async () => {
    const { ctx } = contextFor([
      {
        method: "POST",
        route: "wp/v2/users",
        respond: () => ({ body: { id: 8, name: "janesmith", slug: "janesmith", roles: ["author"], password: "generated-secret-1" } }),
      },
    ]);
    await expect(
      userCommand(["create", "--username", "janesmith", "--email", "jane@example.com"], ctx),
    ).rejects.toThrow(/--confirm/);
    const out = (await userCommand(
      ["create", "--username", "janesmith", "--email", "jane@example.com", "--role", "author", "--confirm"],
      ctx,
    )) as Record<string, unknown>;
    const help = (out["help"] as string[]).join("\n");
    expect(help).toContain("generated-secret-1");
    expect(help).toContain("only shown once");
  });

  it("role changes require --confirm", async () => {
    const { ctx } = contextFor([
      { method: "POST", route: "wp/v2/users/7", respond: () => ({ body: { id: 7, roles: ["editor"] } }) },
    ]);
    await expect(userCommand(["update", "7", "--role", "editor"], ctx)).rejects.toThrow(/--confirm/);
    await userCommand(["update", "7", "--role", "editor", "--confirm"], ctx);
  });

  it("delete passes reassign", async () => {
    const { ctx, calls } = contextFor([
      { method: "DELETE", route: "wp/v2/users/7", respond: () => ({ body: { deleted: true, previous: { id: 7 } } }) },
    ]);
    await userCommand(["delete", "7", "--reassign", "1", "--confirm"], ctx);
    expect(calls[0]?.query.get("reassign")).toBe("1");
    expect(calls[0]?.query.get("force")).toBe("true");
  });
});

describe("search command", () => {
  it("searches with type filters and contextual help", async () => {
    const { ctx, calls } = contextFor([
      {
        method: "GET",
        route: "wp/v2/search",
        respond: () => collection([{ id: 42, title: "Quarterly report", url: "https://test.example/?p=42", type: "post", subtype: "post" }], 1),
      },
    ]);
    const out = (await searchCommand(["quarterly report", "--type", "post"], ctx)) as Record<string, unknown>;
    expect(calls[0]?.query.get("search")).toBe("quarterly report");
    expect(calls[0]?.query.get("type")).toBe("post");
    expect(out["count"]).toBe(1);
    expect((out["help"] as string[]).join(" ")).toContain("post get 42");
  });
});

describe("settings command", () => {
  it("gets and sets settings; set requires --confirm", async () => {
    const { ctx, calls } = contextFor([
      {
        method: "GET",
        route: "wp/v2/settings",
        respond: () => ({ body: { title: "Test Site", description: "A site", timezone: "UTC", posts_per_page: 10 } }),
      },
      {
        method: "PATCH",
        route: "wp/v2/settings",
        respond: ({ body }) => ({ body }),
      },
    ]);
    const got = (await settingsCommand(["get"], ctx)) as Record<string, unknown>;
    expect((got["settings"] as Record<string, unknown>)["title"]).toBe("Test Site");

    await expect(settingsCommand(["set", "--title", "New"], ctx)).rejects.toThrow(/--confirm/);
    await settingsCommand(["set", "--title", "New Title", "--timezone", "UTC", "--confirm"], ctx);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ title: "New Title", timezone: "UTC" });
  });
});

describe("plugin command", () => {
  it("lists plugins and percent-encodes slashed ids on activate", async () => {
    const { ctx, calls } = contextFor([
      {
        method: "GET",
        route: "wp/v2/plugins",
        respond: () => collection([{ plugin: "akismet/akismet", name: "Akismet", status: "active", version: "5.3" }]),
      },
      {
        method: "POST",
        route: "wp/v2/plugins/akismet%2Fakismet",
        respond: () => ({ body: { plugin: "akismet/akismet", name: "Akismet", status: "active", version: "5.3" } }),
      },
    ]);
    const out = (await pluginCommand(["list"], ctx)) as Record<string, unknown>;
    expect((out["plugins"] as unknown[])[0]).toMatchObject({ plugin: "akismet/akismet", status: "active" });

    await expect(pluginCommand(["activate", "akismet/akismet"], ctx)).rejects.toThrow(/--confirm/);
    await pluginCommand(["activate", "akismet/akismet", "--confirm"], ctx);
    const call = calls.find((c) => c.method === "POST");
    expect(call?.route).toBe("wp/v2/plugins/akismet%2Fakismet");
    expect(call?.body).toEqual({ status: "active" });
  });
});

describe("theme command", () => {
  it("lists themes and gates activation", async () => {
    const { ctx, calls } = contextFor([
      {
        method: "GET",
        route: "wp/v2/themes",
        respond: () => collection([
          { theme: "twentytwentyfive", name: "Twenty Twenty-Five", status: "active", version: "1.2" },
          { theme: "twentytwentyfour", name: "Twenty Twenty-Four", status: "inactive", version: "1.1" },
        ]),
      },
      {
        method: "POST",
        route: "wp/v2/themes/twentytwentyfour",
        respond: () => ({ body: { theme: "twentytwentyfour", name: "Twenty Twenty-Four", status: "active", version: "1.1" } }),
      },
    ]);
    const out = (await themeCommand(["list"], ctx)) as Record<string, unknown>;
    expect(out["count"]).toBe(2);
    expect((out["help"] as string[]).join(" ")).toContain("theme activate twentytwentyfour");

    await expect(themeCommand(["activate", "twentytwentyfour"], ctx)).rejects.toThrow(/--confirm/);
    await themeCommand(["activate", "twentytwentyfour", "--confirm"], ctx);
    expect(calls[1]?.body).toEqual({ status: "active" });
  });
});

describe("discover command", () => {
  it("aggregates index, types, taxonomies, and statuses", async () => {
    const { ctx } = contextFor([
      { method: "GET", route: "", respond: () => ({ body: API_INDEX }) },
      {
        method: "GET",
        route: "wp/v2/types",
        respond: () => ({ body: { post: { slug: "post", name: "Posts", rest_base: "posts" }, product: { slug: "product", name: "Products", rest_base: "products" } } }),
      },
      {
        method: "GET",
        route: "wp/v2/taxonomies",
        respond: () => ({ body: { category: { slug: "category", name: "Categories", rest_base: "categories" } } }),
      },
      {
        method: "GET",
        route: "wp/v2/statuses",
        respond: () => ({ body: { publish: { slug: "publish", name: "Published", public: true }, draft: { slug: "draft", name: "Draft", public: false } } }),
      },
    ]);
    const out = (await discoverCommand([], ctx)) as Record<string, unknown>;
    expect(out["namespaces"]).toEqual(["wp/v2", "wp-site-health/v1"]);
    expect(out["types"]).toEqual([
      { slug: "post", rest_base: "posts", name: "Posts" },
      { slug: "product", rest_base: "products", name: "Products" },
    ]);
    expect(out["statuses"]).toEqual([
      { slug: "draft", name: "Draft", public: false },
      { slug: "publish", name: "Published", public: true },
    ]);
  });
});

describe("request command", () => {
  it("expands shorthand and passes params", async () => {
    const { ctx, calls } = contextFor([
      { method: "GET", route: "wp/v2/posts/42", respond: () => ({ body: { id: 42 }, headers: { "X-WP-Total": "9" } }) },
    ]);
    const out = (await requestCommand(["GET", "posts/42", "--param", "context=edit"], ctx)) as Record<string, unknown>;
    expect(calls[0]?.query.get("context")).toBe("edit");
    expect(out["request"]).toBe("GET /wp/v2/posts/42");
    expect(out["status"]).toBe(200);
    expect(out["total"]).toBe(9);
  });

  it("rejects absolute URLs and unknown methods loudly", async () => {
    const { ctx } = contextFor([]);
    await expect(requestCommand(["GET", "https://evil.example/wp-json/wp/v2/posts"], ctx)).rejects.toThrow(/relative/);
    await expect(requestCommand(["BREW", "posts"], ctx)).rejects.toThrow(/METHOD/);
    await expect(requestCommand([], ctx)).rejects.toThrow(/requires <METHOD>/);
  });
});

describe("home command", () => {
  it("aggregates counts in parallel and degrades on failures", async () => {
    const { ctx } = contextFor([
      { method: "GET", route: "", respond: () => ({ body: API_INDEX }) },
      { method: "GET", route: "wp/v2/posts", respond: () => collection([{ id: 1 }], 12) },
      { method: "GET", route: "wp/v2/pages", respond: () => collection([{ id: 2 }], 3) },
      { method: "GET", route: "wp/v2/comments", respond: () => ({ status: 403, body: { code: "x", message: "denied", data: { status: 403 } } }) },
      { method: "GET", route: "wp/v2/media", respond: () => collection([{ id: 3 }], 7) },
    ]);
    const out = (await homeCommand([], ctx)) as Record<string, unknown>;
    expect(out["site"]).toBe("Test Site");
    expect(out["content"]).toEqual({ posts: 12, pages: 3, comments: "unknown", media: 7 });
    expect((out["help"] as string[]).length).toBeGreaterThanOrEqual(4);
  });
});
