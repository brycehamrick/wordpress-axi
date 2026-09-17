import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  optionalInt,
  parseFlags,
  requirePositional,
  requireString,
  splitCsv,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { asInt, asRecord, asString, compact } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * Cross-type search over everything the site exposes via /wp/v2/search:
 * posts, pages, and custom post types registered with show_in_rest.
 */

export const SEARCH_HELP = `wordpress-axi search - search posts, pages, and exposed custom types

usage:
  search <query>                ranked matches with type and URL

flags:
  --type <t>         limit to post, page, term, or post-format
  --subtype <csv>    narrow a type (e.g. --type post --subtype page,product)
  --limit <n>        per page, 1-100 (default 10)
  --page <n>         page number
  --json             machine-readable JSON instead of TOON

examples:
  wordpress-axi search "quarterly report"
  wordpress-axi search "pricing" --type page
  wordpress-axi search "shipping" --subtype page,product`;

const SEARCH_FLAGS: Record<string, FlagDefinition> = {
  type: { type: "string" },
  subtype: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  json: { type: "boolean" },
};

export async function searchCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi search";
  const { values, positionals } = parseFlags(args, commandPath, SEARCH_FLAGS);
  const query = requirePositional(positionals, 0, "query", commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 10;
  const page = optionalInt(values, "page", { min: 1, max: 10_000 }) ?? 1;

  const { data, meta } = await ctx.client.list("wp/v2/search", {
    per_page: limit,
    page,
    search: query,
    type: requireString(values, "type", commandPath),
    subtype: splitCsv(values["subtype"] as string | undefined).join(",") || undefined,
  });
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const projected = rows.map((row) =>
    compact({
      id: asInt(row["id"]),
      title: asString(row["title"]),
      type: asString(row["type"]),
      url: asString(row["url"]),
    }),
  );
  const out: Record<string, unknown> = {
    query,
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    results: projected,
  };
  if (rows.length === 0) {
    out["result"] = `0 results for "${query}" \u2014 try shorter or different keywords`;
    help.push("Run `wordpress-axi discover` to see which types this site exposes");
  } else {
    const first = rows[0];
    const firstId = asInt(first?.["id"]);
    const firstType = asString(first?.["type"]);
    if (firstId !== undefined && firstType === "post") {
      help.push(`Run \`wordpress-axi post get ${firstId}\` for the full post`);
    } else if (firstId !== undefined && firstType === "page") {
      help.push(`Run \`wordpress-axi page get ${firstId}\` for the full page`);
    } else {
      help.push("Run `wordpress-axi request GET wp/v2/<type>/<id> --json` for details");
    }
    if (meta.total !== undefined && page * limit < meta.total) {
      help.push(`${meta.total - page * limit} more \u2014 rerun with --page ${page + 1}`);
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}
