import { runAxiCli, AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "./lib/output.js";
import { getCommandContext } from "./context.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { createContentCommand, contentHelp, POST_RESOURCE, PAGE_RESOURCE } from "./commands/content.js";
import { createTermCommand, termHelp, CATEGORY_RESOURCE, TAG_RESOURCE } from "./commands/term.js";
import { mediaCommand, MEDIA_HELP } from "./commands/media.js";
import { commentCommand, COMMENT_HELP } from "./commands/comment.js";
import { userCommand, meCommand, USER_HELP } from "./commands/user.js";
import { searchCommand, SEARCH_HELP } from "./commands/search.js";
import { settingsCommand, SETTINGS_HELP } from "./commands/settings.js";
import { pluginCommand, PLUGIN_HELP } from "./commands/plugin.js";
import { themeCommand, THEME_HELP } from "./commands/theme.js";
import { discoverCommand, DISCOVER_HELP } from "./commands/discover.js";
import { requestCommand, REQUEST_HELP } from "./commands/request.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "WordPress content and site management for agents - posts, pages, media, terms, comments, users, settings, plugins, and themes over the core REST API";

const TOP_LEVEL_HELP = `wordpress-axi - ${DESCRIPTION}

commands:
  post ...                create, read, update, publish, delete posts
  page ...                the same for pages
  category ...            manage categories
  tag ...                 manage tags
  media ...               list, upload, update, and delete attachments
  comment ...             read, reply, and moderate comments
  user ...                list, create, update, and delete users
  search <query>          cross-type search
  settings get|set        site settings (title, timezone, formats)
  plugin ...              inspect, activate, deactivate, delete plugins
  theme ...               inspect themes, switch the active one
  discover                map the site's REST API surface
  me                      verify authentication and show the API user
  request <METHOD> <r>    escape hatch for plugin/custom REST routes
  setup hooks|status      install ambient session context

global flags: --help, -v/--version, update (self-update)

auth: export WORDPRESS_URL, WORDPRESS_USERNAME, and
WORDPRESS_APPLICATION_PASSWORD. Use a dedicated user with the minimum role
needed and an Application Password from that user's profile.

publication, deletion, role changes, and plugin/theme changes require
--confirm. New content defaults to draft.

run \`wordpress-axi <command> --help\` for a command reference.`;

const COMMAND_HELP: Record<string, string> = {
  post: contentHelp(POST_RESOURCE),
  page: contentHelp(PAGE_RESOURCE),
  category: termHelp(CATEGORY_RESOURCE),
  tag: termHelp(TAG_RESOURCE),
  media: MEDIA_HELP,
  comment: COMMENT_HELP,
  user: USER_HELP,
  search: SEARCH_HELP,
  settings: SETTINGS_HELP,
  plugin: PLUGIN_HELP,
  theme: THEME_HELP,
  discover: DISCOVER_HELP,
  me: `wordpress-axi me - verify authentication and show the API user

usage:
  me [--json]

One cheap authenticated call to wp/v2/users/me. Use this first whenever a
command returns AUTH_REQUIRED or FORBIDDEN.`,
  request: REQUEST_HELP,
  setup: SETUP_HELP,
};

/** Lazily wrap a command so --help and version probes never build context. */
function withContext(
  command: (args: string[], ctx: ReturnType<typeof getCommandContext>) => Promise<AxiRenderable> | AxiRenderable,
): (args: string[]) => Promise<AxiRenderable> {
  return (args: string[]) => Promise.resolve(command(args, getContextOrAuthError()));
}

function getContextOrAuthError(): ReturnType<typeof getCommandContext> {
  try {
    return getCommandContext();
  } catch (error) {
    if (error instanceof AxiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AxiError(message, "AUTH_REQUIRED", [
      "export WORDPRESS_URL=https://example.com",
      "export WORDPRESS_USERNAME=dedicated-api-user",
      "export WORDPRESS_APPLICATION_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'",
      "Application Passwords are created under Users > Profile in wp-admin",
    ]);
  }
}

export async function main(): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (command: string) => COMMAND_HELP[command] ?? null,
    home: (args: string[]) => {
      // The home view is content-first even without credentials: degrade to
      // a structured not-configured dashboard instead of an AUTH_REQUIRED
      // error, so ambient session context and `wordpress-axi` with no args
      // always orient the agent.
      try {
        return Promise.resolve(homeCommand(args, getContextOrAuthError()));
      } catch (error) {
        if (error instanceof AxiError) {
          return Promise.resolve({
            auth: "not-configured",
            result: error.message,
            help: error.suggestions,
          });
        }
        return Promise.reject(error);
      }
    },
    commands: {
      post: withContext(createContentCommand(POST_RESOURCE)),
      page: withContext(createContentCommand(PAGE_RESOURCE)),
      category: withContext(createTermCommand(CATEGORY_RESOURCE)),
      tag: withContext(createTermCommand(TAG_RESOURCE)),
      media: withContext(mediaCommand),
      comment: withContext(commentCommand),
      user: withContext(userCommand),
      me: withContext(meCommand),
      search: withContext(searchCommand),
      settings: withContext(settingsCommand),
      plugin: withContext(pluginCommand),
      theme: withContext(themeCommand),
      discover: withContext(discoverCommand),
      request: withContext(requestCommand),
      setup: (args: string[]) => setupCommand(args),
    },
  });
}

// Direct execution (node dist/index.js) instead of the bin wrapper.
if (process.argv[1]?.endsWith("index.js")) {
  await main();
}
