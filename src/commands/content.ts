import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  isPublishStatus,
  oneOf,
  optionalInt,
  parseFlags,
  parseJsonFlag,
  requireConfirm,
  requirePositional,
  requireString,
  splitCsv,
  splitCsvInts,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { renderedText, shortDate } from "../lib/format.js";
import { snippet, truncateText } from "../lib/truncate.js";
import { asInt, asRecord, asString, compact, projectRow } from "../lib/rows.js";
import type { CommandContext } from "../context.js";
import type { WpMeta } from "../wordpress.js";

/**
 * Shared implementation for posts and pages - the two core content types.
 * They differ only in route, label, and which taxonomy/parent filters they
 * support. Everything else (list/get/create/update/publish/delete/revisions)
 * is identical, so both commands come from one factory.
 */

export interface ContentResource {
  label: string;
  plural: string;
  route: string;
  supportsCategories: boolean;
  supportsTags: boolean;
  supportsParent: boolean;
}

export const POST_RESOURCE: ContentResource = {
  label: "post",
  plural: "posts",
  route: "wp/v2/posts",
  supportsCategories: true,
  supportsTags: true,
  supportsParent: false,
};

export const PAGE_RESOURCE: ContentResource = {
  label: "page",
  plural: "pages",
  route: "wp/v2/pages",
  supportsCategories: false,
  supportsTags: false,
  supportsParent: true,
};

const STATUS_HELP =
  "statuses: publish, draft, pending, private, future (scheduled), any, trash";

export function contentHelp(resource: ContentResource): string {
  const { label, plural } = resource;
  const filters: string[] = [
    "  --status <s>            " + STATUS_HELP,
    "  --search <text>         keyword search",
    "  --author <id>           filter by author ID",
  ];
  if (resource.supportsCategories) {
    filters.push("  --categories <csv>      category IDs (e.g. 4,9)");
    filters.push("  --tags <csv>            tag IDs");
  }
  if (resource.supportsParent) {
    filters.push("  --parent <id>           parent page ID (0 = top level)");
  }
  return `wordpress-axi ${label} - create, read, update, and delete ${plural}

subcommands (read):
  ${label} list                         ${plural} with status and dates (defaults to any status you can see)
  ${label} get <id>                     one ${label} with excerpt and truncated content
  ${label} revisions <id>               revision history

subcommands (write):
  ${label} create --title "..."         new ${label} (draft by default)
  ${label} update <id> --title "..."    patch one or more fields
  ${label} publish <id>                 make a draft live (requires --confirm)
  ${label} delete <id>                  move to trash (requires --confirm; --force skips trash)

list flags:
${filters.join("\n")}
  --orderby <field>        date (default), id, title, slug, modified
  --order <dir>            desc (default) or asc
  --limit <n>              per page, 1-100 (default 10)
  --page <n>               page number
  --fields <csv>           raw response fields to show instead of the default four
  --json                   machine-readable JSON instead of TOON

create/update flags:
  --title <text> --content <text> --excerpt <text> --slug <slug>
  --status <s>             draft (default) | publish | future | private | pending
  --body <json>            raw JSON payload merged last (any core field)

publication statuses (publish, future, private) require --confirm. Content is
not trashed permanently unless --force is also passed.

examples:
  wordpress-axi ${label} list --status publish --limit 5
  wordpress-axi ${label} create --title "Hello" --content "First post"
  wordpress-axi ${label} publish 42 --confirm
  wordpress-axi ${label} get 42 --full`;
}

const GET_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

/** List flags are resource-specific so wrong filters fail loud (principle 6). */
function listFlags(resource: ContentResource): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {
    status: { type: "string" },
    search: { type: "string" },
    author: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    orderby: { type: "string" },
    order: { type: "string" },
    limit: { type: "string" },
    page: { type: "string" },
    fields: { type: "string" },
    json: { type: "boolean" },
  };
  if (resource.supportsCategories) flags["categories"] = { type: "string" };
  if (resource.supportsTags) flags["tags"] = { type: "string" };
  if (resource.supportsParent) flags["parent"] = { type: "string" };
  return flags;
}

