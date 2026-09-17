# WordPress REST API reference

Notes for maintaining wordpress-axi against the core REST API. Authoritative
source: <https://developer.wordpress.org/rest-api/reference/>.

## Base and discovery

- Site API index: `GET {WORDPRESS_URL}/wp-json/`
- Core v2 namespace: `{WORDPRESS_URL}/wp-json/wp/v2/`
- Some sites relocate or block the API; discovery is authoritative
  (`wordpress-axi discover`).
- Custom post types and taxonomies appear only when registered with
  `show_in_rest`; plugin namespaces (e.g. `woocommerce/v1`, `acf/v3`) appear
  in the index `namespaces` list.

## Authentication

Use WordPress Application Passwords for remote REST API access. Send the
username and Application Password through HTTP Basic authentication over
TLS. Application Passwords are individually revocable credentials intended
for API access; they are not the user's interactive password.

The CLI reads only:

- `WORDPRESS_URL`: site origin, without `/wp-json`. HTTPS enforced; HTTP
  allowed only for loopback hosts.
- `WORDPRESS_USERNAME`: login name of the dedicated integration user.
- `WORDPRESS_APPLICATION_PASSWORD`: Application Password from that user's
  profile. Spaces in WordPress's displayed grouping are accepted.

Never use cookie-and-nonce authentication outside code already running
inside WordPress. Never disable TLS verification.

## Core endpoint coverage

| Resource | Route | CLI command | Notes |
| --- | --- | --- | --- |
| Posts | `wp/v2/posts` | `post list\|get\|create\|update\|publish\|delete\|revisions` | revisions need `context=edit` permission |
| Pages | `wp/v2/pages` | `page ...` | adds `--parent` hierarchy filter |
| Media | `wp/v2/media` | `media list\|get\|upload\|update\|delete` | uploads POST raw binary + RFC 5987 filename; deletes are permanent (no trash) |
| Categories | `wp/v2/categories` | `category list\|get\|create\|update\|delete` | `term_exists` errors resolved idempotently |
| Tags | `wp/v2/tags` | `tag ...` | same idempotent create |
| Comments | `wp/v2/comments` | `comment list\|get\|create\|reply\|approve\|unapprove\|spam\|trash\|delete` | moderation verbs map to `status` updates |
| Users | `wp/v2/users`, `users/me` | `me`, `user list\|get\|create\|update\|delete` | delete requires `reassign` when the user owns content |
| Search | `wp/v2/search` | `search <query>` | covers post types exposed via `show_in_rest` |
| Settings | `wp/v2/settings` | `settings get\|set` | requires `manage_options` |
| Plugins | `wp/v2/plugins` | `plugin list\|get\|activate\|deactivate\|delete` | ids like `akismet/akismet` are percent-encoded in routes; install/upload is not in core REST |
| Themes | `wp/v2/themes` | `theme list\|get\|activate` | activation = POST `status=active` |
| Types/statuses/taxonomies | `wp/v2/types`, `wp/v2/statuses`, `wp/v2/taxonomies` | `discover` | capability and shape discovery |

## Routes reachable through the `request` escape hatch

These core routes have no dedicated command; use
`wordpress-axi request GET|POST ...`:

- Post/page autosaves: `wp/v2/<type>/<id>/autosaves`
- Block types: `wp/v2/block-types`, blocks: `wp/v2/blocks`,
  block renderer: `wp/v2/block-renderer`,
  block directory search: `wp/v2/block-directory/search`
- Application Passwords: `wp/v2/users/<id>/application-passwords`
- Widget/registered-widget routes when exposed by the host version
- Everything under plugin namespaces (`woocommerce/v1/...`, `acf/v3/...`,
  custom namespaces)

## Request conventions

- Use `context=edit` when raw editable fields are required and credentials
  permit it (`post get <id>` then `request GET wp/v2/posts/<id> --param
  context=edit --json` for raw HTML).
- Pagination uses `page` and `per_page` (capped at 100). Response headers
  include `X-WP-Total` and `X-WP-TotalPages`; the client surfaces both as
  `total`/`totalPages` meta, which list commands print as `total`.
- Filtering varies by resource. Common parameters: `search`, `slug`,
  `status`, `include`, `exclude`, `orderby`, `order`, `after`, `before`.
- Creation uses `POST` to a collection; updates use `POST` to an item route.
  Deletion uses `DELETE`; `force=false` uses trash when the resource
  supports trashing (attachments and terms do not).
- Content fields are `{ rendered }` objects in responses but accept plain
  strings in write payloads.
- Treat `publish`, `future`, and `private` status transitions as publication
  actions requiring `--confirm`.

## Error handling

WordPress errors contain `code`, `message`, and `data.status`. The client
maps them to typed AXI errors:

- 401 `AUTH_REQUIRED`: missing or invalid credentials - check the env vars,
  run `wordpress-axi me`.
- 403 `FORBIDDEN`: the authenticated user lacks the capability - use a user
  with the minimum role that allows the action.
- 404 `NOT_FOUND`: absent route, unavailable object, or permalink/web-server
  routing misconfigured.
- 400: invalid parameters. `term_exists` is special-cased to return the
  existing term (idempotent create).

Consult the live API index (`wordpress-axi discover`) and the official
reference when route behavior differs by WordPress or plugin version.
