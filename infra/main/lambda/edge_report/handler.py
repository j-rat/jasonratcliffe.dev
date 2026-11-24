"""Daily edge threat summary for jasonratcliffe.dev/edge/.

Queries the CloudFront access logs (CloudWatch Logs Insights), sorts probe traffic into categories
mapped to MITRE ATT&CK (patterns.json) and publishes data/edge-threats.json to the site bucket.

Also counts the contact form's defenses over 30 days (honeypot catches, rejected origins, bad input from
the contact Lambda's outcome logs; throttling and wrong routes from the access logs).

Never published: viewer IPs (logged for 7 days for admin use, but never selected here), query strings,
any path that didn't match a probe pattern, and the number of real messages sent. Published paths have emails redacted, unsafe characters
percent-encoded and are truncated.
"""

import datetime as dt
import json
import os
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

SELF_UA = "resume-site-edge-report/1"
QUERY = (
    "fields `cs-uri-stem` as path, `cs-uri-query` as query, `sc-status` as status, "
    "`cs(User-Agent)` as ua, `c-country` as country "
    "| stats count(*) as n by path, query, status, ua, country"
)
# The contact Lambda logs JSON inside Lambda's JSON envelope, so the outcome is parsed out of `message`.
CONTACT_QUERY = (
    'fields @timestamp | filter message like /"request_id"/ '
    '| parse message /"event": "(?<ev>[a-z-]+)"/ '
    '| parse message /"reason": "(?<rs>[^"]+)"/ '
    '| fields coalesce(rs, "-") as reason '
    "| filter ispresent(ev) "
    "| stats count(*) as n by ev, reason, datefloor(@timestamp, 1d) as day"
)
API_QUERY = (
    "filter `cs-uri-stem` like /^\\/api\\// "
    "| stats count(*) as n by `sc-status` as status, datefloor(@timestamp, 1d) as day"
)
# Published contact counters. "sent", "send-failed" and "smoke-test" are deliberately absent.
CONTACT_KEYS = ("honeypot", "bypass", "cross_origin", "invalid", "throttled", "wrong_route")
REASON = re.compile(r"^(malformed|[a-z_]{1,20} (missing|length|format))$")
ROW_LIMIT = 10_000
TREND_DAYS = 30
BACKFILL_PER_RUN = 7
TOP_PATHS = 15
TOP_COUNTRIES = 10
MAX_PATH = 80
QUERY_TIMEOUT_S = 25
MIN_TIME_LEFT_MS = 30_000
LOG_RETENTION_DAYS = int(os.environ.get("LOG_RETENTION_DAYS", "30"))

