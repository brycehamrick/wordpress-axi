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
  splitCsv,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet, truncateText } from "../lib/truncate.js";
import { renderedText, shortDate } from "../lib/format.js";
import { asInt, asRecord, asString, compact, projectRow } from "../lib/rows.js";
import { buildUploadPayload } from "../lib/upload.js";
import type { CommandContext } from "../context.js";

/**
 * Media library: list, inspect, upload, edit metadata, delete. Uploads POST
 * raw binary to /wp/v2/media with an RFC 5987 filename, then patch metadata
 * as a second call - the same two-step flow as the original Python helper.
 *
 * WordPress attachments do not support trashing in core, so deletes are
 * permanent and always require --confirm.
 */

export const MEDIA_HELP = `wordpress-axi media - manage the media library

subcommands (read):
  media list                          attachments newest-first
  media get <id>                      file URL, alt text, caption, dimensions

subcommands (write):
  media upload <file>                 upload a local file, then set metadata
  media update <id> --alt "..."       edit title, alt text, caption, description
  media delete <id>                   delete permanently (requires --confirm; no trash)

list flags:
  --mime-type <type>       exact MIME filter (e.g. image/jpeg)
  --media-type <type>      image, video, audio, application, text
  --search <text>          keyword search over titles and metadata
  --author <id>            filter by uploader ID
  --parent <id>            filter by attached post ID
  --limit <n>              per page, 1-100 (default 10)
  --page <n>               page number
  --fields <csv>           raw response fields instead of the default four
  --json                   machine-readable JSON instead of TOON

upload flags:
  --title <text> --alt <text> --caption <text> --description <text>
  --post <id>              attach to a parent post
  --json                   machine-readable JSON instead of TOON

examples:
  wordpress-axi media list --media-type image --limit 10
  wordpress-axi media upload ./hero.jpg --alt "Team at the offsite" --title "Team offsite"
  wordpress-axi media update 91 --alt "Chart of Q3 revenue"
  wordpress-axi media delete 91 --confirm`;

const LIST_FLAGS: Record<string, FlagDefinition> = {
  "mime-type": { type: "string" },
  "media-type": { type: "string" },
  search: { type: "string" },
  author: { type: "string" },
  parent: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  fields: { type: "string" },
  json: { type: "boolean" },
};

const GET_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

const UPLOAD_FLAGS: Record<string, FlagDefinition> = {
  title: { type: "string" },
  alt: { type: "string" },
  caption: { type: "string" },
  description: { type: "string" },
  post: { type: "string" },
  json: { type: "boolean" },
};

const UPDATE_FLAGS: Record<string, FlagDefinition> = {
  title: { type: "string" },
  alt: { type: "string" },
  caption: { type: "string" },
  description: { type: "string" },
  post: { type: "string" },
  body: { type: "string" },
  json: { type: "boolean" },
};

const DELETE_FLAGS: Record<string, FlagDefinition> = {
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const MEDIA_TYPES = ["image", "video", "audio", "application", "text"] as const;

export async function mediaCommand(
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return mediaList(rest, ctx);
    case "get":
      return mediaGet(rest, ctx);
    case "upload":
      return mediaUpload(rest, ctx);
    case "update":
      return mediaUpdate(rest, ctx);
    case "delete":
      return mediaDelete(rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: MEDIA_HELP };
    default:
      throw new AxiError(`unknown media subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `wordpress-axi media --help` to see list, get, upload, update, delete",
      ]);
  }
}

async function mediaList(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi media list";
  const { values, positionals } = parseFlags(args, commandPath, LIST_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 10;
  const page = optionalInt(values, "page", { min: 1, max: 10_000 }) ?? 1;
  const mediaType = oneOf(values, "media-type", MEDIA_TYPES);
  const fields = splitCsv(values["fields"] as string | undefined);

  const { data, meta } = await ctx.client.list("wp/v2/media", {
    per_page: limit,
    page,
    mime_type: requireString(values, "mime-type", commandPath),
    media_type: mediaType,
    search: requireString(values, "search", commandPath),
    author: optionalInt(values, "author", { min: 0, max: 100_000_000 }),
    parent: optionalInt(values, "parent", { min: 0, max: 100_000_000 }),
  });
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const projected = rows.map((row) =>
    fields.length > 0
      ? projectRow(row, fields)
      : compact({
          id: asInt(row["id"]),
          title: snippet(renderedText(row["title"]), 50),
          mime: asString(row["mime_type"]),
          date: shortDate(row["date"]),
        }),
  );
  const out: Record<string, unknown> = {
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    media: projected,
  };
  if (rows.length === 0) {
    out["result"] = "0 media \u2014 nothing matched this filter";
    help.push("Run `wordpress-axi media upload <file>` to add an attachment");
  } else {
    const firstId = asInt(rows[0]?.["id"]);
    if (firstId !== undefined) {
      help.push(`Run \`wordpress-axi media get ${firstId}\` for the file URL and metadata`);
    }
    if (meta.total !== undefined && page * limit < meta.total) {
      help.push(`${meta.total - page * limit} more \u2014 rerun with --page ${page + 1}`);
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}

async function mediaGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi media get";
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", `wp/v2/media/${id}`);
  const details = asRecord(data["media_details"]);
  const caption = renderedText(data["caption"]);
  const description = renderedText(data["description"]);
  const full = values["full"] === true;
  const out: Record<string, unknown> = {
    media: compact({
      id: asInt(data["id"]),
      title: renderedText(data["title"]),
      mime: asString(data["mime_type"]),
      date: asString(data["date"]),
      source_url: asString(data["source_url"]),
      alt_text: asString(data["alt_text"]),
      caption: full ? caption : truncateText(caption ?? "", 300).value,
      description: full ? description : truncateText(description ?? "", 300).value,
      width: asInt(details?.["width"]),
      height: asInt(details?.["height"]),
      filesize: asInt(details?.["filesize"]),
      post: asInt(data["post"]),
    }),
    help: [
      `Use in content: \`wordpress-axi post update <postId> --content '<img src="${asString(data["source_url"]) ?? "<url>"}" alt="...">'\``,
      `Run \`wordpress-axi media update ${id} --alt "..."\` to fix missing alt text`,
    ],
  };
  return renderResult(out, values["json"] === true);
}

