import importlib.util
import os
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "wordpress_api.py"
SPEC = importlib.util.spec_from_file_location("wordpress_api", MODULE_PATH)
wp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(wp)


class ConfigurationTests(unittest.TestCase):
    def test_requires_url(self):
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(wp.ConfigError, "WORDPRESS_URL"):
            wp.configuration()

    def test_rejects_remote_plain_http(self):
        values = {"WORDPRESS_URL": "http://example.com", "WORDPRESS_USERNAME": "user",
                  "WORDPRESS_APPLICATION_PASSWORD": "secret"}
        with mock.patch.dict(os.environ, values, clear=True), self.assertRaisesRegex(wp.ConfigError, "HTTPS"):
            wp.configuration()

    def test_allows_loopback_http(self):
        values = {"WORDPRESS_URL": "http://127.0.0.1:8080", "WORDPRESS_USERNAME": "user",
                  "WORDPRESS_APPLICATION_PASSWORD": "secret"}
        with mock.patch.dict(os.environ, values, clear=True):
            self.assertEqual(wp.configuration(), ("http://127.0.0.1:8080", "user", "secret"))


class EndpointTests(unittest.TestCase):
    def test_expands_common_resource_and_encodes_parameters(self):
        url = wp.endpoint_url("https://example.com", "posts", ["search=hello world", "status=draft"])
        self.assertEqual(url, "https://example.com/wp-json/wp/v2/posts?search=hello+world&status=draft")

    def test_preserves_custom_namespace(self):
        self.assertEqual(wp.endpoint_url("https://example.com", "/plugin/v1/items", []),
                         "https://example.com/wp-json/plugin/v1/items")

    def test_rejects_absolute_endpoint(self):
        with self.assertRaisesRegex(wp.ConfigError, "relative"):
            wp.endpoint_url("https://example.com", "https://attacker.example/api", [])


class JsonTests(unittest.TestCase):
    def test_loads_and_compacts_inline_json(self):
        self.assertEqual(wp.load_json('{"title": "Draft"}'), b'{"title":"Draft"}')


class UploadTests(unittest.TestCase):
    def test_upload_sends_filename_header(self):
        with self.subTest("header value is RFC 5987 encoded"):
            filename = "hero image.jpg"
            disposition = "attachment; filename*=UTF-8''" + wp.urllib.parse.quote(filename)
            self.assertEqual(disposition, "attachment; filename*=UTF-8''hero%20image.jpg")


if __name__ == "__main__":
    unittest.main()
