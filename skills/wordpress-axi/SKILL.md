---
name: wordpress-axi
description: Use wordpress-axi for WordPress site management - posts, pages, media, categories, tags, comments, users, search, settings, plugins, and themes over the core REST API - instead of assembling REST calls or using wp-admin. Use when a task touches a WordPress site configured with WORDPRESS_URL, WORDPRESS_USERNAME, and WORDPRESS_APPLICATION_PASSWORD.
---

# wordpress-axi

Agent-ergonomic CLI over the WordPress core REST API. TOON output,
pre-computed counts, truncation with `--full`, structured errors, `--confirm`
gates on publication and deletion, and `help[]` next steps on every result.

## Configure

```bash
export WORDPRESS_URL="https://example.com"
export WORDPRESS_USERNAME="api-user"
export WORDPRESS_APPLICATION_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
```

Use a dedicated WordPress user with the minimum role needed. Create the
Application Password in that user's profile (Users > Profile). Never print,
commit, or place credentials in command arguments. HTTPS is enforced except
for loopback development URLs.

## Work safely

1. Confirm the site URL and requested scope. Never infer a production target.
2. Run `wordpress-axi me` first to verify authentication without exposing
   credentials; run `wordpress-axi discover` to see what the site exposes.
3. Inspect the target with `get` or `list` before changing it.
4. New content defaults to `status=draft`. Making content public
   (`publish`/`future`/`private`), deleting, moderating, changing roles, and
   plugin/theme changes all require `--confirm`.
5. Show the proposed payload and obtain user confirmation before bulk edits
   or changes to many records.
6. Send only the fields needed. WordPress capabilities remain the final
   authorization boundary.
7. Verify changes with a follow-up `get`.

## Command map

- Read content: `post list|get`, `page list|get`, `search "<query>"`
- Write content: `post create --title "..." --content "..."` (draft default),
  `post update <id>`, `post publish <id> --confirm`, `post delete <id> --confirm`
- Taxonomies: `category list|get|create|update|delete`, `tag ...`
  (creates are idempotent - an existing term returns its ID)
- Media: `media list|get|upload <file> --alt "..."|update|delete` (deletes
  are permanent; attachments have no trash)
- Comments: `comment list --status hold`, `comment approve <id> --confirm`,
  `comment reply <id> --content "..."`
- Users: `me`, `user list`, `user create ... --confirm` (role changes need
  `--confirm`; prefer the minimum role)
- Site: `settings get|set`, `plugin list|activate|deactivate|delete`,
  `theme list|activate` (all site-wide writes need `--confirm`)
- Discovery: `discover` maps namespaces, post types, taxonomies, statuses
- Escape hatch: `request GET|POST|PUT|PATCH|DELETE <route> --param k=v
  --body @file.json` for plugin namespaces (woocommerce/v1, acf/v3), custom
  post types, and anything without a dedicated command

## Invocation

Installed globally: `wordpress-axi <command>`. Otherwise run on demand:
`npx -y wordpress-axi@latest <command>`. Both are identical.

## Conventions

- Default output is compact TOON; pass `--json` for machine-readable JSON.
- Lists report `count` and server-reported `total`; large text is truncated
  with a size hint - pass `--full` for complete text.
- Empty results print explicit `0 ...` markers, never blank output.
- Exit codes: 0 success, 2 usage/validation/missing `--confirm`, 1 runtime
  or API failure. Errors carry `error`/`code`/`help[]`.
- WordPress error codes matter: 401 = bad credentials, 403 = the user lacks
  the capability, 404 = wrong ID or the route is hidden. Diagnose with those,
  then `me`/`discover`. Do not retry authorization failures with altered
  credentials, and never retry non-idempotent writes automatically.
