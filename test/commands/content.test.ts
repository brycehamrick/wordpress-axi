import { describe, expect, it } from "vitest";
import { createContentCommand, POST_RESOURCE, PAGE_RESOURCE } from "../../src/commands/content.js";
import { collection, contextFor, postRow } from "../helpers/wpFake.js";

function postRoutes(): Parameters<typeof contextFor>[0] {
  return [
    {
      method: "GET",
      route: "wp/v2/posts",
      respond: ({ query }) => {
        if (query.get("filter_bad") !== null) return { status: 400, body: { code: "rest_invalid_param", message: "bad", data: { status: 400 } } };
        return collection([postRow()], 87);
      },
    },
    {
      method: "GET",
      route: "wp/v2/posts/42",
      respond: () => ({ body: postRow() }),
    },
    {
      method: "POST",
      route: "wp/v2/posts",
      respond: ({ body }) => ({ body: { id: 100, status: (body as Record<string, unknown>)?.["status"] ?? "draft", title: { rendered: "" }, link: "https://test.example/x" } }),
    },
    {
      method: "POST",
      route: "wp/v2/posts/42",
      respond: ({ body }) => ({ body: { id: 42, ...(body as object) } }),
    },
    {
      method: "DELETE",
      route: "wp/v2/posts/42",
      respond: ({ query }) => ({
        body: query.get("force") === "true" ? { deleted: true, previous: { id: 42 } } : postRow({ status: "trash" }),
      }),
    },
    {
      method: "GET",
      route: "wp/v2/posts/42/revisions",
      respond: () => ({ body: [{ id: 900, date: "2026-03-02T08:00:00", author: 1 }] }),
    },
  ];
}

describe("post command", () => {
  it("lists with count, total, minimal rows, and next-step help", async () => {
    const { ctx } = contextFor(postRoutes());
    const out = (await createContentCommand(POST_RESOURCE)(["list"], ctx)) as Record<string, unknown>;
    expect(out["count"]).toBe(1);
    expect(out["total"]).toBe(87);
    const rows = out["posts"] as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ id: 42, title: "Hello world", status: "publish", date: "2026-03-01" });
    const help = out["help"] as string[];
    expect(help.join("\n")).toContain("post get 42");
    expect(help.join("\n")).toContain("77 more");
    expect(help.join("\n")).toContain("--page 2");
  });

  it("renders a definitive empty state", async () => {
    const { ctx } = contextFor([
      { method: "GET", route: "wp/v2/posts", respond: () => collection([], 0) },
    ]);
    const out = (await createContentCommand(POST_RESOURCE)(["list", "--status", "draft"], ctx)) as Record<string, unknown>;
    expect(out["result"]).toContain("0 posts");
    expect((out["posts"] as unknown[]).length).toBe(0);
  });

  it("gets with truncated content and a --full escape hatch", async () => {
    const { ctx } = contextFor(postRoutes());
    const truncated = (await createContentCommand(POST_RESOURCE)(["get", "42"], ctx)) as Record<string, unknown>;
    const post = truncated["post"] as Record<string, unknown>;
    expect(String(post["content"])).toContain("truncated");
    expect((truncated["help"] as string[]).join(" ")).toContain("--full");

    const full = (await createContentCommand(POST_RESOURCE)(["get", "42", "--full"], ctx)) as Record<string, unknown>;
    const fullPost = full["post"] as Record<string, unknown>;
    expect(String(fullPost["content"])).not.toContain("truncated");
    expect(fullPost["title"]).toBe("Hello world");
  });

  it("creates as draft by default with no confirmation", async () => {
    const { ctx, calls } = contextFor(postRoutes());
    const out = (await createContentCommand(POST_RESOURCE)(
      ["create", "--title", "Hello", "--content", "Body text"],
      ctx,
    )) as Record<string, unknown>;
    const created = out["created"] as Record<string, unknown>;
    expect(created["id"]).toBe(100);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body["status"]).toBe("draft");
    expect(body["title"]).toBe("Hello");
  });

  it("requires --confirm for publish statuses on create", async () => {
    const { ctx } = contextFor(postRoutes());
    await expect(
      createContentCommand(POST_RESOURCE)(["create", "--title", "X", "--status", "publish"], ctx),
    ).rejects.toThrow(/--confirm/);
    await expect(
      createContentCommand(POST_RESOURCE)(["create", "--title", "X", "--status", "future"], ctx),
    ).rejects.toThrow(/--confirm/);
  });

  it("publishes with --confirm and sends status=publish", async () => {
    const { ctx, calls } = contextFor(postRoutes());
    await createContentCommand(POST_RESOURCE)(["publish", "42", "--confirm"], ctx);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.route).toBe("wp/v2/posts/42");
    expect(calls[0]?.body).toEqual({ status: "publish" });
  });

  it("refuses publish without --confirm", async () => {
    const { ctx } = contextFor(postRoutes());
    await expect(
      createContentCommand(POST_RESOURCE)(["publish", "42"], ctx),
    ).rejects.toThrow(/--confirm/);
  });

  it("deletes to trash by default and permanently with --force", async () => {
    const { ctx, calls } = contextFor(postRoutes());
    await createContentCommand(POST_RESOURCE)(["delete", "42", "--confirm"], ctx);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.query.get("force")).toBe("false");

    await createContentCommand(POST_RESOURCE)(["delete", "42", "--confirm", "--force"], ctx);
    expect(calls[1]?.query.get("force")).toBe("true");
  });

  it("refuses update with no fields", async () => {
    const { ctx } = contextFor(postRoutes());
    await expect(createContentCommand(POST_RESOURCE)(["update", "42"], ctx)).rejects.toThrow(/at least one field/);
  });

  it("lists revisions with count and follow-up help", async () => {
    const { ctx } = contextFor(postRoutes());
    const out = (await createContentCommand(POST_RESOURCE)(["revisions", "42"], ctx)) as Record<string, unknown>;
    expect(out["count"]).toBe(1);
    expect((out["revisions"] as unknown[])[0]).toMatchObject({ id: 900 });
  });

  it("fails loud on unknown subcommands and unknown flags", async () => {
    const { ctx } = contextFor(postRoutes());
    await expect(createContentCommand(POST_RESOURCE)(["frobnicate"], ctx)).rejects.toThrow(/unknown post subcommand/);
    await expect(
      createContentCommand(POST_RESOURCE)(["list", "--filter-bad", "x"], ctx),
    ).rejects.toThrow();
  });

  it("rejects non-numeric IDs", async () => {
    const { ctx } = contextFor(postRoutes());
    await expect(createContentCommand(POST_RESOURCE)(["get", "abc"], ctx)).rejects.toThrow(/numeric/);
  });
});

describe("page command", () => {
  it("supports the --parent filter that posts do not", async () => {
    const { ctx, calls } = contextFor([
      { method: "GET", route: "wp/v2/pages", respond: () => collection([], 0) },
    ]);
    await createContentCommand(PAGE_RESOURCE)(["list", "--parent", "5"], ctx);
    expect(calls[0]?.query.get("parent")).toBe("5");

    const postCtx = contextFor(postRoutes());
    await expect(
      createContentCommand(POST_RESOURCE)(["list", "--parent", "5"], postCtx.ctx),
    ).rejects.toThrow();
  });
});
