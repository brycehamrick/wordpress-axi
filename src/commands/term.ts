import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  oneOf,
  optionalInt,
  parseFlags,
  parseJsonFlag,
  requireConfirm,
  requirePositional,
  requireString,
  requiredString,
  splitCsv,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { asInt, asRecord, asString, compact, projectRow } from "../lib/rows.js";
import type { CommandContext } from "../context.js";
import { WpApiError } from "../wordpress.js";

/**
 * Shared implementation for categories and tags - the two built-in
 * hierarchical-ish taxonomies. Creates are idempotent: WordPress returns
 * `term_exists` with the conflicting ID, which we resolve to the existing
 * term instead of failing (AXI principle 6).
 */

export interface TermResource {
  label: string;
  plural: string;
  route: string;
  supportsParent: boolean;
}

export const CATEGORY_RESOURCE: TermResource = {
  label: "category",
  plural: "categories",
  route: "wp/v2/categories",
  supportsParent: true,
};

export const TAG_RESOURCE: TermResource = {
  label: "tag",
  plural: "tags",
  route: "wp/v2/tags",
  supportsParent: false,
};

export function termHelp(resource: TermResource): string {
  const { label, plural } = resource;
  const parentFlags = resource.supportsParent
    ? `
  --parent <id>           parent ${label} ID (hierarchy)`
    : "";
  const parentCreate = resource.supportsParent
    ? `
  --parent <id>           parent ${label} ID`
    : "";
  return `wordpress-axi ${label} - manage ${plural}

subcommands (read):
  ${label} list                       ${plural} with usage counts
  ${label} get <id>                   one ${label} with description

subcommands (write):
  ${label} create --name "..."        create (returns the existing term if the name is taken)
  ${label} update <id> --name "..."   rename, re-slug, or edit the description
  ${label} delete <id>                delete permanently (requires --confirm; terms have no trash)

list flags:
  --search <text>         keyword search
  --orderby <field>       name (default), count, id, slug
  --order <dir>           asc (default) or desc
  --hide-empty            only terms assigned to at least one post${parentFlags}
  --limit <n>             per page, 1-100 (default 10)
  --page <n>              page number
  --fields <csv>          raw response fields instead of the default four
  --json                  machine-readable JSON instead of TOON

create/update flags:
  --name <text>           required for create
  --slug <slug>           defaults to the name
  --description <text>    shown on the term archive page${parentCreate}
  --body <json>           raw JSON payload merged last

examples:
  wordpress-axi ${label} list --orderby count --limit 10
  wordpress-axi ${label} create --name "Announcements"
  wordpress-axi ${label} update 4 --description "Company news"
  wordpress-axi ${label} delete 4 --confirm`;
}

const GET_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

/** List flags are resource-specific so wrong filters fail loud (principle 6). */
function listFlags(resource: TermResource): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {
    search: { type: "string" },
    orderby: { type: "string" },
    order: { type: "string" },
    "hide-empty": { type: "boolean" },
    limit: { type: "string" },
    page: { type: "string" },
    fields: { type: "string" },
    json: { type: "boolean" },
  };
  if (resource.supportsParent) flags["parent"] = { type: "string" };
  return flags;
}

function createFlags(resource: TermResource): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string" },
    body: { type: "string" },
    json: { type: "boolean" },
  };
  if (resource.supportsParent) flags["parent"] = { type: "string" };
  return flags;
}

const UPDATE_FLAGS: Record<string, FlagDefinition> = {
  name: { type: "string" },
  slug: { type: "string" },
  description: { type: "string" },
  parent: { type: "string" },
  body: { type: "string" },
  json: { type: "boolean" },
};

const DELETE_FLAGS: Record<string, FlagDefinition> = {
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const ORDERBY_FIELDS = ["name", "count", "id", "include", "slug", "include_slugs"] as const;

export type TermCommand = (args: string[], ctx: CommandContext) => Promise<AxiRenderable>;

export function createTermCommand(resource: TermResource): TermCommand {
  return (args: string[], ctx: CommandContext) => termCommand(resource, args, ctx);
}

async function termCommand(
  resource: TermResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return termList(resource, rest, ctx);
    case "get":
      return termGet(resource, rest, ctx);
    case "create":
      return termCreate(resource, rest, ctx);
    case "update":
      return termUpdate(resource, rest, ctx);
    case "delete":
      return termDelete(resource, rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: termHelp(resource) };
    default:
      throw new AxiError(
        `unknown ${resource.label} subcommand: ${sub}`,
        "VALIDATION_ERROR",
        [`Run \`wordpress-axi ${resource.label} --help\` to see list, get, create, update, delete`],
      );
  }
}

