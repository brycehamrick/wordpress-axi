import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  oneOf,
  optionalInt,
  parseFlags,
  requireConfirm,
  requirePositional,
  requireString,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { asRecord, asString, compact } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * Plugins. Plugin identifiers look like "akismet/akismet" - a directory,
 * file, and slashes. REST routes percent-encode the slashes, which this
 * command does automatically. Activate/deactivate/delete change what the
 * site executes, so all three require --confirm.
 */

export const PLUGIN_HELP = `wordpress-axi plugin - inspect and manage installed plugins

subcommands (read):
  plugin list                     installed plugins with status and version
  plugin get <plugin>             one plugin's details

subcommands (write, all require --confirm):
  plugin activate <plugin>        enable the plugin site-wide
  plugin deactivate <plugin>      disable the plugin
  plugin delete <plugin>          remove the plugin files (must be inactive)

list flags:
  --search <text>      keyword search
  --status <s>         active or inactive
  --limit <n>          per page, 1-100 (default 20)
  --json               machine-readable JSON instead of TOON

plugin identifiers look like "akismet/akismet" (directory/file). Use the id
from \`plugin list\`.

examples:
  wordpress-axi plugin list --status inactive
  wordpress-axi plugin activate woocommerce/woocommerce --confirm
  wordpress-axi plugin delete akismet/akismet --confirm`;

const LIST_FLAGS: Record<string, FlagDefinition> = {
  search: { type: "string" },
  status: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  json: { type: "boolean" },
};

const GET_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

const WRITE_FLAGS: Record<string, FlagDefinition> = {
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

export async function pluginCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return pluginList(rest, ctx);
    case "get":
      return pluginGet(rest, ctx);
    case "activate":
      return pluginStatus(rest, ctx, "active", "activate plugin");
    case "deactivate":
      return pluginStatus(rest, ctx, "inactive", "deactivate plugin");
    case "delete":
      return pluginDelete(rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: PLUGIN_HELP };
    default:
      throw new AxiError(`unknown plugin subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `wordpress-axi plugin --help` to see list, get, activate, deactivate, delete",
      ]);
  }
}

function pluginRoute(plugin: string): string {
  return `wp/v2/plugins/${encodeURIComponent(plugin)}`;
}

function requirePlugin(positionals: string[], commandPath: string): string {
  const plugin = requirePositional(positionals, 0, "plugin", commandPath);
  if (!/^[\w.\-\/]+$/.test(plugin) || !plugin.includes("/")) {
    throw new AxiError(
      `${commandPath}: <plugin> must look like "directory/file", e.g. akismet/akismet`,
      "VALIDATION_ERROR",
      ["Run `wordpress-axi plugin list` to see installed plugin ids"],
    );
  }
  return plugin;
}

function pluginRow(row: Record<string, unknown>): Record<string, unknown> {
  return compact({
    plugin: asString(row["plugin"]),
    name: asString(row["name"]),
    status: asString(row["status"]),
    version: asString(row["version"]),
  });
}

function pluginDetail(row: Record<string, unknown>): Record<string, unknown> {
  return compact({
    plugin: asString(row["plugin"]),
    name: asString(row["name"]),
    status: asString(row["status"]),
    version: asString(row["version"]),
    author: asString(row["author"]),
    description: snippet(asString(row["description"])?.replace(/<[^>]*>/g, " "), 200),
    network: typeof row["network_only"] === "boolean" ? row["network_only"] : undefined,
    requires_wp: asString(row["requires_wp"]),
    requires_php: asString(row["requires_php"]),
  });
}

async function pluginList(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi plugin list";
  const { values, positionals } = parseFlags(args, commandPath, LIST_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 20;
  const status = oneOf(values, "status", ["active", "inactive"] as const);

  const { data, meta } = await ctx.client.list("wp/v2/plugins", {
    per_page: limit,
    search: requireString(values, "search", commandPath),
    status,
  });
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const out: Record<string, unknown> = {
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    plugins: rows.map(pluginRow),
  };
  if (rows.length === 0) {
    out["result"] = "0 plugins \u2014 nothing matched this filter";
    help.push("Plugins are installed in wp-admin; the REST API cannot upload new ones");
  } else {
    const first = asString(rows[0]?.["plugin"]);
    if (first !== undefined) {
      help.push(`Run \`wordpress-axi plugin get ${first}\` for details`);
      help.push(`Run \`wordpress-axi plugin activate ${first} --confirm\` to enable`);
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}

async function pluginGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi plugin get";
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const plugin = requirePlugin(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", pluginRoute(plugin));
  const help: string[] = [];
  const status = asString(data["status"]);
  if (status === "active") {
    help.push(`Run \`wordpress-axi plugin deactivate ${plugin} --confirm\` to disable`);
  } else {
    help.push(`Run \`wordpress-axi plugin activate ${plugin} --confirm\` to enable`);
    help.push(`Run \`wordpress-axi plugin delete ${plugin} --confirm\` to remove files`);
  }
  const out: Record<string, unknown> = { plugin: pluginDetail(data), help };
  return renderResult(out, values["json"] === true);
}

async function pluginStatus(
  args: string[],
  ctx: CommandContext,
  status: "active" | "inactive",
  preview: string,
): Promise<AxiRenderable> {
  const commandPath = `wordpress-axi plugin ${status === "active" ? "activate" : "deactivate"}`;
  const { values, positionals } = parseFlags(args, commandPath, WRITE_FLAGS);
  const plugin = requirePlugin(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `${preview} ${plugin} (changes what the site runs)`);

  const { data } = await ctx.client.request<Record<string, unknown>>("POST", pluginRoute(plugin), {
    body: { status },
  });
  return renderResult(
    {
      updated: pluginRow(data),
      help: [
        `Run \`wordpress-axi plugin get ${plugin}\` to verify`,
        "Plugin activation can change routes and site behavior",
      ],
    },
    json,
  );
}

async function pluginDelete(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi plugin delete";
  const { values, positionals } = parseFlags(args, commandPath, WRITE_FLAGS);
  const plugin = requirePlugin(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `delete plugin ${plugin} and remove its files`);

  try {
    await ctx.client.request("DELETE", pluginRoute(plugin), { query: { force: true } });
  } catch (error) {
    if (error instanceof AxiError && error.message.includes("inactive")) {
      throw new AxiError(`cannot delete ${plugin} while it is active`, "VALIDATION_ERROR", [
        `Run \`wordpress-axi plugin deactivate ${plugin} --confirm\` first`,
      ]);
    }
    throw error;
  }
  return renderResult(
    {
      deleted: { plugin },
      help: ["Run `wordpress-axi plugin list` to confirm the remaining set"],
    },
    json,
  );
}
