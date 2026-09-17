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
import { renderedText } from "../lib/format.js";
import { snippet, truncateText } from "../lib/truncate.js";
import { asInt, asRecord, asString, compact, projectRow } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * Comments: read, create, reply, and moderate. Moderation verbs (approve,
 * unapprove, spam, trash) and delete all require --confirm because every
 * one of them changes what site visitors can see (publication is explicit).
 */

export const COMMENT_HELP = `wordpress-axi comment - read, create, reply, and moderate comments

subcommands (read):
  comment list                        comments with status and excerpts
  comment get <id>                    one comment with content

subcommands (write):
  comment create --post <id> --content "..."   add a comment
  comment reply <id> --content "..."           reply to a comment
  comment approve <id>                make public (requires --confirm)
  comment unapprove <id>              hold for review (requires --confirm)
  comment spam <id>                   mark as spam (requires --confirm)
  comment trash <id>                  move to trash (requires --confirm)
  comment delete <id>                 delete permanently (requires --confirm; --force skips trash)

list flags:
  --post <id>              comments on one post
  --status <s>             approve (default), hold, spam, trash, all
  --search <text>          keyword search
  --author-email <email>   filter by author email
  --parent <id>            replies to one comment
  --limit <n>              per page, 1-100 (default 10)
  --page <n>               page number
  --fields <csv>           raw response fields instead of the default five
  --json                   machine-readable JSON instead of TOON

create/reply flags:
  --content <text>         required comment body
  --author-name <name> --author-email <email> --author-url <url>
  --status <s>             approve or hold (needs moderate_comments capability)
  --json                   machine-readable JSON instead of TOON

examples:
  wordpress-axi comment list --status hold --limit 20
  wordpress-axi comment approve 1042 --confirm
  wordpress-axi comment reply 1042 --content "Thanks for the report - fixed in 2.1"
  wordpress-axi comment spam 1043 --confirm`;

const LIST_FLAGS: Record<string, FlagDefinition> = {
  post: { type: "string" },
  status: { type: "string" },
  search: { type: "string" },
  "author-email": { type: "string" },
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

const CREATE_FLAGS: Record<string, FlagDefinition> = {
  post: { type: "string" },
  content: { type: "string" },
  "author-name": { type: "string" },
  "author-email": { type: "string" },
  "author-url": { type: "string" },
  status: { type: "string" },
  body: { type: "string" },
  json: { type: "boolean" },
};

const REPLY_FLAGS: Record<string, FlagDefinition> = {
  content: { type: "string" },
  "author-name": { type: "string" },
  "author-email": { type: "string" },
  status: { type: "string" },
  body: { type: "string" },
  json: { type: "boolean" },
};

const MODERATE_FLAGS: Record<string, FlagDefinition> = {
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const DELETE_FLAGS: Record<string, FlagDefinition> = {
  force: { type: "boolean" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const LIST_STATUSES = ["approve", "hold", "spam", "trash", "all"] as const;

export async function commentCommand(
  args: string[],
  ctx: CommandContext,
): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return commentList(rest, ctx);
    case "get":
      return commentGet(rest, ctx);
    case "create":
      return commentCreate(rest, ctx);
    case "reply":
      return commentReply(rest, ctx);
    case "approve":
      return moderate(rest, ctx, "approve", "publish comment");
    case "unapprove":
      return moderate(rest, ctx, "hold", "hold comment for review");
    case "spam":
      return moderate(rest, ctx, "spam", "mark comment as spam");
    case "trash":
      return moderate(rest, ctx, "trash", "move comment to trash");
    case "delete":
      return commentDelete(rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: COMMENT_HELP };
    default:
      throw new AxiError(`unknown comment subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `wordpress-axi comment --help` to see list, get, create, reply, approve, unapprove, spam, trash, delete",
      ]);
  }
}

async function commentList(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi comment list";
  const { values, positionals } = parseFlags(args, commandPath, LIST_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 10;
  const page = optionalInt(values, "page", { min: 1, max: 10_000 }) ?? 1;
  const status = requireString(values, "status", commandPath) ?? "approve";
  const fields = splitCsv(values["fields"] as string | undefined);

  const { data, meta } = await ctx.client.list("wp/v2/comments", {
    per_page: limit,
    page,
    post: optionalInt(values, "post", { min: 0, max: 100_000_000 }),
    status,
    search: requireString(values, "search", commandPath),
    author_email: requireString(values, "author-email", commandPath),
    parent: optionalInt(values, "parent", { min: 0, max: 100_000_000 }),
  });
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const projected = rows.map((row) =>
    fields.length > 0
      ? projectRow(row, fields)
      : compact({
          id: asInt(row["id"]),
          post: asInt(row["post"]),
          author: asString(row["author_name"]),
          date: typeof row["date"] === "string" ? (row["date"] as string).slice(0, 10) : undefined,
          excerpt: snippet(renderedText(row["content"]), 60),
        }),
  );
  const out: Record<string, unknown> = {
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    comments: projected,
  };
  if (rows.length === 0) {
    out["result"] = `0 comments with status=${status} \u2014 queue is clear`;
    help.push("Run `wordpress-axi comment list --status all` to see every comment");
  } else {
    const firstId = asInt(rows[0]?.["id"]);
    if (firstId !== undefined) {
      help.push(`Run \`wordpress-axi comment get ${firstId}\` for the full text`);
      if (status === "hold") {
        help.push(`Run \`wordpress-axi comment approve ${firstId} --confirm\` to publish it`);
      }
    }
    if (meta.total !== undefined && page * limit < meta.total) {
      help.push(`${meta.total - page * limit} more \u2014 rerun with --page ${page + 1}`);
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}

async function commentGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi comment get";
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const full = values["full"] === true;

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", `wp/v2/comments/${id}`);
  const text = renderedText(data["content"]) ?? "";
  const content = full ? text : truncateText(text, 800).value;
  const out: Record<string, unknown> = {
    comment: compact({
      id: asInt(data["id"]),
      post: asInt(data["post"]),
      parent: asInt(data["parent"]),
      author: asString(data["author_name"]),
      author_email: asString(data["author_email"]),
      date: asString(data["date"]),
      status: asString(data["status"]),
      link: asString(data["link"]),
      content,
    }),
    help: [
      `Run \`wordpress-axi comment approve ${id} --confirm\` to publish (if held)`,
      `Run \`wordpress-axi comment reply ${id} --content "..."\` to respond`,
    ],
  };
  if (!full && text.length > 800) {
    out["help"] = [
      ...(Array.isArray(out["help"]) ? (out["help"] as string[]) : []),
      "content truncated \u2014 rerun with --full for complete text",
    ];
  }
  return renderResult(out, values["json"] === true);
}

async function commentCreate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi comment create";
  const { values } = parseFlags(args, commandPath, CREATE_FLAGS);
  const json = values["json"] === true;
  const post = optionalInt(values, "post", { min: 0, max: 100_000_000 });
  if (post === undefined) {
    throw new AxiError("comment create requires --post <id>", "VALIDATION_ERROR", [
      'Example: wordpress-axi comment create --post 42 --content "Great write-up"',
    ]);
  }
  const payload = buildCommentPayload(values, commandPath);
  payload["post"] = post;

  const { data } = await ctx.client.request<Record<string, unknown>>("POST", "wp/v2/comments", {
    body: payload,
  });
  return renderResult(
    {
      created: commentSummary(data),
      help: [
        `Run \`wordpress-axi comment get ${asInt(data["id"]) ?? "<id>"}\` to verify`,
        "New comments follow the site's moderation settings",
      ],
    },
    json,
  );
}

async function commentReply(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi comment reply";
  const { values, positionals } = parseFlags(args, commandPath, REPLY_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  // Combined operation: fetch the parent to learn its post, then reply in
  // one logical step (the agent does not need to know the post ID).
  const parent = await ctx.client.request<Record<string, unknown>>("GET", `wp/v2/comments/${id}`);
  const postId = asInt(parent.data["post"]);
  if (postId === undefined) {
    throw new AxiError(`comment ${id} is not attached to a post; use comment create --post instead`, "VALIDATION_ERROR");
  }
  const payload = buildCommentPayload(values, commandPath);
  payload["post"] = postId;
  payload["parent"] = Number(id);

  const { data } = await ctx.client.request<Record<string, unknown>>("POST", "wp/v2/comments", {
    body: payload,
  });
  return renderResult(
    {
      created: commentSummary(data),
      help: [
        `Run \`wordpress-axi comment get ${asInt(data["id"]) ?? "<id>"}\` to verify`,
        `Run \`wordpress-axi comment list --post ${postId}\` for the thread`,
      ],
    },
    json,
  );
}

async function moderate(
  args: string[],
  ctx: CommandContext,
  status: "approve" | "hold" | "spam" | "trash",
  preview: string,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi comment ${status === "approve" ? "approve" : status === "hold" ? "unapprove" : status}`;
  const { values, positionals } = parseFlags(args, commandPath, MODERATE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `${preview} ${id}`);

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    `wp/v2/comments/${id}`,
    { body: { status } },
  );
  return renderResult(
    {
      moderated: compact({
        id: asInt(data["id"]),
        status: asString(data["status"]),
      }),
      help: [
        `Run \`wordpress-axi comment get ${id}\` to verify`,
        "Run `wordpress-axi comment list` to see the current queue",
      ],
    },
    json,
  );
}