async function mediaUpload(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi media upload";
  const { values, positionals } = parseFlags(args, commandPath, UPLOAD_FLAGS);
  const file = requirePositional(positionals, 0, "file", commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  const payload = await buildUploadPayload(file);
  const { data } = await ctx.client.request<Record<string, unknown>>("POST", "wp/v2/media", {
    raw: {
      body: payload.body,
      contentType: payload.contentType,
      disposition: payload.disposition,
    },
  });
  const id = asInt(data["id"]);

  const metadata: Record<string, unknown> = {};
  const title = requireString(values, "title", commandPath);
  const alt = requireString(values, "alt", commandPath);
  const caption = requireString(values, "caption", commandPath);
  const description = requireString(values, "description", commandPath);
  const post = optionalInt(values, "post", { min: 0, max: 100_000_000 });
  if (title !== undefined) metadata["title"] = title;
  if (alt !== undefined) metadata["alt_text"] = alt;
  if (caption !== undefined) metadata["caption"] = caption;
  if (description !== undefined) metadata["description"] = description;
  if (post !== undefined) metadata["post"] = post;

  let final = data;
  if (id !== undefined && Object.keys(metadata).length > 0) {
    const patched = await ctx.client.request<Record<string, unknown>>(
      "POST",
      `wp/v2/media/${id}`,
      { body: metadata },
    );
    final = patched.data;
  }

  return renderResult(
    {
      uploaded: compact({
        id: asInt(final["id"]),
        title: renderedText(final["title"]),
        source_url: asString(final["source_url"]),
        alt_text: asString(final["alt_text"]),
        mime: asString(final["mime_type"]),
        filename: payload.filename,
      }),
      help: [
        "Reference it in content with the source_url",
        `Run \`wordpress-axi media get ${id ?? "<id>"}\` to verify metadata`,
      ],
    },
    json,
  );
}

async function mediaUpdate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi media update";
  const { values, positionals } = parseFlags(args, commandPath, UPDATE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  const payload: Record<string, unknown> = {};
  const title = requireString(values, "title", commandPath);
  const alt = requireString(values, "alt", commandPath);
  const caption = requireString(values, "caption", commandPath);
  const description = requireString(values, "description", commandPath);
  const post = optionalInt(values, "post", { min: 0, max: 100_000_000 });
  if (title !== undefined) payload["title"] = title;
  if (alt !== undefined) payload["alt_text"] = alt;
  if (caption !== undefined) payload["caption"] = caption;
  if (description !== undefined) payload["description"] = description;
  if (post !== undefined) payload["post"] = post;
  const body = parseJsonFlag(values, "body");
  const merged = body ? { ...payload, ...body } : payload;
  if (Object.keys(merged).length === 0) {
    throw new AxiError(
      "media update needs at least one field to change",
      "VALIDATION_ERROR",
      [`Example: wordpress-axi media update ${id} --alt "Descriptive alternative text"`],
    );
  }

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    `wp/v2/media/${id}`,
    { body: merged },
  );
  return renderResult(
    {
      updated: compact({
        id: asInt(data["id"]),
        title: renderedText(data["title"]),
        alt_text: asString(data["alt_text"]),
      }),
      help: [`Run \`wordpress-axi media get ${id}\` to verify`],
    },
    json,
  );
}

async function mediaDelete(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi media delete";
  const { values, positionals } = parseFlags(args, commandPath, DELETE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `permanently delete media ${id} (attachments have no trash)`);

  await ctx.client.request("DELETE", `wp/v2/media/${id}`, { query: { force: true } });
  return renderResult(
    {
      deleted: { id, mode: "permanently" },
      help: [
        "Posts embedding this file will show a broken image - update them if needed",
        "Run `wordpress-axi media list` to confirm the library",
      ],
    },
    json,
  );
}

function requireId(positionals: string[], commandPath: string): string {
  const id = requirePositional(positionals, 0, "id", commandPath);
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`${commandPath}: <id> must be a numeric WordPress ID, got: ${id}`, "VALIDATION_ERROR");
  }
  return id;
}
