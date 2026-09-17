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
import { truncateText } from "../lib/truncate.js";
import { asArray, asInt, asRecord, asString, compact } from "../lib/rows.js";
import type { CommandContext } from "../context.js";

/**
 * Users: who am I, list, inspect, create, update, delete. Creating a user
 * grants site access and changing a role changes permissions, so both need
 * --confirm. If --password is omitted on create, WordPress generates one and
 * returns it exactly once - surfaced with a store-it-now warning.
 */

export const USER_HELP = `wordpress-axi user - inspect and manage site users

subcommands (read):
  user list                       users with roles
  user get <id>                   one user (--context edit shows email and registration date)

subcommands (write):
  user create --username <u> --email <e>   add a user (requires --confirm)
  user update <id> --role <r>     edit fields; role changes require --confirm
  user delete <id> --reassign <id>         delete a user, reassigning their content (requires --confirm)

list flags:
  --roles <csv>        filter by role (e.g. administrator,editor)
  --search <text>      keyword search
  --orderby <field>    name (default), id, registered_date, email
  --order <dir>        asc (default) or desc
  --limit <n>          per page, 1-100 (default 10)
  --page <n>           page number
  --json               machine-readable JSON instead of TOON

create/update flags:
  --username <u>       login name (create only, immutable)
  --email <e>          email address
  --name <text>        display name
  --first-name <text> --last-name <text>
  --role <role>        administrator, editor, author, contributor, subscriber
  --password <pw>      omit to have WordPress generate one (shown once)
  --url <url>          website
  --body <json>        raw JSON payload merged last

roles grant escalating capabilities - prefer the minimum role that lets the
person do their work. The API user itself should stay least-privilege.

examples:
  wordpress-axi user list --roles editor
  wordpress-axi user create --username janesmith --email jane@example.com --role author --confirm
  wordpress-axi user update 7 --role editor --confirm
  wordpress-axi user delete 7 --reassign 1 --confirm`;

const LIST_FLAGS: Record<string, FlagDefinition> = {
  roles: { type: "string" },
  search: { type: "string" },
  orderby: { type: "string" },
  order: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  json: { type: "boolean" },
};

const GET_FLAGS: Record<string, FlagDefinition> = {
  context: { type: "string" },
  json: { type: "boolean" },
};

