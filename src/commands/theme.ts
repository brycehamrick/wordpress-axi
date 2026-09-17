import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  oneOf,
  parseFlags,
  requireConfirm,
  requirePositional,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { asRecord, asString, compact } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * Themes. Activation switches the entire site's appearance, so it requires
 * --confirm. Theme identifiers look like "twentytwentyfive".
 */

export const THEME_HELP = `wordpress-axi theme - inspect installed themes and switch the active one

subcommands:
  theme list                installed themes with status and version
  theme get <theme>         one theme's details
  theme activate <theme>    make a theme live site-wide (requires --confirm)

list flags:
  --status <s>     active or inactive
  --json           machine-readable JSON instead of TOON

examples:
  wordpress-axi theme list
  wordpress-axi theme get twentytwentyfive
  wordpress-axi theme activate twentytwentyfive --confirm`;

const LIST_FLAGS: Record<string, FlagDefinition> = {
  status: { type: "string" },
  json: { type: "boolean" },
};

const GET_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

const ACTIVATE_FLAGS: Record<string, FlagDefinition> = {
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

function themeRoute(theme: string): string {
  return `wp/v2/themes/${encodeURIComponent(theme)}`;
}

function requireTheme(positionals: string[], commandPath: string): string {
  const theme = requirePositional(positionals, 0, "theme", commandPath);
  if (!/^[\w.\-]+$/.test(theme)) {
    throw new AxiError(
      `${commandPath}: <theme> must be a theme slug like twentytwentyfive`,
      "VALIDATION_ERROR",
      ["Run `wordpress-axi theme list` to see installed themes"],
    );
  }
  return theme;
}

function themeRow(row: Record<string, unknown>): Record<string, unknown> {
  return compact({
    theme: asString(row["theme"]),
    name: asString(row["name"]),
    status: asString(row["status"]),
    version: asString(row["version"]),
  });
}

export async function themeCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return themeList(rest, ctx);
    case "get":
      return themeGet(rest, ctx);
    case "activate":
      return themeActivate(rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: THEME_HELP };
    default:
      throw new AxiError(`unknown theme subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `wordpress-axi theme --help` to see list, get, activate",
      ]);
  }
}

async function themeList(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi theme list";
  const { values, positionals } = parseFlags(args, commandPath, LIST_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const status = oneOf(values, "status", ["active", "inactive"] as const);

  const { data } = await ctx.client.list("wp/v2/themes", { status });
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const out: Record<string, unknown> = {
    count: rows.length,
    themes: rows.map(themeRow),
  };
  if (rows.length === 0) {
    out["result"] = "0 themes \u2014 nothing matched this filter";
  } else {
    const active = rows.find((row) => asString(row["status"]) === "active");
    help.push(
      active !== undefined
        ? `Active theme: ${asString(active["theme"]) ?? "unknown"}`
        : "No active theme visible - the API user may lack theme permissions",
    );
    const inactive = rows.find((row) => asString(row["status"]) !== "active");
    if (inactive !== undefined) {
      const slug = asString(inactive["theme"]);
      if (slug !== undefined) {
        help.push(`Run \`wordpress-axi theme activate ${slug} --confirm\` to switch`);
      }
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}

async function themeGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi theme get";
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const theme = requireTheme(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", themeRoute(theme));
  const out: Record<string, unknown> = {
    theme: compact({
      theme: asString(data["theme"]),
      name: asString(data["name"]),
      status: asString(data["status"]),
      version: asString(data["version"]),
      author: asRecord(data["author"]) !== undefined ? asString(asRecord(data["author"])?.["display_name"]) : undefined,
      description: snippet(asString(data["description"]), 200),
      requires_wp: asString(data["requires_wp"]),
      requires_php: asString(data["requires_php"]),
      screenshot: asArraySafe(data["screenshot"]),
    }),
    help: [`Run \`wordpress-axi theme activate ${theme} --confirm\` to make it live`],
  };
  return renderResult(out, values["json"] === true);
}

async function themeActivate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi theme activate";
  const { values, positionals } = parseFlags(args, commandPath, ACTIVATE_FLAGS);
  const theme = requireTheme(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  requireConfirm(values, commandPath, `activate theme ${theme} site-wide (changes the whole site's appearance)`);

  const { data } = await ctx.client.request<Record<string, unknown>>("POST", themeRoute(theme), {
    body: { status: "active" },
  });
  return renderResult(
    {
      activated: themeRow(data),
      help: [
        "Run `wordpress-axi theme list` to verify the active theme",
        "Widgets, menus, and customizer settings may need attention after a switch",
      ],
    },
    json,
  );
}

function asArraySafe(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}
