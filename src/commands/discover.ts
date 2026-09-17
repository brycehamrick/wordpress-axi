import type { AxiRenderable } from "../lib/output.js";
import { forbidExtraPositionals, parseFlags, type FlagDefinition } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { asRecord, asString, compact } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * API discovery: the authoritative map of what this site exposes. Always
 * run this before touching plugin routes or custom post types - plugins add
 * namespaces, and custom types appear only when registered with show_in_rest.
 */

export const DISCOVER_HELP = `wordpress-axi discover - map the site's REST API surface

usage:
  discover                site info, namespaces, post types, taxonomies, statuses

flags:
  --json                  machine-readable JSON instead of TOON

Custom post types appear only when registered with show_in_rest=true. Plugin
namespaces (e.g. woocommerce/v1, acf/v3) work through the escape hatch:

  wordpress-axi request GET woocommerce/v1/products`;

const DISCOVER_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

interface DictEntry {
  slug: string;
  name?: unknown;
  rest_base?: unknown;
  public?: unknown;
}

export async function discoverCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi discover";
  const { values, positionals } = parseFlags(args, commandPath, DISCOVER_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const json = values["json"] === true;

  const [index, types, taxonomies, statuses] = await Promise.all([
    ctx.client.request<Record<string, unknown>>("GET", ""),
    ctx.client.request<Record<string, unknown>>("GET", "wp/v2/types").catch(() => undefined),
    ctx.client.request<Record<string, unknown>>("GET", "wp/v2/taxonomies").catch(() => undefined),
    ctx.client.request<Record<string, unknown>>("GET", "wp/v2/statuses").catch(() => undefined),
  ]);

  const namespaces = Array.isArray(index.data["namespaces"])
    ? index.data["namespaces"].filter((item): item is string => typeof item === "string")
    : [];

  const out: Record<string, unknown> = {
    site: compact({
      name: asString(index.data["name"]),
      description: asString(index.data["description"]),
      url: asString(index.data["url"]),
      home: asString(index.data["home"]),
      namespaces: namespaces.length,
    }),
    namespaces,
  };
  if (types !== undefined) {
    out["types"] = dictRows(types.data).map((entry) =>
      compact({
        slug: entry.slug,
        rest_base: asString(entry.rest_base),
        name: asString(entry.name),
      }),
    );
  }
  if (taxonomies !== undefined) {
    out["taxonomies"] = dictRows(taxonomies.data).map((entry) =>
      compact({
        slug: entry.slug,
        rest_base: asString(entry.rest_base),
        name: asString(entry.name),
      }),
    );
  }
  if (statuses !== undefined) {
    out["statuses"] = dictRows(statuses.data).map((entry) =>
      compact({
        slug: entry.slug,
        name: asString(entry.name),
        public: entry.public === true,
      }),
    );
  }

  const typeCount = Array.isArray(out["types"]) ? (out["types"] as unknown[]).length : 0;
  out["help"] = [
    typeCount > 0
      ? "Non-post types expose their own collections, e.g. `wordpress-axi request GET wp/v2/<rest_base>`"
      : "Run `wordpress-axi request GET wp/v2/types --json` for raw type details",
    "Plugin namespaces work through the escape hatch: `wordpress-axi request GET <namespace>/...`",
    "Run `wordpress-axi post list --limit 5` to sample recent content",
  ];

  if (namespaces.length === 0) {
    out["result"] = "API index returned no namespaces \u2014 REST access may be restricted";
  }
  return renderResult(out, json);
}

/** WordPress types/taxonomies/statuses return slug-keyed dictionaries. */
function dictRows(payload: unknown): DictEntry[] {
  const record = asRecord(payload);
  if (record === undefined) return [];
  return Object.entries(record)
    .filter(([, value]) => asRecord(value) !== undefined)
    .map(([slug, value]) => {
      const item = asRecord(value) as Record<string, unknown>;
      return {
        slug: asString(item["slug"]) ?? slug,
        name: item["name"],
        rest_base: item["rest_base"],
        public: item["public"],
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
