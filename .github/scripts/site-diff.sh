#!/usr/bin/env bash
# Compare a built site with what's live in the bucket, by content (S3 ETag = MD5 for these single-part uploads).
# Writes a count to $GITHUB_OUTPUT (summary=...) and the list of pages to $GITHUB_STEP_SUMMARY.
# Paths only, never the bucket name. Mirrors deploy.yml's sync rules: data/* is never touched, and
# _astro/* (fingerprinted assets) is added but never deleted.
# Usage: site-diff.sh <dist-dir> <bucket>
set -euo pipefail
export LC_ALL=C # sort and join must agree on order
dist=$1 bucket=$2
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

(cd "$dist" && find . -type f -print0 | sort -z | xargs -0 md5sum) \
  | sed -E 's#^([0-9a-f]{32})  \./#\1 #' | awk '{print $2" "$1}' | sort > "$work/local"
aws s3api list-objects-v2 --bucket "$bucket" --query 'Contents[].[Key,ETag]' --output text \
  | awk '$1 != "None" {gsub(/"/, "", $2); print $1" "$2}' | grep -v '^data/' | sort > "$work/remote" || true

join -v1 "$work/local" "$work/remote" | cut -d' ' -f1 > "$work/new"
join "$work/local" "$work/remote" | awk '$2 != $3 {print $1}' > "$work/changed"
join -v2 "$work/local" "$work/remote" | cut -d' ' -f1 | grep -v '^_astro/' > "$work/removed" || true

count() { wc -l < "$1" | tr -d ' '; }
summary="$(count "$work/new") new, $(count "$work/changed") changed, $(count "$work/removed") removed"
echo "summary=$summary" >> "${GITHUB_OUTPUT:-/dev/null}"

list() { # pages in full, fingerprinted assets as a count
  local label=$1 file=$2 assets
  [ -s "$file" ] || return 0
  assets=$(grep -c '^_astro/' "$file" || true)
  echo "**$label**"
  # grep -v exits 1 when every entry is an asset; under pipefail that would end the script.
  { grep -v '^_astro/' "$file" || true; } | head -n 40 | sed 's/.*/- `&`/'
  if [ "$assets" -gt 0 ]; then echo "- $assets fingerprinted asset file(s) in \`_astro/\`"; fi
  echo
}
{
  echo "### Site files: $summary"
  echo
  list New "$work/new"
  list Changed "$work/changed"
  list Removed "$work/removed"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