/** Create/update flags likewise exclude filters the resource does not support. */
function writeFlags(resource: ContentResource): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {
    title: { type: "string" },
    content: { type: "string" },
    excerpt: { type: "string" },
    slug: { type: "string" },
    status: { type: "string" },
    author: { type: "string" },
    body: { type: "string" },
    confirm: { type: "boolean" },
    json: { type: "boolean" },
  };
  if (resource.supportsCategories) flags["categories"] = { type: "string" };
  if (resource.supportsTags) flags["tags"] = { type: "string" };
  if (resource.supportsParent) flags["parent"] = { type: "string" };
  return flags;
}

const DELETE_FLAGS: Record<string, FlagDefinition> = {
  force: { type: "boolean" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const ORDERBY_FIELDS = ["date", "id", "include", "title", "slug", "modified", "menu_order"] as const;

export type ContentCommand = (
  args: string[],
  ctx: CommandContext,
) => Promise<AxiRenderable>;

export function createContentCommand(resource: ContentResource): ContentCommand {
  return (args: string[], ctx: CommandContext) => contentCommand(resource, args, ctx);
}

async function contentCommand(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return contentList(resource, rest, ctx);
    case "get":
      return contentGet(resource, rest, ctx);
    case "create":
      return contentCreate(resource, rest, ctx);
    case "update":
      return contentUpdate(resource, rest, ctx);
    case "publish":
      return contentPublish(resource, rest, ctx);
    case "delete":
      return contentDelete(resource, rest, ctx);
    case "revisions":
      return contentRevisions(resource, rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: contentHelp(resource) };
    default:
      throw new AxiError(
        `unknown ${resource.label} subcommand: ${sub}`,
        "VALIDATION_ERROR",
        [
          `Run \`wordpress-axi ${resource.label} --help\` to see list, get, create, update, publish, delete, revisions`,
        ],
      );
  }
}

async function contentList(
  resource: ContentResource,
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
    status: requireString(values, "status", commandPath),
    search: requireString(values, "search", commandPath),
    author: optionalInt(values, "author", { min: 0, max: 100_000_000 }),
    before: requireString(values, "before", commandPath),
    after: requireString(values, "after", commandPath),
    order,
    orderby,
  };
  if (resource.supportsCategories) {
    query["categories"] = joinIds(splitCsvInts(values["categories"], "categories"));
  }
  if (resource.supportsTags) {
    query["tags"] = joinIds(splitCsvInts(values["tags"], "tags"));
  }
  if (resource.supportsParent) {
    query["parent"] = optionalInt(values, "parent", { min: 0, max: 100_000_000 });
  }

  const { data, meta } = await ctx.client.list(resource.route, query);
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  return listOutput(resource, rows, meta, fields, page, limit, values["json"] === true);
}

function listOutput(
  resource: ContentResource,
  rows: Array<Record<string, unknown>>,
  meta: WpMeta,
  fields: string[],
  page: number,
  limit: number,
  json: boolean,
): AxiRenderable {
  const help: string[] = [];
  const projected = rows.map((row) =>
    fields.length > 0
      ? projectRow(row, fields)
      : compact({
          id: asInt(row["id"]),
          title: snippet(renderedText(row["title"]), 60),
          status: asString(row["status"]),
          date: shortDate(row["date"]),
        }),
  );
  const out: Record<string, unknown> = {
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    [resource.plural]: projected,
  };
  if (rows.length === 0) {
    out["result"] = `0 ${resource.plural} \u2014 nothing matched this filter`;
    help.push(
      `Run \`wordpress-axi ${resource.label} list\` without filters to see recent ${resource.plural}`,
    );
  } else {
    const firstId = asInt(rows[0]?.["id"]);
    if (firstId !== undefined) {
      help.push(`Run \`wordpress-axi ${resource.label} get ${firstId}\` for the full ${resource.label}`);
    }
    if (meta.total !== undefined && page * limit < meta.total) {
      help.push(`${meta.total - page * limit} more \u2014 rerun with --page ${page + 1}`);
    }
  }
  out["help"] = help;
  return renderResult(out, json);
}

