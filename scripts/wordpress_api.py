#!/usr/bin/env python3
"""Small, dependency-free WordPress REST API client for agent workflows."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

COMMON_RESOURCES = {
    "categories", "comments", "media", "pages", "posts", "search", "statuses",
    "tags", "taxonomies", "types", "users",
}


class ConfigError(ValueError):
    """Raised when required, safe configuration is unavailable."""


def configuration(require_auth: bool = True) -> tuple[str, str | None, str | None]:
    url = os.environ.get("WORDPRESS_URL", "").strip().rstrip("/")
    if not url:
        raise ConfigError("WORDPRESS_URL is required")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigError("WORDPRESS_URL must be an absolute http(s) URL")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ConfigError("WORDPRESS_URL must use HTTPS (HTTP is allowed only for loopback development)")

    username = os.environ.get("WORDPRESS_USERNAME")
    password = os.environ.get("WORDPRESS_APPLICATION_PASSWORD")
    if require_auth and (not username or not password):
        raise ConfigError("WORDPRESS_USERNAME and WORDPRESS_APPLICATION_PASSWORD are required")
    return url, username, password


def endpoint_url(base: str, endpoint: str, params: list[str]) -> str:
    endpoint = endpoint.strip()
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        raise ConfigError("endpoint must be a relative WordPress REST API route")
    endpoint = endpoint.lstrip("/")
    if endpoint.startswith("wp-json/"):
        endpoint = endpoint[len("wp-json/"):]
    first = endpoint.split("/", 1)[0]
    if first in COMMON_RESOURCES:
        endpoint = f"wp/v2/{endpoint}"
    url = f"{base}/wp-json/" + endpoint
    pairs: list[tuple[str, str]] = []
    for value in params:
        if "=" not in value:
            raise ConfigError(f"query parameter must use key=value: {value!r}")
        pairs.append(tuple(value.split("=", 1)))
    if pairs:
        url += "?" + urllib.parse.urlencode(pairs)
    return url


def load_json(spec: str | None) -> bytes | None:
    if spec is None:
        return None
    if spec == "@-":
        raw = sys.stdin.read()
    elif spec.startswith("@"):
        raw = pathlib.Path(spec[1:]).read_text(encoding="utf-8")
    else:
        raw = spec
    value = json.loads(raw)
    return json.dumps(value, separators=(",", ":")).encode()


def perform(method: str, endpoint: str, params: list[str], data: bytes | None = None,
            content_type: str = "application/json",
            extra_headers: dict[str, str] | None = None) -> tuple[Any, dict[str, Any]]:
    base, username, password = configuration(require_auth=True)
    url = endpoint_url(base, endpoint, params)
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    headers = {"Accept": "application/json", "Authorization": f"Basic {token}",
               "User-Agent": "wordpress-axi/1.0"}
    if data is not None:
        headers["Content-Type"] = content_type
    if extra_headers:
        headers.update(extra_headers)
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            result = json.loads(raw) if raw else None
            meta = {"status": response.status}
            for source, target in (("X-WP-Total", "total"), ("X-WP-TotalPages", "total_pages")):
                if response.headers.get(source):
                    meta[target] = int(response.headers[source])
            return result, meta
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            details = json.loads(raw)
        except json.JSONDecodeError:
            details = {"code": "http_error", "message": raw or error.reason}
        print(json.dumps({"error": details, "status": error.code}, indent=2), file=sys.stderr)
        raise SystemExit(1) from None
    except urllib.error.URLError as error:
        print(json.dumps({"error": {"code": "connection_error", "message": str(error.reason)}}), file=sys.stderr)
        raise SystemExit(1) from None


def output(result: Any, meta: dict[str, Any]) -> None:
    if isinstance(result, list):
        result = {"items": result, "_meta": meta}
    elif isinstance(result, dict) and any(key != "status" for key in meta):
        result = {**result, "_meta": meta}
    print(json.dumps(result, indent=2, ensure_ascii=False))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("discover", help="retrieve the REST API index")
    sub.add_parser("check", help="retrieve the authenticated user")
    for command, method in (("get", "GET"), ("list", "GET"), ("delete", "DELETE")):
        item = sub.add_parser(command)
        item.set_defaults(method=method)
        item.add_argument("endpoint")
        item.add_argument("--param", action="append", default=[])
    for command in ("create", "update"):
        item = sub.add_parser(command)
        item.add_argument("endpoint")
        item.add_argument("--data", required=True, help="JSON, @file, or @- for stdin")
        item.add_argument("--param", action="append", default=[])
    request = sub.add_parser("request")
    request.add_argument("method", choices=("GET", "POST", "PUT", "PATCH", "DELETE"))
    request.add_argument("endpoint")
    request.add_argument("--data", help="JSON, @file, or @- for stdin")
    request.add_argument("--param", action="append", default=[])
    upload = sub.add_parser("upload")
    upload.add_argument("file")
    upload.add_argument("--title")
    upload.add_argument("--alt-text")
    upload.add_argument("--caption")
    upload.add_argument("--description")
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "discover":
            result, meta = perform("GET", "", [])
        elif args.command == "check":
            result, meta = perform("GET", "users/me", ["context=edit"])
        elif args.command == "upload":
            path = pathlib.Path(args.file)
            data = path.read_bytes()
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            disposition = "attachment; filename*=UTF-8''" + urllib.parse.quote(path.name)
            result, meta = perform("POST", "media", [], data, content_type,
                                   {"Content-Disposition": disposition})
            metadata = {key: value for key, value in {
                "title": args.title, "alt_text": args.alt_text, "caption": args.caption,
                "description": args.description,
            }.items() if value is not None}
            if metadata:
                result, meta = perform("POST", f"media/{result['id']}", [],
                                       json.dumps(metadata).encode())
        else:
            method = getattr(args, "method", "POST")
            result, meta = perform(method, args.endpoint, args.param, load_json(getattr(args, "data", None)))
        output(result, meta)
    except (ConfigError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": {"code": "client_error", "message": str(error)}}), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
