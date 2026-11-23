"""Unit tests for the edge report. Run: python3 -m unittest -v (from this folder)."""

import datetime as dt
import io
import json
import os
import re
import unittest
from unittest import mock

os.environ.update(
    LOG_GROUP="/aws/vendedlogs/test-cloudfront",
    BUCKET="test-bucket",
    OBJECT_KEY="data/edge-threats.json",
    SITE_HOST="example.test",
)

import handler  # noqa: E402

handler._sleep = lambda _s: None
NOW = dt.datetime(2026, 11, 23, 12, 0, tzinfo=dt.timezone.utc)
BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"


def row(path, status="404", ua=BROWSER, country="US", n=1, query="-"):
    return {"path": path, "query": query, "status": status, "ua": ua, "country": country, "n": str(n)}


class FakeLogs:
    """Returns `rows` for the rolling 24h window and `day_rows` for each full-day backfill query."""

    def __init__(self, rows, day_rows=None, pending=0):
        self.rows, self.day_rows, self.pending = rows, day_rows or [], pending
        self.queries = []

    def start_query(self, **kw):
        self.queries.append(kw)
        return {"queryId": str(len(self.queries))}

    def get_query_results(self, queryId):
        if self.pending:
            self.pending -= 1
            return {"status": "Running"}
        kw = self.queries[int(queryId) - 1]
        rows = self.day_rows if kw["endTime"] - kw["startTime"] == 86400 and kw["startTime"] % 86400 == 0 else self.rows
        return {"status": "Complete", "results": [[{"field": k, "value": v} for k, v in r.items()] for r in rows]}

    def stop_query(self, queryId):
        pass


class FakeS3:
    def __init__(self):
        self.puts = []

    def put_object(self, **kw):
        self.puts.append(kw)


def report(rows, previous=None, **kw):
    return handler.build_report(FakeLogs(rows, **kw), "g", NOW, previous or [])


def cat(rep, cid):
    return next(c for c in rep["categories"] if c["id"] == cid)


class ClassifyTests(unittest.TestCase):
    CASES = [
        ("/.env", "credentials-in-files", "T1552.001"),
        ("/app/.env.production", "credentials-in-files", "T1552.001"),
        ("/.aws/credentials", "credentials-in-files", "T1552.001"),
        ("/wp-config.php.bak", "credentials-in-files", "T1552.001"),
        ("/id_rsa", "private-keys", "T1552.004"),
        ("/server.pem", "private-keys", "T1552.004"),
        ("/.git/config", "code-repositories", "T1213.003"),
        ("/.svn/entries", "code-repositories", "T1213.003"),
        ("/backup.zip", "backups-and-dumps", "T1005"),
        ("/db.sql", "backups-and-dumps", "T1005"),
        ("/server-status", "server-fingerprinting", "T1592.002"),
        ("/actuator/env", "server-fingerprinting", "T1592.002"),
        ("/.DS_Store", "server-fingerprinting", "T1592.002"),
        ("/phpinfo.php", "server-fingerprinting", "T1592.002"),
        ("/wp-login.php", "cms-admin-enumeration", "T1595.003"),
        ("/phpmyadmin/", "cms-admin-enumeration", "T1595.003"),
        ("/xmlrpc.php", "cms-admin-enumeration", "T1595.003"),
        ("/..%2f..%2fetc%2fpasswd", "exploit-attempts", "T1190"),
        ("/cgi-bin/luci", "exploit-attempts", "T1190"),
    ]

    def test_categories_and_mitre(self):
        for path, expected, technique in self.CASES:
            with self.subTest(path=path):
                cid, _, _ = handler.classify(path, "-", BROWSER)
                self.assertEqual(cid, expected)
                self.assertIn(technique, [m["id"] for m in cat(report([]), cid)["mitre"]])

    def test_normal_pages_are_not_probes(self):
        for path in ["/", "/blog/", "/resume.pdf", "/_astro/index.abc123.css", "/.well-known/security.txt", "/favicon.svg"]:
            with self.subTest(path=path):
                self.assertIsNone(handler.classify(path, "-", BROWSER)[0])

    def test_exploit_in_query_string_is_caught_but_path_not_published(self):
        for query in ["x=%24%7Bjndi%3Aldap%3A%2F%2Fevil%7D", "id=1%27%20or%20%271%27%3D%271", "f=..%2F..%2Fetc%2Fpasswd"]:
            with self.subTest(query=query):
                self.assertEqual(handler.classify("/search", query, BROWSER), ("exploit-attempts", False, "Browser-like"))

    def test_scanner_user_agent_on_normal_page(self):
        cid, shown, fam = handler.classify("/", "-", "Mozilla/5.0 (compatible; Nuclei - Open-source project)")
        self.assertEqual((cid, shown, fam), ("vulnerability-scanning", False, "Nuclei"))

    def test_scanner_families(self):
        for ua, fam in [("curl/8.4.0", "curl"), ("python-requests/2.32", "Python HTTP client"), ("Go-http-client/1.1", "Go HTTP client"),
                        ("-", "No user agent"), ("", "No user agent"), ("zgrab/0.x", "zgrab"), ("weird", "Other")]:
            with self.subTest(ua=ua):
                self.assertEqual(handler.family(ua)[0], fam)


