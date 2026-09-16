# WordPress REST API reference

## Base and discovery

- Site API index: `GET {WORDPRESS_URL}/wp-json/`
- Core v2 namespace: `{WORDPRESS_URL}/wp-json/wp/v2/`
- Some sites relocate or block the API; discovery is authoritative.
- Custom post types and taxonomies appear only when registered with `show_in_rest`.

## Authentication

Use WordPress Application Passwords for remote REST API access. Send the WordPress username and Application Password through HTTP Basic authentication over TLS. Application Passwords are individually revocable credentials intended for API access; they are not the user's interactive password.

The helper reads only:

- `WORDPRESS_URL`: WordPress site origin or installation URL, without `/wp-json`.
- `WORDPRESS_USERNAME`: login name of the dedicated integration user.
- `WORDPRESS_APPLICATION_PASSWORD`: Application Password generated in that user's profile. Spaces in WordPress's displayed grouping are accepted.

Never use cookie-and-nonce authentication outside code already running inside WordPress. Never disable TLS verification.

## Common core endpoints

| Resource | Route | Typical operations |
| --- | --- | --- |
| Posts | `wp/v2/posts` | list, create, update, trash/delete |
| Pages | `wp/v2/pages` | list, create, update, trash/delete |
| Media | `wp/v2/media` | list, upload, edit metadata, delete |
| Categories | `wp/v2/categories` | list, create, update, delete |
| Tags | `wp/v2/tags` | list, create, update, delete |
| Comments | `wp/v2/comments` | list, create, moderate, delete |
| Users | `wp/v2/users` | list or manage when the user has permission |
| Search | `wp/v2/search` | search across exposed object types |
| Current user | `wp/v2/users/me` | authentication check |
| Types/statuses/taxonomies | `wp/v2/types`, `wp/v2/statuses`, `wp/v2/taxonomies` | capability discovery |

The helper prepends `wp/v2/` when a route begins with a common shorthand such as `posts` or `pages`. Pass `wp/v2/...` explicitly for all other routes.

## Request conventions

- Use `context=edit` when raw editable fields are required and credentials permit it.
- Pagination uses `page` and `per_page` (normally capped at 100). Response headers include `X-WP-Total` and `X-WP-TotalPages`; the helper includes these as `_meta`.
- Filtering varies by resource. Common parameters include `search`, `slug`, `status`, `include`, `exclude`, `orderby`, `order`, `after`, and `before`.
- Creation normally uses `POST` to a collection. Updates use `POST` to an item route. Deletion uses `DELETE`; `force=false` uses trash when supported.
- Content fields may be objects in responses (`rendered`, and with edit context, `raw`) but normally accept strings in write payloads.
- Treat `publish`, `future`, and `private` status transitions as publication actions requiring explicit intent.

## Error handling

WordPress errors generally contain `code`, `message`, and `data.status`. A 401 indicates missing or invalid authentication. A 403 generally means the authenticated user lacks the capability or an intermediary blocked the request. A 404 can mean the route is absent, the object is unavailable in the current context, or permalink/web-server routing is misconfigured.

Consult the live API index and the official WordPress REST API reference when route behavior differs by WordPress or plugin version.
