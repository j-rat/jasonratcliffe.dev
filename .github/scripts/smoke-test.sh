#!/usr/bin/env bash
# Live checks after a deploy. Runs every check (doesn't stop at the first failure), writes a pass/fail table
# to the job summary, and exits 1 if any failed. Usage: smoke-test.sh <domain> <site-bucket>
set -uo pipefail
domain=$1 bucket=$2
url="https://$domain"
rows=() failed=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

check() { # check "<description>" <command...>
  local name=$1; shift
  local start=$SECONDS
  if "$@" > "$tmp/out" 2>&1; then
    rows+=("| ✅ | $name | $((SECONDS - start))s |")
  else
    rows+=("| ❌ | $name | $((SECONDS - start))s |")
    failed=$((failed + 1))
    echo "::error::Smoke test failed: $name"
    sed 's/^/    /' "$tmp/out" | head -n 5
  fi
}
status() { test "$(curl -s -o /dev/null -w '%{http_code}' "${@:2}")" = "$1"; }

curl -sfI "$url/" > "$tmp/headers" || true
has() { grep -qi "^$1:" "$tmp/headers"; }
check "Home page returns 200" status 200 "$url/"
for h in strict-transport-security content-security-policy x-content-type-options referrer-policy \
         permissions-policy x-frame-options cross-origin-opener-policy cross-origin-embedder-policy; do
  check "Header: $h" has "$h"
done
check "No origin Server header (AmazonS3)" bash -c "! grep -qi '^server: *AmazonS3' '$tmp/headers'"
check "Resume PDF returns 200" status 200 "$url/resume.pdf"
check "/architecture/ returns 200" status 200 "$url/architecture/"
check "/edge/ returns 200" status 200 "$url/edge/"
check "security.txt returns 200" status 200 "$url/.well-known/security.txt"
check "Unknown path returns 404" status 404 "$url/does-not-exist"
check "www redirects to the apex" test "$(curl -s -o /dev/null -w '%{redirect_url}' "https://www.$domain/blog/")" = "$url/blog/"
check "HTTP redirects to HTTPS (301)" status 301 "http://$domain/"
check "Bucket is not reachable directly (403)" status 403 "https://$bucket.s3.amazonaws.com/index.html"
# The smoke-test body gets a 400 and is logged as "smoke-test", so /edge/ doesn't count it as rejected input.
check "Contact API answers through CloudFront (400)" status 400 -X POST -H 'Content-Type: application/json' \
  -H "Origin: $url" -d '{"smoke_test":true}' "$url/api/contact"
if [ "$(curl -s -o "$tmp/edge.json" -w '%{http_code}' "$url/data/edge-threats.json")" = 200 ]; then
  check "Edge report is version 1" jq -e '.version == 1' "$tmp/edge.json"
  check "Edge report never counts real messages" jq -e '.contact == null or (.contact | tostring | test("sent") | not)' "$tmp/edge.json"
else
  echo "::warning::data/edge-threats.json not published yet"
fi

{
  echo "### Live checks for $url: $(( ${#rows[@]} - failed ))/${#rows[@]} passed"
  echo
  echo "| | Check | Time |"
  echo "|---|---|---|"
  printf '%s\n' "${rows[@]}"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
[ "$failed" -eq 0 ]
