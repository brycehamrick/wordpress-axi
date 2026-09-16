# WordPress AXI

An [AXI](https://axi.md/) skill for managing WordPress through the core REST API.

## Install

```bash
npx -y skills@latest add brycehamrick/wordpress-axi --skill wordpress-axi -g
```

## Configure

Create a dedicated WordPress user with only the capabilities the integration needs, then generate an Application Password from that user's profile. Export these values in the agent's runtime environment:

```bash
export WORDPRESS_URL="https://example.com"
export WORDPRESS_USERNAME="api-user"
export WORDPRESS_APPLICATION_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
```

Do not commit `.env` files or credentials. Application Passwords should be sent only over HTTPS and can be revoked independently in WordPress.

## Capabilities

- Discover core, plugin, and custom REST API routes.
- Read and search posts, pages, media, terms, comments, and users.
- Create, update, publish, trash, or delete resources subject to WordPress capabilities.
- Upload media and set its accessible metadata.
- Use a generic request command for custom REST API routes.

The skill defaults to safety checks around destructive and publishing operations. See [`SKILL.md`](SKILL.md) for agent instructions.

## Contributing

Contributions should remain generic and reusable: never add site URLs, project identifiers, usernames, access tokens, Application Passwords, or customer content. Keep the skill dependency-free where practical, add tests for behavior changes, and run the validation commands documented below before opening a focused pull request.

```bash
python3 -m unittest discover -s tests -v
python3 /opt/codex/skills/.system/skill-creator/scripts/quick_validate.py .
```