const CREATE_FLAGS: Record<string, FlagDefinition> = {
  username: { type: "string" },
  email: { type: "string" },
  name: { type: "string" },
  "first-name": { type: "string" },
  "last-name": { type: "string" },
  role: { type: "string" },
  password: { type: "string" },
  url: { type: "string" },
  body: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const UPDATE_FLAGS: Record<string, FlagDefinition> = {
  email: { type: "string" },
  name: { type: "string" },
  "first-name": { type: "string" },
  "last-name": { type: "string" },
  role: { type: "string" },
  password: { type: "string" },
  url: { type: "string" },
  body: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const DELETE_FLAGS: Record<string, FlagDefinition> = {
  reassign: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const ORDERBY_FIELDS = ["name", "id", "include", "registered_date", "email"] as const;
const CONTEXTS = ["view", "embed", "edit"] as const;

export async function userCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return userList(rest, ctx);
    case "get":
      return userGet(rest, ctx);
    case "create":
      return userCreate(rest, ctx);
    case "update":
      return userUpdate(rest, ctx);
    case "delete":
      return userDelete(rest, ctx);
    case undefined:
    case "--help":
    case "help":
      return { help_text: USER_HELP };
    default:
      throw new AxiError(`unknown user subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `wordpress-axi user --help` to see list, get, create, update, delete",
      ]);
  }
}

/** `me`: the auth check - one cheap call proving credentials work. */
export async function meCommand(_args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const { data } = await ctx.client.request<Record<string, unknown>>("GET", "wp/v2/users/me", {
    query: { context: "edit" },
  });
  const capabilities = asRecord(data["capabilities"]);
  return renderResult(
    {
      me: compact({
        id: asInt(data["id"]),
        name: asString(data["name"]),
        slug: asString(data["slug"]),
        email: asString(data["email"]),
        roles: asArray(data["roles"]).filter((role): role is string => typeof role === "string"),
        capabilities: capabilities === undefined ? undefined : Object.keys(capabilities).length,
        site: ctx.config.baseUrl,
      }),
      help: [
        "Run `wordpress-axi discover` to see the site's content types and namespaces",
        "Run `wordpress-axi post list --limit 5` for recent posts",
      ],
    },
    false,
  );
}

async function userList(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi user list";
  const { values, positionals } = parseFlags(args, commandPath, LIST_FLAGS);
  forbidExtraPositionals(positionals, 0, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 10;
  const page = optionalInt(values, "page", { min: 1, max: 10_000 }) ?? 1;
  const order = oneOf(values, "order", ["asc", "desc"] as const);
  const orderby = oneOf(values, "orderby", ORDERBY_FIELDS);

  const { data, meta } = await ctx.client.list("wp/v2/users", {
    per_page: limit,
    page,
    roles: splitCsv(values["roles"] as string | undefined).join(",") || undefined,
    search: requireString(values, "search", commandPath),
    order,
    orderby,
  });
  const rows = data.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined);
  const help: string[] = [];
  const projected = rows.map((row) =>
    compact({
      id: asInt(row["id"]),
      name: asString(row["name"]),
      slug: asString(row["slug"]),
      roles: asArray(row["roles"]).filter((role): role is string => typeof role === "string"),
    }),
  );
  const out: Record<string, unknown> = {
    count: rows.length,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    users: projected,
  };
  if (rows.length === 0) {
    out["result"] = "0 users \u2014 nothing matched this filter";
  } else {
    const firstId = asInt(rows[0]?.["id"]);
    if (firstId !== undefined) {
      help.push(`Run \`wordpress-axi user get ${firstId}\` for details`);
    }
    if (meta.total !== undefined && page * limit < meta.total) {
      help.push(`${meta.total - page * limit} more \u2014 rerun with --page ${page + 1}`);
    }
  }
  out["help"] = help;
  return renderResult(out, values["json"] === true);
}

async function userGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi user get";
  const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const context = oneOf(values, "context", CONTEXTS) ?? "view";

  const { data } = await ctx.client.request<Record<string, unknown>>("GET", `wp/v2/users/${id}`, {
    query: { context },
  });
  const capabilities = asRecord(data["capabilities"]);
  const description = asString(data["description"]);
  const out: Record<string, unknown> = {
    user: compact({
      id: asInt(data["id"]),
      name: asString(data["name"]),
      slug: asString(data["slug"]),
      roles: asArray(data["roles"]).filter((role): role is string => typeof role === "string"),
      email: context === "edit" ? asString(data["email"]) : undefined,
      url: asString(data["url"]),
      description: truncateText(description ?? "", 300).value,
      registered: typeof data["registered_date"] === "string"
        ? (data["registered_date"] as string).slice(0, 10)
        : undefined,
      capabilities: capabilities === undefined ? undefined : Object.keys(capabilities).length,
    }),
    help: [
      "Run `wordpress-axi post list --author <id>` for this user's posts",
      "Run `wordpress-axi user get <id> --context edit` for email and registration date",
    ],
  };
  return renderResult(out, values["json"] === true);
}

async function userCreate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi user create";
  const { values } = parseFlags(args, commandPath, CREATE_FLAGS);
  const json = values["json"] === true;
  const username = requiredString(values, "username", commandPath);
  const email = requiredString(values, "email", commandPath);

  const payload: Record<string, unknown> = { username, email };
  const name = requireString(values, "name", commandPath);
  const firstName = requireString(values, "first-name", commandPath);
  const lastName = requireString(values, "last-name", commandPath);
  const role = requireString(values, "role", commandPath);
  const password = requireString(values, "password", commandPath);
  const url = requireString(values, "url", commandPath);
  if (name !== undefined) payload["name"] = name;
  if (firstName !== undefined) payload["first_name"] = firstName;
  if (lastName !== undefined) payload["last_name"] = lastName;
  if (role !== undefined) payload["roles"] = [role];
  if (password !== undefined) payload["password"] = password;
  if (url !== undefined) payload["url"] = url;
  const body = parseJsonFlag(values, "body");
  const merged = body ? { ...payload, ...body } : payload;

  const generated = password === undefined && body?.["password"] === undefined;
  requireConfirm(
    values,
    commandPath,
    `create user "${username}" with role ${role ?? "subscriber"} (grants site access)`,
  );

  const { data } = await ctx.client.request<Record<string, unknown>>("POST", "wp/v2/users", {
    body: merged,
  });
  const generatedPassword = asString(data["password"]);
  const help = [
    `Run \`wordpress-axi user get ${asInt(data["id"]) ?? "<id>"} --context edit\` to verify`,
    ...(generatedPassword !== undefined
      ? [
          "WordPress generated the password below - store it now, it is only shown once:",
          generatedPassword,
        ]
      : []),
  ];
  const out: Record<string, unknown> = {
    created: userSummary(data),
    help,
  };
  return renderResult(out, json);
}