async function termList(
  resource: TermResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} list`;
  const { values, positionals } = parseFlags(args, commandPath, listFlags(resource));
  forbidExtraPositionals(positionals, 0, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 10;
  const page = optionalInt(values, "page", { min: 1, max: 10_000 }) ?? 1;
  const order = oneOf(values, "order", ["asc", "desc"] as const);
  const orderby = oneOf(values, "orderby", ORDERBY_FIELDS);
  const fields = splitCsv(values["fields"] as string | undefined);

  const query: Record<string, string | number | boolean | undefined> = {
    per_page: limit,
    page,
    search: requireString(values, "search", commandPath),
    order,
    orderby,
    hide_empty: values["hide-empty"] === true,
  };
  if (resource.supportsParent) {
    query["parent"] = optionalInt(values, "parent", { min: 0, max: 100_000_000 });
  }

  const { data, meta } = await ctx.client.list(resource.route, query);
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const projected = rows.map((row) =>
    fields.length > 0
      ? projectRow(row, fields)
      : compact({
          id: asInt(row["id"]),
          name: asString(row["name"]),
          slug: asString(row["slug"]),
          count: asInt(row["count"]),
        }),
  );
  const out: Record<string, unknown> = {
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    [resource.plural]: projected,
  };
  if (rows.length === 0) {
    out["result"] = `0 ${resource.plural} \u2014 nothing matched this filter`;
    help.push(`Run \`wordpress-axi ${resource.label} create --name "..."\` to add one`);
  } else {
    const firstId = asInt(rows[0]?.["id"]);
    if (firstId !== undefined) {
      help.push(`Run \`wordpress-axi ${resource.label} get ${firstId}\` for the description`);
    }
    if (meta.total !== undefined && page * limit < meta.total) {
      help.push(`${meta.total - page * limit} more \u2014 rerun with --page ${page + 1}`);
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}

async function termGet(
  resource: TermResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} get`;
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", `${resource.route}/${id}`);
  const detail = compact({
    id: asInt(data["id"]),
    name: asString(data["name"]),
    slug: asString(data["slug"]),
    description: snippet(asString(data["description"]), 400),
    ...(resource.supportsParent ? { parent: asInt(data["parent"]) } : {}),
    count: asInt(data["count"]),
    link: asString(data["link"]),
  });
  return renderResult(
    {
      [resource.label]: detail,
      help: [
        `Run \`wordpress-axi ${resource.label} update ${id} --description "..."\` to edit`,
        resource.supportsParent
          ? `Run \`wordpress-axi ${resource.label} list --parent ${id}\` for child ${resource.plural}`
          : `Run \`wordpress-axi post list --tags ${id}\` to see posts using this term`,
      ],
    },
    values["json"] === true,
  );
}

async function termCreate(
  resource: TermResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} create`;
  const { values } = parseFlags(args, commandPath, createFlags(resource));
  const json = values["json"] === true;
  const name = requiredString(values, "name", commandPath);

  const payload = buildTermPayload(resource, values, commandPath);
  payload["name"] = name;

  try {
    const { data } = await ctx.client.request<Record<string, unknown>>(
      "POST",
      resource.route,
      { body: payload },
    );
    return renderResult(
      {
        created: termSummary(resource, data),
        help: [
          `Run \`wordpress-axi ${resource.label} get ${asInt(data["id"]) ?? "<id>"}\` to verify`,
          `Assign it on a post: \`wordpress-axi post create --title "..." --${resource.supportsParent ? "categories" : "tags"} ${asInt(data["id"]) ?? "<id>"}\``,
        ],
      },
      json,
    );
  } catch (error) {
    const existing = existingTermId(error);
    if (existing !== undefined) {
      const { data } = await ctx.client.request<Record<string, unknown>>(
        "GET",
        `${resource.route}/${existing}`,
      );
      return renderResult(
        {
          existing: termSummary(resource, data),
          result: `${resource.label} already exists \u2014 returning the existing term (idempotent)`,
          help: [
            `Run \`wordpress-axi ${resource.label} update ${existing} --name "..."\` to rename it`,
          ],
        },
        json,
      );
    }
    throw error;
  }
}

async function termUpdate(
  resource: TermResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} update`;
  const { values, positionals } = parseFlags(args, commandPath, UPDATE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  const payload = buildTermPayload(resource, values, commandPath);
  if (Object.keys(payload).length === 0) {
    throw new AxiError(
      `${resource.label} update needs at least one field to change`,
      "VALIDATION_ERROR",
      [`Example: wordpress-axi ${resource.label} update ${id} --description "..."`],
    );
  }

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    `${resource.route}/${id}`,
    { body: payload },
  );
  return renderResult(
    {
      updated: termSummary(resource, data),
      help: [`Run \`wordpress-axi ${resource.label} get ${id}\` to verify`],
    },
    json,
  );
}

async function termDelete(
  resource: TermResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} delete`;
  const { values, positionals } = parseFlags(args, commandPath, DELETE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `permanently delete ${resource.label} ${id} (terms have no trash)`);

  await ctx.client.request("DELETE", `${resource.route}/${id}`, { query: { force: true } });
  return renderResult(
    {
      deleted: { id },
      help: [
        `Run \`wordpress-axi ${resource.label} list\` to confirm the remaining set`,
        "Posts that used this term keep their other terms",
      ],
    },
    json,
  );
}

// ---------- shared helpers ----------

function termSummary(resource: TermResource, data: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: asInt(data["id"]),
    name: asString(data["name"]),
    slug: asString(data["slug"]),
    count: asInt(data["count"]),
    label: resource.label,
  });
}

function buildTermPayload(
  resource: TermResource,
  values: Record<string, string | boolean | string[] | undefined>,
  commandPath: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const slug = requireString(values, "slug", commandPath);
  const description = requireString(values, "description", commandPath);
  if (slug !== undefined) payload["slug"] = slug;
  if (description !== undefined) payload["description"] = description;
  if (resource.supportsParent) {
    const parent = optionalInt(values, "parent", { min: 0, max: 100_000_000 });
    if (parent !== undefined) payload["parent"] = parent;
  }
  const body = parseJsonFlag(values, "body");
  return body ? { ...payload, ...body } : payload;
}

/**
 * WordPress rejects duplicate terms with `term_exists` + the conflicting
 * term_id in `data`. Detect that so create can resolve idempotently.
 */
function existingTermId(error: unknown): number | undefined {
  if (!(error instanceof WpApiError)) return undefined;
  if (error.wpCode !== "term_exists") return undefined;
  const termId = error.payload["term_id"];
  return typeof termId === "number" ? termId : undefined;
}

function requireId(positionals: string[], commandPath: string): string {
  const id = requirePositional(positionals, 0, "id", commandPath);
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`${commandPath}: <id> must be a numeric WordPress ID, got: ${id}`, "VALIDATION_ERROR");
  }
  return id;
}