async function contentGet(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} get`;
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const full = values["full"] === true;
  const json = values["json"] === true;

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", `${resource.route}/${id}`);
  const row = data;

  let content = snippet(renderedText(row["content"]), 400) ?? "";
  let excerpt = snippet(renderedText(row["excerpt"]), 200);
  let truncations = 0;
  if (!full) {
    const truncatedContent = truncateText(stripToText(row["content"]), 1200);
    content = truncatedContent.value;
    if (truncatedContent.truncated) truncations += 1;
    if (excerpt !== undefined) {
      const truncatedExcerpt = truncateText(excerpt, 400);
      excerpt = truncatedExcerpt.value;
      if (truncatedExcerpt.truncated) truncations += 1;
    }
  } else {
    content = stripToText(row["content"]);
  }

  const detail = compact({
    id: asInt(row["id"]),
    title: renderedText(row["title"]),
    status: asString(row["status"]),
    date: asString(row["date"]),
    modified: asString(row["modified"]),
    slug: asString(row["slug"]),
    link: asString(row["link"]),
    author: asInt(row["author"]),
    ...(resource.supportsParent ? { parent: asInt(row["parent"]) } : {}),
    ...(resource.supportsCategories && Array.isArray(row["categories"])
      ? { categories: row["categories"] }
      : {}),
    ...(resource.supportsTags && Array.isArray(row["tags"]) ? { tags: row["tags"] } : {}),
    excerpt,
    content,
  });
  const out: Record<string, unknown> = { [resource.label]: detail };
  const help = [
    `Run \`wordpress-axi ${resource.label} update ${id} --title "..." --content "..."\` to edit`,
    `Run \`wordpress-axi request GET ${resource.route}/${id} --json\` for the raw HTML fields`,
  ];
  if (truncations > 0) {
    help.push("content truncated \u2014 rerun with --full for complete text");
  }
  out["help"] = help;
  return renderResult(out, json);
}

async function contentCreate(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} create`;
  const { values } = parseFlags(args, commandPath, writeFlags(resource));
  const json = values["json"] === true;

  const payload = buildWritePayload(resource, values, commandPath, "draft");
  if (Object.keys(payload).length === 0) {
    throw new AxiError(
      `${resource.label} create needs content: pass --title or --content (or --body <json>)`,
      "VALIDATION_ERROR",
      [`Example: wordpress-axi ${resource.label} create --title "Hello" --content "First post"`],
    );
  }
  guardPublishStatus(resource, payload, values, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    resource.route,
    { body: payload },
  );
  return renderResult(
    {
      created: createdSummary(resource, data),
      help: [
        `Run \`wordpress-axi ${resource.label} get ${asInt(data["id"]) ?? "<id>"}\` to verify`,
        `Run \`wordpress-axi ${resource.label} publish ${asInt(data["id"]) ?? "<id>"} --confirm\` when ready to publish`,
      ],
    },
    json,
  );
}

async function contentUpdate(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} update`;
  const { values, positionals } = parseFlags(args, commandPath, writeFlags(resource));
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  const payload = buildWritePayload(resource, values, commandPath, undefined);
  if (Object.keys(payload).length === 0) {
    throw new AxiError(
      `${resource.label} update needs at least one field to change`,
      "VALIDATION_ERROR",
      [
        `Example: wordpress-axi ${resource.label} update ${id} --title "New title"`,
        "Pass --body <json> for fields without a dedicated flag",
      ],
    );
  }
  guardPublishStatus(resource, payload, values, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    `${resource.route}/${id}`,
    { body: payload },
  );
  return renderResult(
    {
      updated: createdSummary(resource, data),
      help: [`Run \`wordpress-axi ${resource.label} get ${id}\` to verify the change`],
    },
    json,
  );
}

async function contentPublish(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} publish`;
  const { values, positionals } = parseFlags(args, commandPath, DELETE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `publish ${resource.label} ${id} (makes it publicly visible)`);

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    `${resource.route}/${id}`,
    { body: { status: "publish" } },
  );
  return renderResult(
    {
      published: createdSummary(resource, data),
      help: [
        `Run \`wordpress-axi ${resource.label} get ${id}\` to verify`,
        "Run `wordpress-axi request GET wp/v2/pages/<id> --json` if you need the raw payload",
      ],
    },
    json,
  );
}

async function contentDelete(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} delete`;
  const { values, positionals } = parseFlags(args, commandPath, DELETE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const force = values["force"] === true;
  const json = values["json"] === true;

  requireConfirm(
    values,
    commandPath,
    `${force ? "permanently delete" : "move to trash"} ${resource.label} ${id}`,
  );

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "DELETE",
    `${resource.route}/${id}`,
    { query: { force } },
  );
  const permanent = data["deleted"] === true;
  return renderResult(
    {
      deleted: { id, mode: force || permanent ? "permanently" : "trash" },
      help: [
        `Run \`wordpress-axi ${resource.label} list --status trash\` to see trashed ${resource.plural}`,
        force || permanent
          ? `The ${resource.label} cannot be restored`
          : `Restore in wp-admin Trash, or re-create with \`${resource.label} create\``,
      ],
    },
    json,
  );
}