async function userUpdate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi user update";
  const { values, positionals } = parseFlags(args, commandPath, UPDATE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;

  const payload: Record<string, unknown> = {};
  const email = requireString(values, "email", commandPath);
  const name = requireString(values, "name", commandPath);
  const firstName = requireString(values, "first-name", commandPath);
  const lastName = requireString(values, "last-name", commandPath);
  const role = requireString(values, "role", commandPath);
  const password = requireString(values, "password", commandPath);
  const url = requireString(values, "url", commandPath);
  if (email !== undefined) payload["email"] = email;
  if (name !== undefined) payload["name"] = name;
  if (firstName !== undefined) payload["first_name"] = firstName;
  if (lastName !== undefined) payload["last_name"] = lastName;
  if (role !== undefined) payload["roles"] = [role];
  if (password !== undefined) payload["password"] = password;
  if (url !== undefined) payload["url"] = url;
  const body = parseJsonFlag(values, "body");
  const merged = body ? { ...payload, ...body } : payload;
  if (Object.keys(merged).length === 0) {
    throw new AxiError("user update needs at least one field to change", "VALIDATION_ERROR", [
      `Example: wordpress-axi user update ${id} --role editor`,
    ]);
  }

  const roleChange = merged["roles"] !== undefined;
  if (roleChange) {
    requireConfirm(
      values,
      commandPath,
      `change role of user ${id} to ${JSON.stringify(merged["roles"])} (changes permissions)`,
    );
  }

  const { data } = await ctx.client.request<Record<string, unknown>>(
    "POST",
    `wp/v2/users/${id}`,
    { body: merged },
  );
  return renderResult(
    {
      updated: userSummary(data),
      help: [`Run \`wordpress-axi user get ${id} --context edit\` to verify`],
    },
    json,
  );
}

async function userDelete(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi user delete";
  const { values, positionals } = parseFlags(args, commandPath, DELETE_FLAGS);
  const id = requireId(positionals, commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  const json = values["json"] === true;
  const reassign = optionalInt(values, "reassign", { min: 0, max: 100_000_000 });

  requireConfirm(
    values,
    commandPath,
    `delete user ${id}${reassign !== undefined ? `, reassigning their content to user ${reassign}` : ""}`,
  );

  await ctx.client.request("DELETE", `wp/v2/users/${id}`, {
    query: { force: true, reassign },
  });
  return renderResult(
    {
      deleted: { id, reassign },
      help: [
        "Content owned by the deleted user was reassigned" +
          (reassign !== undefined ? ` to user ${reassign}` : ""),
        "Run `wordpress-axi user list` to confirm",
      ],
    },
    json,
  );
}

function userSummary(data: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: asInt(data["id"]),
    name: asString(data["name"]),
    slug: asString(data["slug"]),
    roles: asArray(data["roles"]).filter((role): role is string => typeof role === "string"),
  });
}

function requireId(positionals: string[], commandPath: string): string {
  const id = requirePositional(positionals, 0, "id", commandPath);
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`${commandPath}: <id> must be a numeric WordPress ID, got: ${id}`, "VALIDATION_ERROR");
  }
  return id;
}

function requiredString(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
  commandPath: string,
): string {
  const value = requireString(values, name, commandPath);
  if (value === undefined) {
    throw new AxiError(`--${name} is required`, "VALIDATION_ERROR", [
      `Run \`${commandPath} --help\` for usage`,
    ]);
  }
  return value;
}

