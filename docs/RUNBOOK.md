# Running jasonratcliffe.dev

Day-to-day operations once the site is live. First-time setup (AWS bootstrap, DNS, GitHub secrets, the first
deploy) is in **[SETUP.md](SETUP.md)**.

| Section | For |
|---|---|
| [1 How the pipeline works](#1-how-the-pipeline-works) | What runs on a pull request, a merge and every Monday |
| [2 Day-to-day changes](#2-day-to-day-changes) | Editing the resume or blog, reading the plan, approving |
| [3 Rollback](#3-rollback) | Undoing a bad deploy |
| [4 Troubleshooting](#4-troubleshooting) | Error text → cause → fix |
| [5 Alerts](#5-alerts) | What emails you, and what to do about it |
| [6 DNSSEC](#6-dnssec) | Turning on the chain of trust, rotating, turning off |
| [7 Hardening and maintenance](#7-hardening-and-maintenance) | Secret rotation, drift, cost tag |
| [8 Edge telemetry dashboard](#8-edge-telemetry-dashboard) | `/edge/`: probes, contact defenses, patterns |
| [9 Security checks](#9-security-checks-in-the-pipeline) | What the scanners block, handling findings |

---

## 1. How the pipeline works

```text
 feature branch ──PR──▶ ci.yml
                          ├─ checks:  checks.yml
                          │    ├─ site:   npm ci → astro check → build → PDF → PII scan → artifact "site-dist"
                          │    ├─ lambda: python unittest
                          │    ├─ lint:   fmt -check, validate (both stacks)
                          │    └─ plan:   OIDC → gha-resume-site-plan (read-only) → plan + changed site files
                          ├─ scan:    scan.yml (CodeQL, Semgrep, Checkov, zizmor, TruffleHog, npm audit, ZAP) - section 9
                          └─ dependency-review: new dependencies with high/critical advisories fail

 merge to main ─────▶ deploy.yml
                          ├─ checks:  checks.yml, same as above. Its summary is what you approve.
                          ├─ scan:    scan.yml, in parallel; blocking findings stop the deploy
                          └─ deploy:  ⏸ waits for your approval (environment: production)
                                      OIDC → gha-resume-site-apply
                                      → terraform plan; must match the approved plan; apply   (skipped if no changes)
                                      → s3 sync → edge report → CloudFront invalidation → live smoke tests

 Mondays / manual ──▶ security.yml
                          ├─ weekly:  scan.yml over full git history
                          └─ zap:     passive ZAP baseline of the live site
```

- **OIDC subjects.** The plan role trusts `repo:<owner>/<repo>:pull_request` and `…:ref:refs/heads/main`; the
  apply role trusts only `…:environment:production`. (With immutable subjects the prefix is
  `repo:<owner>@<id>/<repo>@<id>`; [SETUP.md 5.4](SETUP.md#54-match-the-oidc-subject-format).)
- **Plan before approval.** The read-only plan runs before the approval gate and writes two tables to the run
  summary: the Terraform resources that will change, and the site files that will be new, changed or removed
  (compared by content with what's live). The plan file itself contains secrets and the repo is public, so it
  never leaves that job. Instead the deploy job plans again after approval and refuses to apply if the list of
  changes differs from the one you approved. If the approved plan had no changes, Terraform is skipped.
- **Shared workflows.** `checks.yml` and `scan.yml` are reusable; `ci.yml` and `deploy.yml` call them, so a
  check is defined once. Helper scripts (plan fingerprint, site diff, smoke tests) are in `.github/scripts/`,
  and scanner configs in `.github/security/`.
- **Visibility.** Each run's **Summary** page shows: the plan and site-file tables, a per-scanner result table,
  a **Deployed** table (Terraform, files, edge report, invalidation time) and a pass/fail row for every smoke
  test. The run's **View deployment** link and the repo's **Deployments** page record every release.

---

## 2. Day-to-day changes

```bash
git switch -c update-resume
# edit site/src/data/resume.ts      (all resume content: site, terminal and PDF)
# or add site/src/content/blog/my-post.md
make dev                            # preview at http://localhost:4321
make check                          # same gates as CI
git commit -am "Update experience" && git push -u origin update-resume
gh pr create --fill                 # or open the PR in the browser
```

On the PR, **ci** runs the checks and scans. Open the run's **Summary** to see exactly which AWS resources
and which site pages would change. For content-only changes Terraform says *No infrastructure changes*.

Merge the PR. The **deploy** run plans again against `main`. Read its summary (the same two tables), then
approve the **production** deployment. If someone else's change lands between your approval and the apply,
the deploy stops with *The plan changed after approval* and nothing is applied: re-run it and approve the
new plan.

**New blog post:** create `site/src/content/blog/<slug>.md`:

```markdown
---
title: My post title
description: One sentence for the index page and link previews.
date: 2026-11-01
tags: [aws, iam]
draft: false      # true keeps it out of the build
---

Post body in Markdown.
```

**Laptop fallback.** If GitHub Actions is down, `make deploy` runs the same steps with your own AWS
credentials. It needs `infra/backend.hcl` and `infra/main/terraform.tfvars` (copy it from
`terraform.tfvars.example`).

---

---

## 3. Rollback

Use the first option that fits.

1. **Revert the commit (preferred).**

   ```bash
   git revert <bad-sha> && git push       # via a PR if main is protected
   ```

   Approve the deploy. This rolls back the site and the infrastructure together, and leaves an audit trail.
2. **Redeploy an earlier good commit quickly.** In **Actions → deploy**, open the last good run and click
   **Re-run all jobs**. A re-run uses *that run's* commit, so its site build and Terraform config are
   redeployed (the plan you approve shows what that means against today's state). Follow up with a revert
   so `main` matches what's live.
3. **Emergency restore of a single file.** The site bucket is versioned, keeping 30 days of history:

   ```bash
   aws s3api list-object-versions --bucket $B --prefix index.html --max-items 5
   aws s3api copy-object --bucket $B --key index.html \
     --copy-source "$B/index.html?versionId=<good-version-id>"
   aws cloudfront create-invalidation --distribution-id $(terraform -chdir=infra/main output -raw distribution_id) --paths '/index.html'
   ```

**State rollback:** the state bucket is versioned, keeping 90 days and at least 20 versions. You should
almost never need this. If you do, download the older `main/terraform.tfstate` version and run
`terraform state push` with it, with care.

---

## 4. Troubleshooting

| Symptom (error text) | Cause | Fix |
|---|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The token's `sub` doesn't match the trust policy | Check `github_repository` in bootstrap tfvars (exact case, `owner/repo`), that the job uses `environment: production` (apply) or is a PR or on `main` (plan), and [SETUP.md 5.4](SETUP.md#54-match-the-oidc-subject-format). Fix, then rerun `make bootstrap-plan bootstrap-apply`. |
| `Credentials could not be loaded` / `Could not get ID token` | Job lacks `id-token: write`, or the secret is empty | Check the secret names ([SETUP.md 5.2](SETUP.md#52-add-the-secrets)). The secret must be an **environment** secret for apply. |
| `No OpenIDConnect provider found in your account` | `create_github_oidc_provider = false` but the provider doesn't exist | Set it to `true` and re-apply bootstrap. |
| Plan job is **skipped** on a PR | The PR comes from a fork, which gets no secrets | Expected. Push the branch to this repo instead. |
| `aws_acm_certificate_validation.site: Still creating... [20m0s elapsed]` | Nameservers not delegated yet, or DNSSEC still on at Squarespace | Finish [SETUP.md part 4](SETUP.md#part-4--point-the-domain-at-route-53-squarespace) (`dig NS` must show `awsdns`). Cancel, wait, then **Re-run failed jobs**. |
| `CNAMEAlreadyExists` on the distribution | `jasonratcliffe.dev` is an alias on another CloudFront distribution (another account) | Remove it there, or contact AWS Support to move the alias. |
| `AccessDenied ... is not authorized to perform: <service>:<Action>` during apply | The apply role's scoped policy lacks an action that a newer provider version needs | Add the action to `data.aws_iam_policy_document.deploy` in `infra/bootstrap/github-oidc.tf`, run `make bootstrap-plan bootstrap-apply` locally, then **Re-run failed jobs**. Keep the resource scoped to `resume-site-*` where possible. |
| `AccessDenied ... iam:CreateRole` | A role is being created without the permissions boundary | Every `aws_iam_role` in `infra/main` must set `permissions_boundary = data.aws_iam_policy.workload_boundary.arn`, and its name must start with `resume-site-`. |
| `Error acquiring the state lock` | A previous run was cancelled mid-apply | Make sure no run is active, then delete `s3://<state-bucket>/main/terraform.tfstate.tflock`, or run `terraform force-unlock <ID>` locally. |
| `pii-scan: N finding(s)` | Personal data or an account ID in content or code | The output names the file and kind. Remove it. For a false positive (e.g. a 12-digit number that isn't an account ID), reword the content rather than weakening the scanner. |
| `Host system is missing dependencies to run browsers` | Playwright on a fresh runner | The workflow already uses `--with-deps`. Locally run `npx playwright install chromium`. |
| Contact form says *Something went wrong* | SES recipient not verified (sandbox), or the domain's DKIM is pending | [SETUP.md 6.3](SETUP.md#63-confirm-the-emails-from-aws). Look in CloudWatch Logs → `/aws/lambda/resume-site-contact` for `send-failed`. |
| Contact form returns **403** | `Origin` header isn't `https://jasonratcliffe.dev`, or the origin secret changed while CloudFront was still deploying | Use the site at the apex URL. After rotating the secret, wait about 5 minutes. |
| Every page is a 404 after deploy | The upload steps didn't run, or the sync failed | **Re-run failed jobs** on the deploy run. Check `aws s3 ls s3://$B/index.html`. |
| Old content still shows | Browser cache (HTML is cacheable for 5 minutes) | Hard refresh. The deploy already invalidates `/*` at the edge. |
| Smoke test fails on the direct-S3 check (not 403) | Bucket became reachable | **Treat as an incident:** check Block Public Access and the bucket policy, then re-run the deploy so Terraform restores them. |
| `AccessDenied ... logs:PutDeliverySource` (or `events:PutRule`) during apply | Bootstrap was applied before the edge dashboard existed | Run `make bootstrap-plan bootstrap-apply` locally (8.1), then **Re-run failed jobs**. |
| `AccessDenied ... logs:PutResourcePolicy` on `aws_cloudwatch_log_delivery.edge` | The log resource policy from bootstrap is missing or doesn't cover the log group | Check `aws logs describe-resource-policies` lists `resume-site-vended-logs`. If it does and the error persists, add `logs:PutResourcePolicy` to the `EdgeLogDeliveryRead` statement in `infra/bootstrap/github-oidc.tf` (account-wide, so prefer fixing the policy), re-apply bootstrap, re-run. |
| Deploy warns `Edge report Lambda failed` | The report Lambda errored (often: no access logs yet right after the first deploy) | Check CloudWatch Logs → `/aws/lambda/resume-site-edge-report`. The site is unaffected; the daily run retries. |
| `/edge/` says **No data yet** | `data/edge-threats.json` hasn't been written | Invoke the Lambda ([SETUP.md 7.1](SETUP.md#71-check-the-edge-dashboard)). If a deploy wiped it, check the sync still has `--exclude "data/*"`. |
| `/edge/` shows a yellow *daily refresh may have failed* | The report is more than 36 hours old | Check the EventBridge rule `resume-site-edge-report-daily` is enabled and the Lambda's logs for errors. |
| `/edge/` shows a red **ALERT** | A file probe (`.env`, `.git`, a backup…) got HTTP 200 | **Treat as an incident:** find the object (`aws s3 ls s3://$B/<path>`), remove it from `site/public` or the build, deploy, and rotate anything it contained. |
| Deploy stops: *The plan changed after approval* | State or `main` moved between the pre-approval plan and the apply | Nothing was applied. **Re-run all jobs**, read the new plan summary, approve again. |
| Deploy stops: *No approved plan from the checks job* | The plan job was skipped or failed | Look at the **Checks** jobs in the same run, fix, re-run. |
| `AccessDenied ... cloudwatch:PutMetricAlarm` or `sns:CreateTopic` during apply | Bootstrap was applied before alerts existed | Run `make bootstrap-plan bootstrap-apply` locally (5.1), then **Re-run failed jobs**. |
| Plan job fails with `AssumeRoleWithWebIdentity` on `main` only | The plan role doesn't trust `ref:refs/heads/main` yet | Same: apply bootstrap (5.1). |
| Smoke test fails on `cross-origin-embedder-policy` or the `Server` header | The response headers policy didn't apply, or a new asset is cross-origin | Check `infra/main/cdn.tf`; everything the pages load must be same-origin. |

---

## 5. Alerts

CloudWatch alarms email `CONTACT_TO_EMAIL` through the SNS topic `resume-site-alerts` when something breaks and
when it recovers (an *OK* email follows each *ALARM*). They live in `infra/main/alarms.tf`.

| Alarm | Fires when | First thing to check |
|---|---|---|
| `resume-site-site-5xx` | More than 5% of requests got a server error for 15 minutes | `/api/*` (the contact Lambda or API Gateway) or an S3/CloudFront incident; the edge logs in CloudWatch |
| `resume-site-contact-errors` | The contact Lambda raised an error | `/aws/lambda/resume-site-contact`: look for the outcome line and the traceback |
| `resume-site-edge-report-errors` | The edge report Lambda raised an error | `/aws/lambda/resume-site-edge-report`; `/edge/` keeps the previous data |
| `resume-site-dnssec-internal-failure` | Route 53 couldn't sign the zone | **Urgent** (section 6): fix within hours, or validating resolvers stop resolving the domain |
| `resume-site-dnssec-ksk-action-needed` | The KMS key behind the key-signing key is disabled, deleted or its policy changed | **Urgent**: re-enable the key or restore its policy (`infra/bootstrap/dnssec.tf`) |

Missing data counts as OK, so a quiet day never alarms. About $0.60 a month (6 standard alarms; SNS email is free).

### 5.1 Upgrading an existing deployment

The apply role needs CloudWatch alarm and SNS permissions, and the plan role must trust `main`. Apply bootstrap
before merging the change that adds `infra/main/alarms.tf`:

```bash
make bootstrap-plan    # expect: 4 to add (DNSSEC), 2 to change (plan role trust, deploy policy)
make bootstrap-apply
```

After the deploy, confirm the SNS subscription email ([SETUP.md 6.3](SETUP.md#63-confirm-the-emails-from-aws)).
Check with:

```bash
aws sns list-subscriptions --query "Subscriptions[?contains(TopicArn, 'resume-site-alerts')].SubscriptionArn"
# a full ARN = confirmed; "PendingConfirmation" = click the link in the email
```

To test an alarm end to end: `aws cloudwatch set-alarm-state --alarm-name resume-site-edge-report-errors
--state-value ALARM --state-reason test`. You get an email, and the alarm returns to OK on its next evaluation.

---

## 6. DNSSEC

DNSSEC lets resolvers check that DNS answers for `jasonratcliffe.dev` really came from Route 53. Two halves:

1. **Signing** (Route 53 + KMS, `infra/bootstrap/dnssec.tf`). On from the bootstrap apply. Harmless by itself.
2. **Chain of trust** (a DS record at the registrar). Until it exists, resolvers don't check anything. Once it
   exists, a broken signature takes the domain offline for every validating resolver. That's why the alarms in
   section 5 matter, and why this step is last.

### 6.1 Turn it on

1. Apply bootstrap (5.1). Confirm the zone is signing:

   ```bash
   ZONE=$(aws route53 list-hosted-zones-by-name --dns-name jasonratcliffe.dev --query 'HostedZones[0].Id' --output text)
   aws route53 get-dnssec --hosted-zone-id "$ZONE" --query '{status:Status.ServeSignature,ksk:KeySigningKeys[0].Status}'
   # expect: "SIGNING", "ACTIVE"
   dig +dnssec DNSKEY jasonratcliffe.dev @$(dig NS jasonratcliffe.dev +short | head -1) | grep -c RRSIG
   # expect: 1 or more
   ```

2. Wait at least **one hour** (the zone's longest TTL) so resolvers have fresh, signed answers.
3. Print the DS values (public data, not a secret):

   ```bash
   terraform -chdir=infra/bootstrap output dnssec_ds_record
   ```

4. At Squarespace: **Domains → jasonratcliffe.dev → DNS → DNSSEC → Add DS record**. Enter **Key tag**,
   **Algorithm** `13` (ECDSAP256SHA256), **Digest type** `2` (SHA-256) and the **Digest**, exactly as printed.
   Save. *(If Squarespace's labels differ, look for "DS record" in the domain's DNS settings.)*
5. Verify within an hour or two:

   ```bash
   dig DS jasonratcliffe.dev +short @8.8.8.8                 # the record you entered
   dig jasonratcliffe.dev +dnssec @1.1.1.1 | grep -E 'flags:.* ad'   # "ad" = validated
   ```

   Or check visually at <https://dnsviz.net/d/jasonratcliffe.dev/dnssec/>: no red.

❌ **If the site stops resolving after step 4** (`SERVFAIL` from `dig @8.8.8.8`), the DS record doesn't match.
Delete it at Squarespace immediately and recheck the values. Resolvers recover once the bad DS record's TTL
passes (up to a day for `.dev`).

### 6.2 Turn it off (do these in order)

1. Delete the DS record at Squarespace.
2. Wait **at least 2 days** (the parent zone's DS TTL plus caching).
3. Set `dnssec_signing = false` in `infra/bootstrap/terraform.tfvars`, then `make bootstrap-plan bootstrap-apply`.

Never delete the KMS key or the key-signing key while a DS record points at them (`prevent_destroy` guards the key).

### 6.3 Key rotation

The KMS key can't rotate automatically (asymmetric keys don't support it). Route 53 rotates the zone-signing
key itself. Rotating the key-signing key is rarely needed. If you do: add a second `aws_route53_key_signing_key`
with a new KMS key, add its DS record at Squarespace alongside the old one, wait 2 days, remove the old DS
record, wait 2 more days, then remove the old key-signing key. Cost: $1 a month per KMS key.

---

## 7. Hardening and maintenance

- **Rotate the origin secret** that guards the API:
  `terraform -chdir=infra/main apply -replace=random_password.origin_verify` (or add the flag to a CI
  run). Expect about 5 minutes of 403s while CloudFront propagates.
- **Drift detection.** A scheduled workflow on `main` could call `checks.yml` and fail when the plan isn't
  empty. The plan role already trusts `main`, so no bootstrap change is needed.
- **GitHub security features** are on (secret scanning with push protection, Dependabot alerts and security
  updates), and CodeQL runs with the other scans. See section 9.
- **Signed commits.** Add ☑ *Require signed commits* to the `main` ruleset.
- **Cost allocation tag.** Every resource in both stacks gets `application = resume` from the provider
  `default_tags`, and the admin log viewer's cost view (tools/log-viewer) shows only costs carrying it.
  After the first apply with the tag, wait about 24 hours for Billing to see the key, then set
  `activate_cost_tag = true` in `infra/bootstrap/terraform.tfvars` and run `make bootstrap-plan bootstrap-apply`
  (expect 1 to add). This needs the management (payer) account; in an AWS Organizations member account,
  activate the tag in the payer's Billing console instead. Costs before activation aren't tagged unless you
  request a backfill: `aws ce start-cost-allocation-tag-backfill --backfill-from <YYYY-MM>-01T00:00:00Z`.
- **SES production access** isn't needed. The site only sends to your own verified address, which the
  sandbox allows.

---

## 8. Edge telemetry dashboard

`/edge/` shows probes against the site from the last 24 hours, mapped to MITRE ATT&CK, plus a 30-day
trend and 30 days of contact form defenses (honeypot catches, direct-API bypass, cross-site posts,
throttling, rejected input). It refreshes daily.

```text
CloudFront access logs ──▶ CloudWatch Logs /aws/vendedlogs/resume-site-cloudfront (7 days)
   (viewer IP kept 7 days for the admin viewer; no X-Forwarded-For or cookies: record_fields)
Contact Lambda outcome logs ──▶ CloudWatch Logs /aws/lambda/resume-site-contact (30 days, no personal data)
EventBridge rule resume-site-edge-report-daily (00:15 UTC) ──▶ Lambda resume-site-edge-report
   Logs Insights query → categories from infra/main/lambda/edge_report/patterns.json
   + contact-log and /api/* queries → contact defense counts
   ──▶ s3://<site-bucket>/data/edge-threats.json (max-age 300) ──▶ /edge/ fetches it
```

- **Permissions.** The Lambda's role can run `logs:StartQuery` on the CloudFront and contact log groups and
  write exactly one object, `data/edge-threats.json`. The workload boundary caps it at `/aws/vendedlogs/resume-site-*`,
  `/aws/lambda/resume-site-contact` and `data/*`.
- **Privacy.** Viewer IPs (`c-ip`) are logged but kept only 7 days. The edge report never selects them, and the
  admin log viewer shows them only as /24 (IPv4) or /48 (IPv6) prefixes. The report's 30-day trend and the
  contact form's throttling history are carried in the published JSON, so they outlive the logs. The published JSON never contains query strings or paths that
  didn't match a pattern. Matched paths are shortened to 80 characters, emails are redacted, and
  characters like `<` are percent-encoded. The page renders everything as text. Contact stats are counts
  only: the number of real messages sent is never published, and the deploy smoke test's post is logged as
  `smoke-test` and left out.
- **Deploys don't touch the data.** The `--delete` sync excludes `data/*`. Keep that exclude, or every
  deploy erases the dashboard.
- **Cost.** Well under $1 a month at personal-site traffic.

### 8.1 Upgrading an existing deployment

If bootstrap was applied before the dashboard existed, CI's apply role lacks the new permissions. Before
merging the change that adds `infra/main/edge.tf`:

```bash
make bootstrap-plan    # expect: 1 to add, 2 to change, 0 to destroy
make bootstrap-apply
```

Then merge and approve the deploy as usual. It adds 11 resources to the main stack.

**Contact form defenses (added later).** The boundary's `EdgeReportQuery` statement gained the contact
log group. Apply bootstrap first, or the report publishes without the contact section (`contact: null`)
until you do:

```bash
make bootstrap-plan    # expect: 0 to add, 1 to change (the boundary policy), 0 to destroy
make bootstrap-apply
```

The main stack then changes 2 resources in place (the report role policy and the function's environment).

### 8.2 Adding or changing a probe pattern

1. Edit `infra/main/lambda/edge_report/patterns.json`. Categories are checked in order and the first
   match wins, so put more specific categories first. Each needs a MITRE technique `id` (`T####` or
   `T####.###`) and name.
2. Add a case to `ClassifyTests.CASES` in `test_handler.py`, then run `make test`.
3. Merge and approve the deploy. The deploy refreshes the report, so the page reflects the change at once.

### 8.3 Reading the page

- **Leak check, green:** no file-style probe got a 200. This is the normal state.
- **ALERT, red:** a request for something like `.env` or `.git/config` got a 200. Treat it as an
  incident (section 4).
- **Daily refresh may have failed, yellow:** the data is more than 36 hours old (section 4).
- **HTTP 200 under "Vulnerability scanner traffic" or "Exploit attempts"** is expected: scanners also
  request real pages like `/`.
- **Contact form defenses missing:** the report's `contact` block is `null`, usually because bootstrap
  wasn't re-applied (8.1). Check the report Lambda's log for `contact-stats-failed`.
- **Honeypot catches:** bots that filled the hidden field. They were told the message was sent; nothing was.

---

## 9. Security checks in the pipeline

Every push to `main` runs `.github/workflows/scan.yml` in parallel with the checks. A blocking finding fails the
run before it reaches the approval gate, so nothing is deployed. Pull requests run the same scans (plus dependency
review), and `security.yml` repeats them weekly over the full history with a passive scan of production. None of
these jobs can reach AWS: they have read-only repository access and no OIDC token. Configs live in
`.github/security/`.

| Check | Tool | Blocks the deploy | Reported only |
|---|---|---|---|
| SAST | Semgrep (`p/default`, `p/github-actions`, project rules in `.github/security/semgrep-rules.yml`) | ERROR-level findings, including every project rule | Warnings and notes (Security tab) |
| SAST | CodeQL (`security-extended`, `.github/security/codeql.yml`) | — | Everything (Security tab) |
| IaC | Checkov over `infra/` and `.github/` | Any failed check not listed in `.github/security/checkov.yaml` | — |
| Workflows | zizmor (online audits) | Medium and above | Low and informational |
| Secrets | TruffleHog over new commits (weekly: full history) and over the built site | Verified or unknown secrets | Unverified matches are not listed |
| Secrets | GitHub secret scanning + push protection | Pushes containing known secret types are refused | Alerts (Security tab) |
| Dependencies | `npm audit` (site, log viewer); dependency review on PRs | High and critical | Lower severities |
| DAST | OWASP ZAP baseline (passive) against a local preview of the build | Rules marked FAIL in `.github/security/zap-local.tsv` | WARN rules (job summary, report artifact) |
| DAST | ZAP baseline against production, weekly | Rules marked FAIL in `.github/security/zap-prod.tsv` (missing security headers, site isolation, CORS, cookies, server versions) | WARN rules |

The project rules turn the hard rules in `CLAUDE.md` into checks: no `innerHTML`-style sinks or `set:html`,
no `style=""` attributes or inline scripts, the edge report never selects `c-ip`, and `record_fields` never
includes `x-forwarded-for` or `cs(Cookie)`.

ZAP never runs an active (attacking) scan against production: that would trip the API throttling, inflate the
contact-form counts on `/edge/` and could send real mail. The weekly passive scan does show up on `/edge/` like
any visitor.

### 9.1 Handling a finding

- **Fix it.** The job summary and the Security tab (Security → Code scanning) show the file and line.
- **Accept it, with a reason next to it:**
  - Semgrep: a `# nosemgrep: <rule-id> -- <reason>` comment on the line (or the line above).
  - Checkov: prefer an inline `#checkov:skip=<ID>:<reason>` on the resource. Add the ID to
    `.github/security/checkov.yaml` only when it applies repo-wide.
  - ZAP: change the rule's action in `.github/security/zap-*.tsv` (`IGNORE`, `WARN` or `FAIL`) and say why in the third column.
- **A TruffleHog finding** means a credential is in git history. Rotate it first (deleting the commit doesn't
  un-leak it), then remove it. The job prints the detector, file, line and commit, never the secret.

### 9.2 Running the scans locally

```bash
python3 -m venv .venv-sec && .venv-sec/bin/pip install semgrep checkov zizmor   # any recent versions
.venv-sec/bin/semgrep scan --metrics=off --config p/default --config p/github-actions --config .github/security/semgrep-rules.yml --exclude site/dist --exclude .venv-sec
.venv-sec/bin/checkov --config-file .github/security/checkov.yaml
GH_TOKEN=$(gh auth token) .venv-sec/bin/zizmor .github
brew install trufflehog && trufflehog git file://. --results=verified,unknown
```

### 9.3 Keeping the tools current

- **Actions** (CodeQL, dependency review) and the **scanner CLIs** (`.github/security/requirements.txt`,
  hash-pinned) get Dependabot PRs. Every Dependabot group waits 7 days (scanners 14) before proposing a release.
- **By hand:** the TruffleHog version and SHA-256 and the ZAP image digest at the top of `scan.yml` (and the digest
  in `security.yml`). Take versions at least two weeks old; get the checksum from the release's `checksums.txt`
  and the digest with `docker pull` + `docker inspect --format '{{index .RepoDigests 0}}'`.
- To regenerate the scanner lock, run the `uv pip compile` command in `.github/security/requirements.in`.