async function contentRevisions(
  resource: ContentResource,
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi ${resource.label} revisions`;
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  const { data } = await ctx.client.request<unknown>("GET", `${resource.route}/${id}/revisions`);
  const rows = asRecordArraySafe(data);
  const out: Record<string, unknown> = {
    count: rows.length,
    revisions: rows.map((row) =>
      compact({
        id: asInt(row["id"]),
        date: asString(row["date"]) ?? shortDate(row["date"]),
        author: asInt(row["author"]),
      }),
    ),
  };
  const help: string[] = [];
  if (rows.length === 0) {
    out["result"] = `0 revisions \u2014 this ${resource.label} has no saved revisions yet`;
    help.push("Revisions are created when an already-published ${label} is edited".replace("${label}", resource.label));
  } else {
    const firstId = asInt(rows[0]?.["id"]);
    help.push(
      `Run \`wordpress-axi request GET ${resource.route}/${id}/revisions/${firstId ?? "<revisionId>"} --json\` for a revision's full content`,
    );
  }
  out["help"] = help;
  return renderResult(out, json);
}

// ---------- shared helpers ----------

function requireId(positionals: string[], commandPath: string): string {
  const id = requirePositional(positionals, 0, "id", commandPath);
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`${commandPath}: <id> must be a numeric WordPress ID, got: ${id}`, "VALIDATION_ERROR");
  }
  return id;
}

function buildWritePayload(
  resource: ContentResource,
  values: Record<string, string | boolean | string[] | undefined>,
  commandPath: string,
  defaultStatus: string | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const title = requireString(values, "title", commandPath);
  const content = requireString(values, "content", commandPath);
  const excerpt = requireString(values, "excerpt", commandPath);
  const slug = requireString(values, "slug", commandPath);
  const status = requireString(values, "status", commandPath) ?? defaultStatus;
  const author = optionalInt(values, "author", { min: 0, max: 100_000_000 });
  if (title !== undefined) payload["title"] = title;
  if (content !== undefined) payload["content"] = content;
  if (excerpt !== undefined) payload["excerpt"] = excerpt;
  if (slug !== undefined) payload["slug"] = slug;
  if (status !== undefined) {
    if (!/^[a-z_,]+$/.test(status)) {
      throw new AxiError(`--status must be a WordPress status like draft or publish, got: ${status}`, "VALIDATION_ERROR", [STATUS_HELP]);
    }
    payload["status"] = status;
  }
  if (author !== undefined) payload["author"] = author;
  if (resource.supportsCategories) {
    const categories = splitCsvInts(values["categories"], "categories");
    if (categories.length > 0) payload["categories"] = categories;
  }
  if (resource.supportsTags) {
    const tags = splitCsvInts(values["tags"], "tags");
    if (tags.length > 0) payload["tags"] = tags;
  }
  if (resource.supportsParent) {
    const parent = optionalInt(values, "parent", { min: 0, max: 100_000_000 });
    if (parent !== undefined) payload["parent"] = parent;
  }
  const body = parseJsonFlag(values, "body");
  return body ? { ...payload, ...body } : payload;
}

/** Publication is explicit: making content publicly visible needs --confirm. */
function guardPublishStatus(
  resource: ContentResource,
  payload: Record<string, unknown>,
  values: Record<string, string | boolean | string[] | undefined>,
  commandPath: string,
): void {
  const status = payload["status"];
  if (typeof status === "string" && isPublishStatus(status) && values["confirm"] !== true) {
    requireConfirm(values, commandPath, `write the ${resource.label} with status=${status} (publicly visible)`);
  }
}

function createdSummary(resource: ContentResource, data: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: asInt(data["id"]),
    title: snippet(renderedText(data["title"]), 80),
    status: asString(data["status"]),
    link: asString(data["link"]),
    label: resource.label,
  });
}

function joinIds(ids: number[]): string | undefined {
  return ids.length > 0 ? ids.join(",") : undefined;
}

function asRecordArraySafe(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined);
  }
  return [];
}

function stripToText(field: unknown): string {
  return renderedText(field) ?? "";
}
