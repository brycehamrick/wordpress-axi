# WordPress AXI

An [AXI](https://axi.md/)-compliant CLI for managing WordPress through the core REST API.
Token-efficient TOON output, pre-computed totals, truncation with `--full`,
structured errors, and `--confirm` gates on every publication, deletion,
role change, and site-wide switch.

```bash
npx -y wordpress-axi
```

## Install

```bash
npm install -g wordpress-axi
# or run on demand
npx -y wordpress-axi@latest --help
```

## Configure

Create a dedicated WordPress user with only the capabilities the integration
needs, then generate an Application Password from that user's profile
(Users > Profile). Export these values in the agent's runtime environment:

```bash
export WORDPRESS_URL="https://example.com"
export WORDPRESS_USERNAME="api-user"
export WORDPRESS_APPLICATION_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
```

Do not commit `.env` files or credentials. Application Passwords should be
sent only over HTTPS (enforced - loopback HTTP is allowed for local
development) and can be revoked independently in WordPress.

## Commands

| Command | What it does |
| --- | --- |
| (no args) | Home view: site health, content counts, command cheatsheet |
| `post list\|get\|create\|update\|publish\|delete\|revisions` | Posts (drafts by default; publish/delete need `--confirm`) |
| `page ...` | Pages, with `--parent` hierarchy support |
| `category ...`, `tag ...` | Terms; creates are idempotent on duplicates |
| `media list\|get\|upload\|update\|delete` | Media library with alt-text management |
| `comment list\|get\|create\|reply\|approve\|unapprove\|spam\|trash\|delete` | Comment moderation (all moderation needs `--confirm`) |
| `user me\|list\|get\|create\|update\|delete` | Users; role changes and creation need `--confirm` |
| `search <query>` | Cross-type search over exposed content |
| `settings get\|set` | Site settings (title, timezone, formats) |
| `plugin list\|get\|activate\|deactivate\|delete` | Plugin management |
| `theme list\|get\|activate` | Theme inspection and switching |
| `discover` | Map the site's namespaces, post types, taxonomies, statuses |
| `request <METHOD> <route>` | Escape hatch for plugin namespaces and custom routes |
| `setup hooks\|status\|remove` | Ambient session-start context |

Each command supports `--help`. Every list reports `count` plus the
server-reported `total`; large text is truncated with a size hint and a
`--full` escape hatch; `--json` gives machine-readable output.

## Safety model

- New content is created as `status=draft`; publication, deletion,
  moderation, user creation, role changes, and plugin/theme activation all
  require an explicit `--confirm` on the same invocation.
- Deletes go to trash by default; `--force` (and all media/term deletes) are
  permanent and say so before running.
- The `request` escape hatch is not double-gated - the API user's own
  WordPress capabilities remain the authorization boundary.
- HTTPS is enforced for all non-loopback sites; credentials are read only
  from the environment and are redacted from all error output.

## The AXI design principles

This CLI follows the [10 AXI principles](https://axi.md/): TOON output
(~40% token savings over JSON), minimal default schemas with a `--fields`
override, content truncation with size hints, pre-computed aggregates
(`count`/`total` on every list), definitive empty states, structured errors
on stdout with clean exit codes, an ambient-context installer, a live
no-argument home view, contextual `help[]` next steps, and consistent
per-command `--help`.

## Contributing

Contributions should remain generic and reusable: never add site URLs,
project identifiers, usernames, access tokens, Application Passwords, or
customer content. Add tests for behavior changes and run the gates before
opening a focused pull request:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT
