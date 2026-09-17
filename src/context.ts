import { resolveConfig, type WordPressConfig } from "./lib/config.js";
import { WordPressClient } from "./wordpress.js";

/**
 * Shared command context. Commands receive it lazily so `--help` and version
 * probing never construct a client or require env vars. Tests construct
 * their own with an injected fetch implementation.
 */

export interface CommandContext {
  config: WordPressConfig;
  client: WordPressClient;
}

export function createCommandContext(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchImpl?: typeof fetch } = {},
): CommandContext {
  const config = resolveConfig(env);
  const client = new WordPressClient({ config, fetchImpl: deps.fetchImpl });
  return { config, client };
}

let cached: CommandContext | undefined;

export function getCommandContext(): CommandContext {
  cached ??= createCommandContext();
  return cached;
}
