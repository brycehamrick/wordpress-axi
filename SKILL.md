---
name: wordpress-axi
description: Manage WordPress sites through the WordPress REST API, including discovering routes, reading and searching content, and creating, updating, or deleting posts, pages, media, taxonomy terms, comments, and users. Use when an agent needs to inspect or change a WordPress site configured with WORDPRESS_URL, WORDPRESS_USERNAME, and WORDPRESS_APPLICATION_PASSWORD.
---

# WordPress AXI

Use `scripts/wordpress_api.py` rather than assembling authentication headers or URLs by hand.

## Configure

Require these environment variables:

```bash
export WORDPRESS_URL="https://example.com"
export WORDPRESS_USERNAME="api-user"
export WORDPRESS_APPLICATION_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
```

Use a dedicated WordPress user with the minimum role needed. Create an Application Password in that user's WordPress profile. Never request, print, commit, or place credentials in command arguments. Require HTTPS except for loopback development URLs.

Read `references/rest-api.md` before selecting endpoints or query parameters. Use API discovery when plugins or custom post types may add routes.

## Work safely

1. Confirm the site URL and the requested scope. Never infer a production target.
2. Run `python3 scripts/wordpress_api.py check` to verify authentication without exposing credentials.
3. Inspect the target resource with `get` or `list` before changing it.
4. Prefer `status=draft` for new content unless publication was explicitly requested.
5. Show the proposed payload and obtain confirmation before bulk edits, deletion, publication, role changes, or changes to many records.
6. Send only fields required for the operation. WordPress permissions remain the final authorization boundary.
7. Verify changed resources with a follow-up `get`.
8. Report IDs, URLs, and status, but redact credentials and authentication headers.

## Run requests

All output is formatted JSON. An endpoint may be a route such as `posts/42` or a full discovered `/wp-json/...` route.

```bash
# Discover the API or inspect the current user
python3 scripts/wordpress_api.py discover
python3 scripts/wordpress_api.py check

# Read content
python3 scripts/wordpress_api.py list posts --param status=publish --param per_page=20
python3 scripts/wordpress_api.py get pages/42 --param context=edit

# Write content from JSON (use a file or stdin so secrets never enter shell history)
printf '%s' '{"title":"Draft title","content":"Body","status":"draft"}' \
  | python3 scripts/wordpress_api.py create posts --data @-
python3 scripts/wordpress_api.py update posts/42 --data @payload.json
python3 scripts/wordpress_api.py delete posts/42 --param force=false

# Upload media
python3 scripts/wordpress_api.py upload ./image.jpg --title "Accessible title" --alt-text "Descriptive alternative text"
```

Use `request` for uncommon or plugin-provided routes:

```bash
python3 scripts/wordpress_api.py request GET wp/v2/types
python3 scripts/wordpress_api.py request POST wp/v2/custom-resource --data @payload.json
```

When a request fails, use the returned WordPress error `code`, `message`, and `data.status` to diagnose it. Do not retry authorization failures with altered credentials or retry non-idempotent writes automatically.
