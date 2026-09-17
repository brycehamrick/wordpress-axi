import type { AxiRenderable } from "../lib/output.js";
import type { CommandContext } from "../context.js";

/**
 * AXI principles 4, 8, 9: the no-argument home view is live content, not
 * help. One cheap index call plus four one-row collection calls run in
 * parallel; every count degrades independently to "unknown" so a partially
 * permissioned API user still gets a useful dashboard. Session-start hooks
 * run this on every conversation, so nothing here blocks on slow endpoints.
 */
export async function homeCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const out: Record<string, unknown> = {
    auth: "application-password",
    site: ctx.config.baseUrl,
  };

  const [index, posts, pages, comments, media] = await Promise.all([
    ctx.client
      .request<Record<string, unknown>>("GET", "")
      .then((r) => r.data)
      .catch(() => undefined),
    countOf(ctx, "wp/v2/posts"),
    countOf(ctx, "wp/v2/pages"),
    countOf(ctx, "wp/v2/comments"),
    countOf(ctx, "wp/v2/media"),
  ]);

  if (index !== undefined) {
    const name = typeof index["name"] === "string" ? index["name"] : undefined;
    const description =
      typeof index["description"] === "string" ? index["description"] : undefined;
    out["site"] = name !== undefined && name.length > 0 ? name : ctx.config.baseUrl;
    if (description !== undefined && description.length > 0) {
      out["site_description"] = description;
    }
  } else {
    out["site"] = ctx.config.baseUrl;
    out["health"] = "unknown - the API index did not respond (run `wordpress-axi me` to test auth)";
  }

  out["content"] = {
    posts: posts ?? "unknown",
    pages: pages ?? "unknown",
    comments: comments ?? "unknown",
    media: media ?? "unknown",
  };

  out["commands"] =
    "post page category tag media comment user search settings plugin theme discover me request setup";
  out["help"] = [
    'Run `wordpress-axi post list --limit 5` for recent posts',
    'Run `wordpress-axi search "<query>"` to find content',
    "Run `wordpress-axi discover` to map post types, taxonomies, and plugin namespaces",
    "Run `wordpress-axi --help` or `<command> --help` for details",
    "Run `wordpress-axi setup hooks` for ambient context in every session",
  ];
  return out;
}

async function countOf(ctx: CommandContext, route: string): Promise<number | undefined> {
  const result = await ctx.client
    .list(route, { per_page: 1, page: 1 })
    .then((r) => r.meta.total)
    .catch(() => undefined);
  return result;
}