EMAIL = re.compile(r"[^/@\s]+@[^/@\s]+\.[a-z]{2,}", re.I)
STATUS = re.compile(r"^\d{3}$")
COUNTRY = re.compile(r"^[A-Z]{2}$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_logs = None
_s3 = None
_sleep = time.sleep


def load_patterns(path=Path(__file__).with_name("patterns.json")):
    raw = json.loads(Path(path).read_text())
    cats = []
    for c in raw["categories"]:
        cats.append({
            **{k: v for k, v in c.items() if k in ("id", "label", "tactic", "mitre")},
            "ua_scanner": bool(c.get("ua_scanner")),
            "path": [re.compile(p, re.I) for p in c.get("path", [])],
            "path_or_query": [re.compile(p, re.I) for p in c.get("path_or_query", [])],
        })
    families = [(f["family"], re.compile(f["ua"], re.I), bool(f.get("scanner"))) for f in raw["user_agents"]]
    return cats, families


CATEGORIES, FAMILIES = load_patterns()


def decode(value):
    if not value or value == "-":
        return ""
    return urllib.parse.unquote(urllib.parse.unquote(value)).lower()


def family(ua):
    if not ua or ua == "-":
        return "No user agent", False
    for name, rx, scanner in FAMILIES:
        if rx.search(ua):
            return name, scanner
    return "Other", False


def classify(path, query, ua):
    """Return (category id or None, publishable path flag, scanner family)."""
    p, q = decode(path), decode(query)
    fam, scanner = family(ua)
    for c in CATEGORIES:
        if any(r.search(p) for r in c["path"]) or any(r.search(p) for r in c["path_or_query"]):
            return c["id"], True, fam
        if any(r.search(q) for r in c["path_or_query"]):
            return c["id"], False, fam
        if c["ua_scanner"] and scanner:
            return c["id"], False, fam
    return None, False, fam


def publishable(path):
    """Percent-encode, redact emails and truncate a probe path for display."""
    text = EMAIL.sub("[redacted]", urllib.parse.unquote(path))
    text = urllib.parse.quote(text, safe="/._-~+:[]")
    if len(text) > MAX_PATH:
        text = re.sub(r"%[0-9A-Fa-f]?$", "", text[: MAX_PATH - 1]) + "…"
    return text


def summarize(rows):
    s = {
        "requests": 0, "probes": 0,
        "by_category": Counter(), "statuses": {}, "probe_statuses": Counter(),
        "paths": Counter(), "path_category": {}, "families": Counter(), "countries": Counter(),
        "api": Counter(),
    }
    for r in rows:
        if r.get("ua") == SELF_UA:
            continue
        try:
            n = int(r.get("n", "0"))
        except ValueError:
            continue
        s["requests"] += n
        key = api_key(r.get("path", ""), r.get("status", ""))
        if key:
            s["api"][key] += n
        cat, show_path, fam = classify(r.get("path", ""), r.get("query", ""), r.get("ua", ""))
        if not cat:
            continue
        status = r.get("status", "")
        status = status if STATUS.match(status) else "other"
        country = r.get("country", "")
        s["probes"] += n
        s["by_category"][cat] += n
        s["statuses"].setdefault(cat, Counter())[status] += n
        s["probe_statuses"][status] += n
        s["families"][fam] += n
        s["countries"][country if COUNTRY.match(country) else "Unknown"] += n
        if show_path:
            shown = publishable(r.get("path", ""))
            s["paths"][shown] += n
            s["path_category"][shown] = cat
    return s


def run_query(logs, group, start, end, query=QUERY):
    qid = logs.start_query(
        logGroupName=group,
        startTime=int(start.timestamp()),
        endTime=int(end.timestamp()),
        queryString=query,
        limit=ROW_LIMIT,
    )["queryId"]
    deadline = time.monotonic() + QUERY_TIMEOUT_S
    while True:
        res = logs.get_query_results(queryId=qid)
        if res["status"] == "Complete":
            break
        if res["status"] in ("Failed", "Cancelled", "Timeout", "Unknown"):
            raise RuntimeError(f"query {res['status']}")
        if time.monotonic() > deadline:
            logs.stop_query(queryId=qid)
            raise TimeoutError("Logs Insights query timed out")
        _sleep(1)
    rows = [{f["field"]: f["value"] for f in row} for row in res.get("results", [])]
    return rows, len(rows) >= ROW_LIMIT


def fetch_previous(host):
    """Previous published report's daily trend, or [] if missing or malformed."""
    try:
        req = urllib.request.Request(f"https://{host}/data/edge-threats.json", headers={"User-Agent": SELF_UA})
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- always https://<SITE_DOMAIN> set by Terraform, never visitor input
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read(1_000_000))
        daily = data["daily"] if data.get("version") == 1 else []
        out = [
            d for d in daily
            if isinstance(d, dict) and DAY.match(str(d.get("date", "")))
            and isinstance(d.get("requests"), int) and isinstance(d.get("probes"), int)
            and isinstance(d.get("by_category"), dict)
        ]
        for d in out:
            api = d.get("api")
            d["api"] = {k: v for k, v in api.items() if k in ("throttled", "wrong_route") and isinstance(v, int)} if isinstance(api, dict) else {}
        return out
    except Exception:
        return []


def api_key(path, status):
    """Contact form traffic the access logs see: throttled (429) or a wrong route or method (404/405)."""
    if not str(path).startswith("/api/"):
        return None
    return "throttled" if status == "429" else "wrong_route" if status in ("404", "405") else None


def contact_key(ev, reason):
    if ev == "honeypot":
        return "honeypot"
    if ev == "rejected":
        return {"origin-secret": "bypass", "cross-origin": "cross_origin"}.get(reason)
    if ev == "invalid":
        return "invalid"
    return None  # sent, send-failed, smoke-test, anything unknown: never published


def build_contact(logs, contact_group, access_group, now, stored_daily=None):
    """30-day counts of the contact form's defenses, one entry per UTC day, oldest first."""
    today = now.date()
    days = [today - dt.timedelta(days=i) for i in range(TREND_DAYS - 1, -1, -1)]
    daily = {d.isoformat(): dict.fromkeys(CONTACT_KEYS, 0) for d in days}
    start = dt.datetime.combine(days[0], dt.time.min, tzinfo=dt.timezone.utc)
    reasons = Counter()

    rows, _ = run_query(logs, contact_group, start, now, CONTACT_QUERY)
    for r in rows:
        day, key = r.get("day", "")[:10], contact_key(r.get("ev"), r.get("reason"))
        try:
            n = int(r.get("n", "0"))
        except ValueError:
            continue
        if key and day in daily:
            daily[day][key] += n
            if key == "invalid":
                reason = r.get("reason", "")
                reasons[reason if REASON.match(reason) else "other"] += n

    # Access logs only go back LOG_RETENTION_DAYS; older days come from the published daily history.
    in_logs = [d for d in days if d > today - dt.timedelta(days=LOG_RETENTION_DAYS)]
    for d in days:
        if d not in in_logs:
            stored = (stored_daily or {}).get(d.isoformat(), {}).get("api", {})
            for key in ("throttled", "wrong_route"):
                daily[d.isoformat()][key] += stored.get(key, 0) if isinstance(stored.get(key), int) else 0
    api_start = dt.datetime.combine(in_logs[0], dt.time.min, tzinfo=dt.timezone.utc)
    rows, _ = run_query(logs, access_group, api_start, now, API_QUERY)
    for r in rows:
        day, status = r.get("day", "")[:10], r.get("status", "")
        key = "throttled" if status == "429" else "wrong_route" if status in ("404", "405") else None
        try:
            n = int(r.get("n", "0"))
        except ValueError:
            continue
        if key and day in daily:
            daily[day][key] += n

    return {
        "days": TREND_DAYS,
        "totals": {k: sum(d[k] for d in daily.values()) for k in CONTACT_KEYS},
        "invalid_reasons": [{"reason": k, "count": n} for k, n in reasons.most_common()],
        "daily": [{"date": k, **v} for k, v in daily.items()],
    }