class ReportTests(unittest.TestCase):
    def test_totals_statuses_paths_families_countries(self):
        rep = report([
            row("/", "200", n=50),
            row("/.env", n=7, ua="curl/8.4.0", country="NL"),
            row("/.git/config", "403", n=3, ua="zgrab/0.x", country="CN"),
            row("/wp-login.php", n=2, country="ZZZ"),
        ])
        self.assertEqual(rep["totals"], {"requests": 62, "probes": 12, "truncated": False})
        self.assertEqual(cat(rep, "credentials-in-files")["statuses"], {"404": 7})
        self.assertEqual(rep["probe_statuses"], {"404": 9, "403": 3})
        self.assertEqual(rep["top_paths"][0], {"path": "/.env", "category": "credentials-in-files", "count": 7})
        self.assertEqual({f["family"] for f in rep["scanner_families"]}, {"curl", "zgrab", "Browser-like"})
        self.assertIn({"code": "Unknown", "count": 2}, rep["countries"])
        self.assertEqual(len(rep["categories"]), 8)

    def test_never_publishes_ips_or_query_strings(self):
        rep = report([
            row("/.env", query="token=s3cr3t&ip=203.0.113.9"),
            row("/search", query="q=%24%7Bjndi%3Aldap%3A%2F%2F198.51.100.7%2Fa%7D"),
        ])
        text = json.dumps(rep)
        self.assertNotIn("s3cr3t", text)
        self.assertNotIn("jndi", text)
        self.assertIsNone(re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b", text))
        self.assertNotIn("/search", text)

    def test_unsafe_characters_encoded_and_emails_redacted(self):
        rep = report([row("/<script>alert(1)</script>.php"), row("/admin/someone%40mail.example/.env")])
        paths = [p["path"] for p in rep["top_paths"]]
        self.assertTrue(all("<" not in p and ">" not in p for p in paths))
        self.assertTrue(any("%3Cscript%3E" in p for p in paths))
        self.assertTrue(any("[redacted]" in p for p in paths))
        self.assertNotIn("someone", json.dumps(rep))

    def test_long_paths_truncated(self):
        shown = report([row("/" + "a" * 200 + "/.env")])["top_paths"][0]["path"]
        self.assertLessEqual(len(shown), handler.MAX_PATH)
        self.assertTrue(shown.endswith("…"))

    def test_own_history_fetch_is_ignored(self):
        rep = report([row("/data/edge-threats.json", "200", ua=handler.SELF_UA, n=5)])
        self.assertEqual(rep["totals"]["requests"], 0)

    def test_truncation_flag(self):
        rep = report([row(f"/p{i}", "200") for i in range(handler.ROW_LIMIT)])
        self.assertTrue(rep["totals"]["truncated"])


class TrendTests(unittest.TestCase):
    def entry(self, date, probes=1):
        return {"date": date, "requests": 10, "probes": probes, "by_category": {"credentials-in-files": probes}, "truncated": False}

    def test_backfills_missing_days_up_to_limit(self):
        logs = FakeLogs([], day_rows=[row("/.env", n=4)])
        rep = handler.build_report(logs, "g", NOW, [])
        self.assertEqual(len(logs.queries), 1 + handler.BACKFILL_PER_RUN)
        self.assertEqual(rep["daily"][-1]["date"], "2026-11-22")
        self.assertEqual(rep["daily"][-1]["probes"], 4)

    def test_keeps_history_skips_known_days_and_trims_to_30(self):
        previous = [self.entry((NOW.date() - dt.timedelta(days=i)).isoformat()) for i in range(1, 45)]
        logs = FakeLogs([])
        rep = handler.build_report(logs, "g", NOW, previous)
        self.assertEqual(len(logs.queries), 1)
        self.assertEqual(len(rep["daily"]), handler.TREND_DAYS)
        self.assertEqual(rep["daily"][0]["date"], "2026-10-24")

    def test_stops_backfilling_when_time_is_short(self):
        logs = FakeLogs([])
        handler.build_report(logs, "g", NOW, [], time_left_ms=lambda: 1000)
        self.assertEqual(len(logs.queries), 1)

    def test_previous_report_validation(self):
        good = {"version": 1, "daily": [self.entry("2026-11-20"), {"date": "<script>", "requests": 1}, "junk"]}
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(good).encode())):
            self.assertEqual([d["date"] for d in handler.fetch_previous("example.test")], ["2026-11-20"])
        with mock.patch("urllib.request.urlopen", side_effect=OSError("down")):
            self.assertEqual(handler.fetch_previous("example.test"), [])
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(b"not json")):
            self.assertEqual(handler.fetch_previous("example.test"), [])


class QueryAndHandlerTests(unittest.TestCase):
    def test_polls_until_complete(self):
        logs = FakeLogs([row("/.env")], pending=2)
        rows, truncated = handler.run_query(logs, "g", NOW - dt.timedelta(hours=1), NOW)
        self.assertEqual((len(rows), truncated), (1, False))

    def test_handler_publishes_json_with_cache_headers(self):
        s3 = FakeS3()
        handler._logs, handler._s3 = FakeLogs([row("/.env")]), s3
        with mock.patch.object(handler, "fetch_previous", return_value=[]):
            result = handler.lambda_handler({}, None)
        self.assertEqual(result, {"requests": 1, "probes": 1})
        put = s3.puts[0]
        self.assertEqual((put["Bucket"], put["Key"], put["ContentType"]), ("test-bucket", "data/edge-threats.json", "application/json"))
        self.assertEqual(put["CacheControl"], "public, max-age=300")
        self.assertEqual(json.loads(put["Body"])["version"], 1)


if __name__ == "__main__":
    unittest.main()
