import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { parseFlags, requirePositional, type FlagDefinition } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { normalizeRoute } from "../lib/routes.js";
import type { CommandContext } from "../context.js";

/**
 * Escape hatch for routes without a dedicated command: plugin namespaces
 * (woocommerce/v1, acf/v3), custom post types, blocks, application
 * passwords, and anything else the site exposes. The route goes through the
 * same shorthand expansion as the built-in commands.
 *
 * This is the power-user door: mutations here are not double-gated. The
 * API user's own capabilities remain the authorization boundary.
 */

export const REQUEST_HELP = `wordpress-axi request - raw REST escape hatch for any route

usage:
  request <METHOD> <route> [--param key=value ...] [--body <json|@file|@->]

methods: GET, POST, PUT, PATCH, DELETE

Bare resource names expand to wp/v2 (posts -> wp/v2/posts). Other namespaces
pass through unchanged (woocommerce/v1/products). Absolute URLs are rejected;
this command only talks to the configured site.

flags:
  --param <k=v>    query parameter, repeatable
  --body <json>    request body as inline JSON, @path/to/file, or @- for stdin
  --json           pretty-print the raw response instead of TOON

examples:
  wordpress-axi request GET wp/v2/types
  wordpress-axi request GET posts/42 --param context=edit --json
  wordpress-axi request POST wp/v2/custom-resource --body @payload.json
  printf '%s' '{"title":"From stdin"}' | wordpress-axi request POST posts --body @-
  wordpress-axi request GET woocommerce/v1/products --param per_page=5`;

const REQUEST_FLAGS: Record<string, FlagDefinition> = {
  param: { type: "string", multiple: true },
  body: { type: "string" },
  json: { type: "boolean" },
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

export async function requestCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "wordpress-axi request";
  const method = parseMethod(args[0]);
  const rest = args.slice(1);

  const { values, positionals } = parseFlags(rest, commandPath, REQUEST_FLAGS);
  const route = requirePositional(positionals, 0, "route", commandPath);
  const extra = positionals.slice(1);
  if (extra.length > 0) {
    throw new AxiError(`${commandPath}: unexpected arguments: ${extra.join(" ")}`, "VALIDATION_ERROR", [
      "Quote routes with slashes, e.g. request GET wp/v2/types",
    ]);
  }
  const params = values["param"];
  const bodySpec = values["body"];
  const body = bodySpec === undefined ? undefined : parseBody(bodySpec, method);

  const query: Record<string, string> = {};
  for (const pair of splitParams(params)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new AxiError(`--param must use key=value, got: ${pair}`, "VALIDATION_ERROR");
    }
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const result = await ctx.client.request<unknown>(method, route, { query, body });
  const meta = result.meta;
  const normalized = normalizeRoute(route);

  if (result.data === undefined || result.data === null) {
    return renderResult(
      {
        request: `${method} /${normalized}`,
        status: meta.status,
        result: `${meta.status} \u2014 no response body`,
      },
      values["json"] === true,
    );
  }

  const out: Record<string, unknown> = {
    request: `${method} /${normalized}`,
    status: meta.status,
    ...(meta.total !== undefined ? { total: meta.total } : {}),
    ...(meta.totalPages !== undefined ? { total_pages: meta.totalPages } : {}),
    data: result.data,
  };
  return renderResult(out, values["json"] === true);
}

function parseMethod(raw: string | undefined): Method {
  if (raw === undefined) {
    throw new AxiError("request requires <METHOD> and <route>", "VALIDATION_ERROR", [
      "Example: wordpress-axi request GET wp/v2/types",
      "Methods: GET, POST, PUT, PATCH, DELETE",
    ]);
  }
  const upper = raw.toUpperCase();
  if (!(METHODS as readonly string[]).includes(upper)) {
    throw new AxiError(`request METHOD must be one of: ${METHODS.join(", ")} (got: ${raw})`, "VALIDATION_ERROR");
  }
  return upper as Method;
}

/** --param values may legitimately contain "=" in the value; split once. */
function splitParams(value: string | boolean | string[] | undefined): string[] {
  if (value === undefined || typeof value === "boolean") return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseBody(spec: string | boolean | string[] | undefined, method: Method): unknown {
  if (typeof spec !== "string" || spec.trim().length === 0) {
    throw new AxiError("--body requires a JSON string, @path/to/file, or @- for stdin", "VALIDATION_ERROR");
  }
  let raw: string;
  if (spec === "@-") {
    raw = readFileSync(0, "utf8");
  } else if (spec.startsWith("@")) {
    try {
      raw = readFileSync(spec.slice(1), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AxiError(`cannot read --body file: ${message}`, "VALIDATION_ERROR");
    }
  } else {
    raw = spec;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AxiError(
      `--body must be valid JSON, got: ${raw.slice(0, 120)}`,
      "VALIDATION_ERROR",
      ["Pass @path/to/file.json or @- (stdin) to keep secrets out of shell history"],
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (method === "GET" || method === "DELETE") return parsed;
    throw new AxiError("--body must be a JSON object for this method", "VALIDATION_ERROR");
  }
  return parsed;
}