def day_entry(date, s, truncated):
    return {
        "date": date.isoformat(),
        "requests": s["requests"],
        "probes": s["probes"],
        "by_category": dict(s["by_category"]),
        "api": dict(s["api"]),
        "truncated": truncated,
    }


def build_report(logs, group, now, previous_daily, time_left_ms=lambda: 10**9, contact_group=None):
    start = now - dt.timedelta(hours=24)
    rows, truncated = run_query(logs, group, start, now)
    s = summarize(rows)

    today = now.date()
    oldest = today - dt.timedelta(days=TREND_DAYS)
    daily = {d["date"]: d for d in previous_daily if d["date"] >= oldest.isoformat() and d["date"] < today.isoformat()}
    missing = [today - dt.timedelta(days=i) for i in range(1, TREND_DAYS + 1)]
    # Days older than the log retention would query as empty and look like zero traffic: leave them as gaps.
    missing = [d for d in missing if d.isoformat() not in daily and d > today - dt.timedelta(days=LOG_RETENTION_DAYS)][:BACKFILL_PER_RUN]
    for day in missing:
        if time_left_ms() < MIN_TIME_LEFT_MS:
            break
        ds = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc)
        try:
            drows, dtrunc = run_query(logs, group, ds, ds + dt.timedelta(days=1))
        except Exception as e:
            # Logs Insights rejects windows that end before the log group existed. Days are
            # newest first, so every older day would fail too: logging hadn't started yet.
            if getattr(e, "response", {}).get("Error", {}).get("Code") == "MalformedQueryException":
                break
            raise
        daily[day.isoformat()] = day_entry(day, summarize(drows), dtrunc)

    contact = None
    if contact_group:
        try:
            contact = build_contact(logs, contact_group, group, now, daily)
        except Exception as e:  # noqa: BLE001 - the probe report still publishes; the page hides the section
            print(json.dumps({"outcome": "contact-stats-failed", "error": type(e).__name__}))

    categories = []
    for c in CATEGORIES:
        categories.append({
            "id": c["id"], "label": c["label"], "tactic": c["tactic"], "mitre": c["mitre"],
            "count": s["by_category"].get(c["id"], 0),
            "statuses": dict(s["statuses"].get(c["id"], {})),
        })

    return {
        "version": 1,
        "generated_at": now.isoformat(timespec="seconds"),
        "window": {"start": start.isoformat(timespec="seconds"), "end": now.isoformat(timespec="seconds")},
        "totals": {"requests": s["requests"], "probes": s["probes"], "truncated": truncated},
        "categories": categories,
        "probe_statuses": dict(s["probe_statuses"]),
        "top_paths": [
            {"path": p, "category": s["path_category"][p], "count": n} for p, n in s["paths"].most_common(TOP_PATHS)
        ],
        "scanner_families": [{"family": f, "count": n} for f, n in s["families"].most_common()],
        "countries": [{"code": c, "count": n} for c, n in s["countries"].most_common(TOP_COUNTRIES)],
        "daily": [daily[k] for k in sorted(daily)],
        "contact": contact,
    }


def lambda_handler(event, context):
    global _logs, _s3
    if _logs is None or _s3 is None:
        import boto3  # lazy: keeps unit tests free of boto3

        _logs = _logs or boto3.client("logs")
        _s3 = _s3 or boto3.client("s3")

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    time_left = getattr(context, "get_remaining_time_in_millis", lambda: 10**9)
    report = build_report(_logs, os.environ["LOG_GROUP"], now, fetch_previous(os.environ["SITE_HOST"]), time_left,
                          contact_group=os.environ.get("CONTACT_LOG_GROUP"))
    _s3.put_object(
        Bucket=os.environ["BUCKET"],
        Key=os.environ["OBJECT_KEY"],
        Body=json.dumps(report, separators=(",", ":")).encode(),
        ContentType="application/json",
        CacheControl="public, max-age=300",
    )
    print(json.dumps({"outcome": "published", "requests": report["totals"]["requests"],
                      "probes": report["totals"]["probes"], "days": len(report["daily"])}))
    return {"requests": report["totals"]["requests"], "probes": report["totals"]["probes"]}
