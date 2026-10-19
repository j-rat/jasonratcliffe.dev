"""Unit tests for the contact handler. Run: python3 -m unittest -v (from this folder)."""

import base64
import json
import os
import unittest

os.environ.update(
    ORIGIN_SECRET="s3cret",
    SITE_ORIGIN="https://example.test",
    TO_ADDRESS="owner@example.test",
    FROM_ADDRESS="noreply@example.test",
)

import handler  # noqa: E402


class FakeSes:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def send_email(self, **kwargs):
        if self.fail:
            raise RuntimeError("boom")
        self.calls.append(kwargs)
        return {"MessageId": "1"}


def event(body, headers=None, b64=False):
    h = {"x-origin-verify": "s3cret", "origin": "https://example.test"}
    h.update(headers or {})
    raw = json.dumps(body) if not isinstance(body, str) else body
    if b64:
        raw = base64.b64encode(raw.encode()).decode()
    return {"headers": {k: v for k, v in h.items() if v is not None}, "body": raw, "isBase64Encoded": b64}


GOOD = {"name": "Ada Lovelace", "reply_to": "ada@example.org", "message": "Hello there, let's talk about cloud.", "website": ""}


class ContactTests(unittest.TestCase):
    def setUp(self):
        self.ses = FakeSes()
        handler._ses = self.ses

    def test_sends_valid_message(self):
        r = handler.lambda_handler(event(GOOD), None)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(len(self.ses.calls), 1)
        call = self.ses.calls[0]
        self.assertEqual(call["Destination"]["ToAddresses"], ["owner@example.test"])
        self.assertEqual(call["ReplyToAddresses"], ["ada@example.org"])
        self.assertIn("noreply@example.test", call["FromEmailAddress"])
        self.assertEqual(r["headers"]["Cache-Control"], "no-store")

    def test_base64_body(self):
        self.assertEqual(handler.lambda_handler(event(GOOD, b64=True), None)["statusCode"], 200)

    def test_missing_origin_secret_is_403(self):
        r = handler.lambda_handler(event(GOOD, {"x-origin-verify": None}), None)
        self.assertEqual(r["statusCode"], 403)
        self.assertEqual(self.ses.calls, [])

    def test_wrong_origin_secret_is_403(self):
        self.assertEqual(handler.lambda_handler(event(GOOD, {"x-origin-verify": "nope"}), None)["statusCode"], 403)

    def test_cross_site_origin_is_403(self):
        r = handler.lambda_handler(event(GOOD, {"origin": "https://evil.test"}), None)
        self.assertEqual(r["statusCode"], 403)
        self.assertEqual(self.ses.calls, [])

    def test_honeypot_fakes_success_without_sending(self):
        r = handler.lambda_handler(event({**GOOD, "website": "http://spam"}), None)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.ses.calls, [])

    def test_invalid_email_is_400(self):
        self.assertEqual(handler.lambda_handler(event({**GOOD, "reply_to": "not-an-email"}), None)["statusCode"], 400)

    def test_header_injection_is_rejected_or_flattened(self):
        r = handler.lambda_handler(event({**GOOD, "reply_to": "a@b.example\r\nBcc: x@y.example"}), None)
        self.assertEqual(r["statusCode"], 400)
        r = handler.lambda_handler(event({**GOOD, "name": "Eve\r\nBcc: x@y.example"}), None)
        self.assertEqual(r["statusCode"], 200)
        self.assertNotIn("\n", self.ses.calls[-1]["Content"]["Simple"]["Subject"]["Data"])

    def test_short_message_is_400(self):
        self.assertEqual(handler.lambda_handler(event({**GOOD, "message": "hi"}), None)["statusCode"], 400)

    def test_oversized_body_is_400(self):
        self.assertEqual(handler.lambda_handler(event({**GOOD, "message": "x" * 20000}), None)["statusCode"], 400)

    def test_garbage_json_is_400(self):
        self.assertEqual(handler.lambda_handler(event("{not json"), None)["statusCode"], 400)
        self.assertEqual(handler.lambda_handler(event("[1,2]"), None)["statusCode"], 400)

    def test_ses_failure_is_502(self):
        handler._ses = FakeSes(fail=True)
        self.assertEqual(handler.lambda_handler(event(GOOD), None)["statusCode"], 502)


if __name__ == "__main__":
    unittest.main()
