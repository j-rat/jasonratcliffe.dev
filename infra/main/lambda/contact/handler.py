"""Contact form handler: API Gateway HTTP API (payload v2) -> SES.

Security properties:
  * Only answers requests that carry CloudFront's secret origin header.
  * Rejects cross-site POSTs (Origin must be the site when present).
  * Honeypot field: bots that fill it get a fake success and no email is sent.
  * Strict length/format validation; CR/LF stripped from anything used in headers.
  * Logs outcomes only - never names, addresses or message bodies.
"""

import base64
import hmac
import json
import logging
import os
import re

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 10_000
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$")
LIMITS = {"name": (1, 100), "reply_to": (3, 254), "message": (10, 4000)}

_ses = None


def _client():
    global _ses
    if _ses is None:
        import boto3  # Imported lazily so unit tests can run without boto3.

        _ses = boto3.client("sesv2")
    return _ses


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(body),
    }


def _single_line(value):
    return re.sub(r"[\r\n\t]+", " ", value).strip()


def _parse(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", errors="strict")
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("too large")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("not an object")
    return data


def _validate(data):
    fields = {}
    for key, (lo, hi) in LIMITS.items():
        value = data.get(key)
        if not isinstance(value, str):
            raise ValueError(f"{key} missing")
        value = value.strip()
        if not lo <= len(value) <= hi:
            raise ValueError(f"{key} length")
        fields[key] = value
    fields["name"] = _single_line(fields["name"])
    fields["reply_to"] = _single_line(fields["reply_to"])
    if not EMAIL_RE.match(fields["reply_to"]):
        raise ValueError("reply_to format")
    return fields


def lambda_handler(event, context):
    request_id = getattr(context, "aws_request_id", "-")
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}

    secret = os.environ["ORIGIN_SECRET"]
    if not hmac.compare_digest(headers.get("x-origin-verify", ""), secret):
        logger.warning(json.dumps({"event": "rejected", "reason": "origin-secret", "request_id": request_id}))
        return _response(403, {"ok": False})

    origin = headers.get("origin")
    if origin is not None and origin != os.environ["SITE_ORIGIN"]:
        logger.warning(json.dumps({"event": "rejected", "reason": "cross-origin", "request_id": request_id}))
        return _response(403, {"ok": False})

    try:
        data = _parse(event)
    except (ValueError, UnicodeDecodeError):
        return _response(400, {"ok": False, "error": "invalid request"})

    if str(data.get("website") or "").strip():
        logger.info(json.dumps({"event": "honeypot", "request_id": request_id}))
        return _response(200, {"ok": True})

    try:
        fields = _validate(data)
    except ValueError as exc:
        logger.info(json.dumps({"event": "invalid", "reason": str(exc), "request_id": request_id}))
        return _response(400, {"ok": False, "error": "invalid fields"})

    subject = f"{os.environ.get('SUBJECT_PREFIX', '[contact]')} Message from {fields['name']}"
    text = (
        f"Name: {fields['name']}\n"
        f"Reply-To: {fields['reply_to']}\n"
        f"\n{fields['message']}\n\n"
        "-- \nSent from the contact form. Reply directly to respond.\n"
    )

    try:
        _client().send_email(
            FromEmailAddress=f"{os.environ.get('FROM_NAME', 'Contact form')} <{os.environ['FROM_ADDRESS']}>",
            Destination={"ToAddresses": [os.environ["TO_ADDRESS"]]},
            ReplyToAddresses=[fields["reply_to"]],
            Content={
                "Simple": {
                    "Subject": {"Data": subject[:200], "Charset": "UTF-8"},
                    "Body": {"Text": {"Data": text, "Charset": "UTF-8"}},
                }
            },
        )
    except Exception as exc:  # noqa: BLE001 - report any SES failure as a 502
        logger.error(json.dumps({"event": "send-failed", "error": type(exc).__name__, "request_id": request_id}))
        return _response(502, {"ok": False, "error": "send failed"})

    logger.info(json.dumps({"event": "sent", "request_id": request_id}))
    return _response(200, {"ok": True})
