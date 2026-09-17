import { describe, expect, it } from "vitest";
import { createTermCommand, CATEGORY_RESOURCE, TAG_RESOURCE } from "../../src/commands/term.js";
import { collection, contextFor } from "../helpers/wpFake.js";

function termRoutes(): Parameters<typeof contextFor>[0] {
  return [
    {
      method: "GET",
      route: "wp/v2/categories",
      respond: () =>
        collection([
          { id: 4, name: "News", slug: "news", count: 12, link: "https://test.example/category/news/" },
          { id: 7, name: "Docs", slug: "docs", count: 3, link: "https://test.example/category/docs/" },
        ]),
    },
    {
      method: "GET",
      route: "wp/v2/categories/4",
      respond: () => ({
        body: { id: 4, name: "News", slug: "news", description: "Company announcements", parent: 0, count: 12, link: "https://test.example/category/news/" },
      }),
    },
    {
      method: "POST",
      route: "wp/v2/categories",
      respond: ({ body }) => {
        if ((body as Record<string, unknown>)?.["name"] === "News") {
          return {
            status: 400,
            body: {
              code: "term_exists",
              message: "A term with the name provided already exists in this taxonomy.",
              data: { status: 400, term_id: 4 },
            },
          };
        }
        return { body: { id: 11, name: (body as Record<string, unknown>)?.["name"], slug: "new", count: 0 } };
      },
    },
    {
      method: "POST",
      route: "wp/v2/categories/4",
      respond: ({ body }) => ({ body: { id: 4, name: "News", slug: "news", count: 12, ...(body as object) } }),
    },
    {
      method: "DELETE",
      route: "wp/v2/categories/4",
      respond: () => ({ body: { deleted: true, previous: { id: 4 } } }),
    },
  ];
}

describe("category command", () => {
  it("lists with id, name, slug, count and totals", async () => {
    const { ctx } = contextFor(termRoutes());
    const out = (await createTermCommand(CATEGORY_RESOURCE)(["list"], ctx)) as Record<string, unknown>;
    expect(out["count"]).toBe(2);
    expect(out["total"]).toBe(2);
    expect((out["categories"] as unknown[])[0]).toEqual({ id: 4, name: "News", slug: "news", count: 12 });
  });

  it("creates idempotently when the term already exists", async () => {
    const { ctx, calls } = contextFor(termRoutes());
    const out = (await createTermCommand(CATEGORY_RESOURCE)(["create", "--name", "News"], ctx)) as Record<string, unknown>;
    expect(out["result"]).toContain("already exists");
    const existing = out["existing"] as Record<string, unknown>;
    expect(existing["id"]).toBe(4);
    // Second call resolves the existing term by ID.
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.route).toBe("wp/v2/categories/4");
  });

  it("creates new terms without confirmation (additive, non-destructive)", async () => {
    const { ctx } = contextFor(termRoutes());
    const out = (await createTermCommand(CATEGORY_RESOURCE)(["create", "--name", "Fresh"], ctx)) as Record<string, unknown>;
    expect(out["created"]).toMatchObject({ id: 11, name: "Fresh" });
  });

  it("requires a name on create", async () => {
    const { ctx } = contextFor(termRoutes());
    await expect(createTermCommand(CATEGORY_RESOURCE)(["create"], ctx)).rejects.toThrow(/--name is required/);
  });

  it("deletes with --confirm and force=true (terms have no trash)", async () => {
    const { ctx, calls } = contextFor(termRoutes());
    await expect(createTermCommand(CATEGORY_RESOURCE)(["delete", "4"], ctx)).rejects.toThrow(/--confirm/);
    await createTermCommand(CATEGORY_RESOURCE)(["delete", "4", "--confirm"], ctx);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.query.get("force")).toBe("true");
  });
});

describe("tag command", () => {
  it("lists tags without parent support", async () => {
    const { ctx } = contextFor([
      { method: "GET", route: "wp/v2/tags", respond: () => collection([{ id: 9, name: "release", slug: "release", count: 2 }]) },
    ]);
    const out = (await createTermCommand(TAG_RESOURCE)(["list"], ctx)) as Record<string, unknown>;
    expect((out["tags"] as unknown[])[0]).toMatchObject({ id: 9, name: "release" });
    // tags do not accept --parent: strict parsing fails loud
    await expect(createTermCommand(TAG_RESOURCE)(["list", "--parent", "0"], ctx)).rejects.toThrow();
  });
});
