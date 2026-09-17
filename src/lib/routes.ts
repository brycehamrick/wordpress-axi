import { AxiError } from "axi-sdk-js";

/**
 * WordPress REST route normalization.
 *
 * The REST root is `{WORDPRESS_URL}/wp-json/`. Users may pass:
 * - a bare shorthand resource (`posts`, `pages/42`) - expanded to `wp/v2/...`
 * - a full route with or without the `wp-json/` prefix (`wp/v2/posts`,
 *   `wp-json/wp/v2/posts`, `woocommerce/v1/products`)
 * Absolute URLs are rejected: this CLI only talks to the configured site.
 */

/** Core resources that get the implicit `wp/v2/` shorthand. */
export const COMMON_RESOURCES = new Set([
  "blocks",
  "categories",
  "comments",
  "media",
  "pages",
  "plugins",
  "posts",
  "search",
  "settings",
  "statuses",
  "tags",
  "taxonomies",
  "themes",
  "types",
  "users",
]);

export function normalizeRoute(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    throw new AxiError(
      "route must be a relative WordPress REST API route, not an absolute URL",
      "VALIDATION_ERROR",
      ["Use `wordpress-axi request GET wp/v2/posts` style routes for the configured site"],
    );
  }
  let route = trimmed.replace(/^\/+/, "");
  if (route.startsWith("wp-json/")) {
    route = route.slice("wp-json/".length);
  }
  const first = route.split("/", 1)[0] ?? "";
  if (COMMON_RESOURCES.has(first)) {
    route = `wp/v2/${route}`;
  }
  if (route.length === 0) {
    route = "";
  }
  return route;
}

/** Build the full REST URL for a normalized route. */
export function routeUrl(baseUrl: string, route: string): string {
  return `${baseUrl}/wp-json/${route}`;
}