async function commentDelete(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi comment delete";
  const { values, positionals } = parseFlags(args, commandPath, DELETE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const force = values["force"] === true;
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `${force ? "permanently delete" : "trash"} comment ${id}`);

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "DELETE",
    `wp/v2/comments/${id}`,
    { query: { force } },
  );
  const permanent = data["deleted"] === true;
  return renderResult(
    {
      deleted: { id, mode: force || permanent ? "permanently" : "trash" },
      help: ["Run `wordpress-axi comment list --status trash` to see trashed comments"],
    },
    json,
  );
}

function buildCommentPayload(
  values: Record<string, string | boolean | string[] | undefined>,
  commandPath: string,
): Record<string, unknown> {
  const content = requireString(values, "content", commandPath);
  if (content === undefined) {
    throw new AxiError("--content is required", "VALIDATION_ERROR", [
      `Run \`${commandPath} --help\` for usage`,
    ]);
  }
  const payload: Record<string, unknown> = { content };
  const authorName = requireString(values, "author-name", commandPath);
  const authorEmail = requireString(values, "author-email", commandPath);
  const authorUrl = requireString(values, "author-url", commandPath);
  const status = oneOf(values, "status", ["approve", "hold"] as const);
  if (authorName !== undefined) payload["author_name"] = authorName;
  if (authorEmail !== undefined) payload["author_email"] = authorEmail;
  if (authorUrl !== undefined) payload["author_url"] = authorUrl;
  if (status !== undefined) payload["status"] = status;
  const body = parseJsonFlag(values, "body");
  return body ? { ...payload, ...body } : payload;
}

function commentSummary(data: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: asInt(data["id"]),
    post: asInt(data["post"]),
    status: asString(data["status"]),
    author: asString(data["author_name"]),
    link: asString(data["link"]),
  });
}

function requireId(positionals: string[], commandPath: string): string {
  const id = requirePositional(positionals, 0, "id", commandPath);
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`${commandPath}: <id> must be a numeric WordPress ID, got: ${id}`, "VALIDATION_ERROR");
  }
  return id;
}
