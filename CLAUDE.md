# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Resume site for jasonratcliffe.dev. It has three parts:
- An Astro static site (`site/`).
- Two Terraform stacks (`infra/bootstrap`, `infra/main`).
- GitHub Actions workflows that deploy through OIDC.

`spec/spec.json` is the agreed build spec. Each must-have has an acceptance test, plus there are
`reject_if` lines. If a change conflicts with it, point at the line and confirm with the user before
diverging. `docs/DEPLOYMENT.md` is the operator runbook. Keep it in sync when workflows, secrets,
outputs or resource counts change.

## Commands

```bash
make install            # npm ci in site/ + Playwright Chromium (needed for the PDF)
make dev                # astro dev on :4321
make build              # astro build → scripts/build-pdf.mjs → scripts/pii-scan.mjs (fails on findings)
make scan               # PII scan only (cd site && node scripts/pii-scan.mjs [--dist-only|--repo-only])
make test               # Lambda unit tests (stdlib unittest, no boto3 needed)
make lint               # terraform fmt -check + validate for both stacks (no AWS creds needed)
make check              # build + test + lint (what CI runs before planning)
cd site && npx astro check                                   # TypeScript/Astro type check
cd infra/main/lambda/contact && python3 -m unittest test_handler.ContactTests.test_honeypot_fakes_success_without_sending -v   # single test
```

Terraform isn't installed system-wide on this machine. CI pins 1.16.6 (`TF_VERSION` in both workflows).

## Hard rules

- **No personal contact data anywhere committable or built.** No email, phone, street address or ZIP.
  The source `.docx` is git-ignored and must stay that way. `site/scripts/pii-scan.mjs` matches known
  values by salted SHA-256, plus generic regexes. Never weaken it to make a build pass; change the
  content instead.
- **No AWS account IDs, ARNs or real resource names in site content.** The architecture page uses
  generic labels. Terraform outputs naming resources are `sensitive`, and workflows mask them and never
  print plan/apply output (only resource addresses go to the job summary).
- **CSP has no `'unsafe-inline'`** (`infra/main/cdn.tf` `local.csp`). Don't add inline `<script>`, `style=""`
  attributes or third-party origins. Astro is configured to keep scripts and CSS external
  (`inlineStylesheets: 'never'`, `assetsInlineLimit: 0`), and Markdown uses Prism (classes) rather than Shiki
  (inline styles). After site changes, check with `grep -o '<script[^>]*>' site/dist/index.html` (every
  tag needs `src=`) and `grep -rl 'style="' site/dist`.
- Terminal and animation output is built with DOM text nodes. Don't introduce `innerHTML`.

## Architecture (the parts that span files)

**One content source.** `site/src/data/resume.ts` feeds the home page, the terminal
(`src/scripts/terminal.ts`) and the print page `src/pages/resume.astro`. `scripts/build-pdf.mjs` renders
that page to `dist/resume.pdf` with headless Chromium. `src/data/threat-model.ts` maps STRIDE categories to
resume facts, and every entry must trace to a line in `resume.ts`. Blog posts are Markdown in
`src/content/blog/` (schema in `src/content.config.ts`, Astro 7 content layer with the `glob` loader).

**Request path.** CloudFront handles everything:
- **Default behavior:** private S3 bucket through OAC. A viewer-request CloudFront Function
  (`infra/main/functions/viewer-request.js`, rendered by `templatefile`) 301s any non-apex host to the
  apex and maps clean URLs to `/index.html`.
- **`/api/*`:** an API Gateway HTTP API (stage throttling), then the Lambda (`infra/main/lambda/contact/handler.py`),
  then SES. CloudFront injects an `X-Origin-Verify` secret (`random_password.origin_verify`) that the Lambda
  checks, so the API is effectively same-origin only. The site posts to `/api/contact` relatively.
- **`*.pdf`:** a separate headers policy without CSP, so browser PDF viewers work.
- S3 403s and 404s map to `/404.html`, because the bucket deliberately has no ListBucket grant.

**Two stacks and the permission model.**
- `infra/bootstrap` is applied once, locally, with admin credentials. It owns:
  - the state bucket
  - the Route 53 zone (so its nameservers stay stable)
  - the GitHub OIDC provider
  - `gha-resume-site-plan`, trusted for `repo:<repo>:pull_request`, with ReadOnlyAccess plus state access
  - `gha-resume-site-apply`, trusted for `repo:<repo>:environment:production`, with a scoped deploy policy
  - the `boundary-resume-site-workload` permissions boundary
- `infra/main` is applied only by CI and finds the zone and boundary through data sources.

Consequences of this model:
- Every IAM role in `infra/main` must set `permissions_boundary` and be named `resume-site-*`, or the
  apply role's `iam:CreateRole` is denied.
- Buckets must be named `resume-site-origin-*`, and Lambda functions and log groups `resume-site-*`.
- A new AWS service or action used by `infra/main` usually needs adding to
  `data.aws_iam_policy_document.deploy` in `infra/bootstrap/github-oidc.tf`, applied locally, before CI can use it.
- The `project` variable must match between the two stacks.

**State.** S3 backend with partial config. Bucket, region, `encrypt` and `use_lockfile` come from
`infra/backend.hcl` locally (git-ignored; see `backend.hcl.example`) or from `-backend-config` built from
GitHub secrets in CI. Keys: `main/terraform.tfstate`, `bootstrap/terraform.tfstate`. The CI roles can only
touch `main/*`.

**Workflows.**
- `ci.yml` (PRs) runs: site build plus scan, Lambda tests, Terraform lint, and a plan whose summary lists
  addresses and actions only.
- `deploy.yml` (main) runs `build`, which uploads the `site-dist` artifact, then a single approval-gated
  `deploy` job: terraform apply, then `s3 sync` (`_astro/` immutable for a year, without `--delete`; everything else
  `max-age=300` with `--delete`), invalidation, and live smoke tests.
- Actions are pinned to commit SHAs with a version comment. Keep that when bumping (Dependabot is configured).

## Conventions

- Styling: CSS custom properties in `site/src/styles/global.css`, dark theme, monospace headings, and
  component-scoped `<style>` blocks. The PDF has its own light stylesheet, `src/styles/print-resume.css`.
- Region is `us-east-1` everywhere, because CloudFront requires the ACM certificate there.
- Secrets: `AWS_PLAN_ROLE_ARN`, `TF_STATE_BUCKET` and `CONTACT_TO_EMAIL` are repository secrets.
  `AWS_APPLY_ROLE_ARN` is a `production` environment secret.
