import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  optionalInt,
  parseFlags,
  parseJsonFlag,
  requireConfirm,
  requireString,
  oneOf,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { asInt, asRecord, asString, compact } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * Site settings (requires manage_options). Reads are cheap single calls;
 * writes change the whole site, so `settings set` requires --confirm.
 */

export const SETTINGS_HELP = `wordpress-axi settings - read and update site settings

subcommands:
  settings get          title, tagline, timezone, formats, defaults
  settings set --...    update one or more settings (requires --confirm)

set flags (all optional, at least one required):
  --title <text>             site title
  --description <text>       tagline
  --timezone <tz>            e.g. America/New_York, UTC
  --date-format <fmt>        e.g. F j, Y
  --time-format <fmt>        e.g. g:i a
  --language <code>          e.g. en_US
  --posts-per-page <n>       blog pages show at most N posts
  --default-category <id>    default post category ID
  --default-comment-status <open|close>   new posts accept comments
  --default-ping-status <open|close>      new posts accept pings
  --body <json>              raw JSON payload merged last
  --confirm                  required to apply changes

examples:
  wordpress-axi settings get
  wordpress-axi settings set --title "The Daily Post" --confirm
  wordpress-axi settings set --timezone America/Chicago --posts-per-page 12 --confirm`;

const GET_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

const SET_FLAGS: Record<string, FlagDefinition> = {
  title: { type: "string" },
  description: { type: "string" },
  timezone: { type: "string" },
  "date-format": { type: "string" },
  "time-format": { type: "string" },
  language: { type: "string" },
  "posts-per-page": { type: "string" },
  "default-category": { type: "string" },
  "default-comment-status": { type: "string" },
  "default-ping-status": { type: "string" },
  body: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

export async function settingsCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "get":
      return settingsGet(rest, ctx);
    case "set":
      return settingsSet(rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: SETTINGS_HELP };
    default:
      throw new AxiError(`unknown settings subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `wordpress-axi settings --help` to see get, set",
      ]);
  }
}

async function settingsGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi settings get";
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", "wp/v2/settings");
  const settings = asRecord(data) ?? {};
  const out: Record<string, unknown> = {
    settings: compact({
      title: asString(settings["title"]),
      description: asString(settings["description"]),
      url: asString(settings["url"]),
      timezone: asString(settings["timezone"]),
      date_format: asString(settings["date_format"]),
      time_format: asString(settings["time_format"]),
      start_of_week: asInt(settings["start_of_week"]),
      language: asString(settings["language"]),
      use_smilies: typeof settings["use_smilies"] === "boolean" ? settings["use_smilies"] : undefined,
      default_category: asInt(settings["default_category"]),
      default_post_format: asString(settings["default_post_format"]),
      posts_per_page: asInt(settings["posts_per_page"]),
      default_ping_status: asString(settings["default_ping_status"]),
      default_comment_status: asString(settings["default_comment_status"]),
    }),
    help: [
      'Run `wordpress-axi settings set --title "..." --confirm` to change one',
      "Settings changes apply site-wide",
    ],
  };
  return renderResult(out, values["json"] === true);
}

async function settingsSet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi settings set";
  const { values, positionals } = parseFlags(args, commandPath, SET_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const json = values["json"] === true;

  const payload: Record<string, unknown> = {};
  const title = requireString(values, "title", commandPath);
  const description = requireString(values, "description", commandPath);
  const timezone = requireString(values, "timezone", commandPath);
  const dateFormat = requireString(values, "date-format", commandPath);
  const timeFormat = requireString(values, "time-format", commandPath);
  const language = requireString(values, "language", commandPath);
  const postsPerPage = optionalInt(values, "posts-per-page", { min: 1, max: 1000 });
  const defaultCategory = optionalInt(values, "default-category", { min: 0, max: 100_000_000 });
  const commentStatus = oneOf(values, "default-comment-status", ["open", "close"] as const);
  const pingStatus = oneOf(values, "default-ping-status", ["open", "close"] as const);
  if (title !== undefined) payload["title"] = title;
  if (description !== undefined) payload["description"] = description;
  if (timezone !== undefined) payload["timezone"] = timezone;
  if (dateFormat !== undefined) payload["date_format"] = dateFormat;
  if (timeFormat !== undefined) payload["time_format"] = timeFormat;
  if (language !== undefined) payload["language"] = language;
  if (postsPerPage !== undefined) payload["posts_per_page"] = postsPerPage;
  if (defaultCategory !== undefined) payload["default_category"] = defaultCategory;
  if (commentStatus !== undefined) payload["default_comment_status"] = commentStatus;
  if (pingStatus !== undefined) payload["default_ping_status"] = pingStatus;
  const body = parseJsonFlag(values, "body");
  const merged = body ? { ...payload, ...body } : payload;
  if (Object.keys(merged).length === 0) {
    throw new AxiError("settings set needs at least one setting to change", "VALIDATION_ERROR", [
      'Example: wordpress-axi settings set --title "New title" --confirm',
    ]);
  }

  const summary = Object.entries(merged)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  requireConfirm(values, commandPath, `change site settings: ${summary}`);

  const { data } = await ctx.client.request<Record<string, unknown>>("PATCH", "wp/v2/settings", {
    body: merged,
  });
  const settings = asRecord(data) ?? {};
  return renderResult(
    {
      updated: compact({
        title: asString(settings["title"]),
        description: asString(settings["description"]),
        timezone: asString(settings["timezone"]),
        posts_per_page: asInt(settings["posts_per_page"]),
      }),
      help: ["Run `wordpress-axi settings get` to verify all values"],
    },
    json,
  );
}
