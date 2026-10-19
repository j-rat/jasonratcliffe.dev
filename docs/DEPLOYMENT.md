# Deploying jasonratcliffe.dev with GitHub Actions

This guide takes you from **an empty AWS account and an empty GitHub repo** to a live site that redeploys
every time you merge to `main`. Each step tells you what to run or click, what you should see, and what to do
if it goes wrong.

No step puts long-lived AWS access keys into GitHub. CI authenticates to AWS with short-lived OIDC
credentials.

| Part | What happens | Where | Time |
|---|---|---|---|
| [1](#part-1--prerequisites) | Install tools, sign in to AWS | Laptop | 15 min |
| [2](#part-2--create-the-empty-github-repository) | Create the empty GitHub repo | GitHub | 5 min |
| [3](#part-3--bootstrap-aws-one-time-from-your-laptop) | Bootstrap AWS: state bucket, DNS zone, OIDC roles | Laptop | 10 min |
| [4](#part-4--point-the-domain-at-route-53-squarespace) | Point the domain's nameservers at Route 53 | Squarespace | 5 min + up to 48 h propagation |
| [5](#part-5--configure-github-environment-secrets-guardrails) | GitHub environment, secrets and guardrails | GitHub | 15 min |
| [6](#part-6--first-deployment) | First push, approve, deploy | GitHub | 20–40 min |
| [7](#part-7--verify-the-live-site) | Verify the live site | Laptop | 10 min |
| [8](#part-8--day-to-day-changes) | Day-to-day changes | — | — |
| [9](#part-9--rollback) | Rollback | — | — |
| [10](#part-10--troubleshooting) | Troubleshooting | — | — |
| [11](#part-11--optional-hardening) | Optional hardening | — | — |
| [12](#part-12--tear-down) | Tear down | — | — |

---

## How the pipeline works

```text
 feature branch ──PR──▶ ci.yml
                          ├─ site:            npm ci → astro check → build → PDF → PII scan
                          ├─ lambda:          python unittest
                          ├─ terraform-lint:  fmt -check, validate (both stacks)
                          └─ terraform-plan:  OIDC → gha-resume-site-plan (read-only) → plan summary
                                                    (sub = repo:<owner>/<repo>:pull_request)

 merge to main ─────▶ deploy.yml
                          ├─ build:    tests + build + PII scan → artifact "site-dist"
                          └─ deploy:   ⏸ waits for your approval (environment: production)
                                       OIDC → gha-resume-site-apply → terraform plan + apply
                                       → s3 sync → CloudFront invalidation → live smoke tests
                                       (sub = repo:<owner>/<repo>:environment:production)
```

**Two Terraform stacks:**

- `infra/bootstrap`: the long-lived foundations. These are the state bucket, the Route 53 zone, the
  GitHub OIDC provider, the plan/apply roles and the workload permissions boundary. You apply it **once,
  from your laptop**, with admin credentials. CI can't change it.
- `infra/main`: everything else, applied **only by CI**: the site bucket, CloudFront, the certificate,
  DNS records, SES and the contact API/Lambda.

**What's secret and where it lives:**

| Value | Local (git-ignored) | GitHub |
|---|---|---|
| State bucket name (contains the account ID) | `infra/backend.hcl` | Repository secret `TF_STATE_BUCKET` |
| Plan role ARN | — | Repository secret `AWS_PLAN_ROLE_ARN` |
| Apply role ARN | — | **Environment** secret `AWS_APPLY_ROLE_ARN` (production) |
| Your inbox for the contact form | `infra/main/terraform.tfvars` | Repository secret `CONTACT_TO_EMAIL` |

---

## Part 1 – Prerequisites

### 1.1 Install the tools (macOS)

```bash
brew install awscli terraform node@24 python@3.13 gh jq
```

Check the versions:

```bash
aws --version          # aws-cli/2.x
terraform version      # >= 1.11 (CI uses 1.16.6)
node --version         # v24.x or newer
python3 --version      # 3.13+
gh --version           # optional, for the CLI shortcuts below
```

> If `brew install terraform` says the formula is unavailable, use
> `brew tap hashicorp/tap && brew install hashicorp/tap/terraform`.

### 1.2 Sign in to AWS with an admin identity (bootstrap only)

You need admin rights **once**, to create the IAM roles CI will use. Use whatever you normally use: IAM
Identity Center (SSO), `aws login`, or a temporary admin profile.

```bash
aws login                      # or: aws sso login --profile <admin-profile>
export AWS_PROFILE=<admin-profile>   # skip if you use the default profile
aws sts get-caller-identity
```

✅ **Expected:** JSON with your `Account` and an `Arn` for your admin user or role.

❌ **If you see** `Unable to locate credentials` or `ExpiredToken`, sign in again. If you have no admin
identity, create one in IAM Identity Center first. Don't create IAM user access keys for this.

> 💡 **Recommended:** use a dedicated AWS account for this site, for example a new member account in AWS
> Organizations. The plan role gets `ReadOnlyAccess`, which is harmless in an account that holds only
> this site.

### 1.3 Install the site dependencies and confirm the local build

From the repository root:

```bash
make install    # npm ci + headless Chromium for the PDF
make check      # build + PDF + PII scan, Lambda tests, terraform fmt/validate
```

✅ **Expected**, at the end:

```text
pii-scan: clean (dist + repo)
...
Ran 12 tests ... OK
Success! The configuration is valid.   (twice)
```

❌ **If `pii-scan` reports findings**, it prints each file and the kind of finding (e.g. `known personal
phone`). Remove that content and run `make check` again. Never commit until it's clean.

---

## Part 2 – Create the empty GitHub repository

1. Go to <https://github.com/new>.
2. **Repository name:** e.g. `jasonratcliffe.dev`.
3. **Visibility:** **Private** is recommended. Public works too: the workflows never print account IDs,
   ARNs or resource names, and the PII scan blocks personal data. But a private repo also keeps your Actions
   logs and plan summaries private.
4. **Leave all of "Initialize this repository with…" unchecked** (no README, no .gitignore, no license).
5. Click **Create repository**, then note your `owner/repo` string (e.g. `j-rat/jasonratcliffe.dev`).

Don't push yet. Pushing to `main` triggers a deploy, and that needs the AWS roles and GitHub secrets
from parts 3–5.

---

## Part 3 – Bootstrap AWS (one time, from your laptop)

### 3.1 Tell bootstrap which repo may deploy

```bash
cp infra/bootstrap/terraform.tfvars.example infra/bootstrap/terraform.tfvars
```

Edit `infra/bootstrap/terraform.tfvars`:

```hcl
github_repository = "j-rat/jasonratcliffe.dev"   # your owner/repo, exact case
```

> If this AWS account **already has** a GitHub OIDC provider (`token.actions.githubusercontent.com`) from
> another project, also set `create_github_oidc_provider = false`. Check with:
> `aws iam list-open-id-connect-providers`.

### 3.2 Plan and apply

```bash
make bootstrap-init
make bootstrap-plan
```

✅ **Expected:** `Plan: 18 to add, 0 to change, 0 to destroy.` (17 if you reuse an existing OIDC provider.)
Read the plan: it creates an S3 bucket `resume-site-tfstate-<account-id>`, a Route 53 zone, two IAM roles
`gha-resume-site-plan` and `gha-resume-site-apply`, and three IAM policies.

```bash
make bootstrap-apply
```

✅ **Expected:** `Apply complete!` followed by outputs:

```text
apply_role_arn        = "arn:aws:iam::<account-id>:role/gha-resume-site-apply"
plan_role_arn         = "arn:aws:iam::<account-id>:role/gha-resume-site-plan"
route53_nameservers   = ["ns-<N>.awsdns-<NN>.com", "ns-<N>.awsdns-<NN>.net", "ns-<N>.awsdns-<NN>.org", "ns-<N>.awsdns-<NN>.co.uk"]
state_bucket          = "resume-site-tfstate-<account-id>"
workload_boundary_arn = "arn:aws:iam::<account-id>:policy/boundary-resume-site-workload"
```

**Keep this terminal open.** You'll copy these values in parts 4 and 5. You can print them again any
time with `terraform -chdir=infra/bootstrap output`.

❌ **`EntityAlreadyExists: Provider with url https://token.actions.githubusercontent.com already exists`**:
set `create_github_oidc_provider = false` in `terraform.tfvars`, then run `make bootstrap-plan bootstrap-apply`
again.

❌ **`BucketAlreadyExists`**: very unlikely, since the name includes your account ID. Change `project` in
`terraform.tfvars` and in `infra/main/variables.tf`; the two must match.

### 3.3 Create `infra/backend.hcl`

```bash
cp infra/backend.hcl.example infra/backend.hcl
```

Edit `infra/backend.hcl` and replace the bucket with the `state_bucket` output:

```hcl
bucket       = "resume-site-tfstate-<account-id>"
region       = "us-east-1"
encrypt      = true
use_lockfile = true
```

The file is git-ignored. Check with `git check-ignore infra/backend.hcl`, which should print the path.

### 3.4 Move the bootstrap state into S3

Right now the bootstrap state is a local file, `infra/bootstrap/terraform.tfstate`. Move it into the
bucket so it's versioned and isn't lost if your laptop is.

1. In `infra/bootstrap/versions.tf`, **uncomment** the backend block:

   ```hcl
   backend "s3" {
     key = "bootstrap/terraform.tfstate"
   }
   ```

2. Migrate:

   ```bash
   make bootstrap-migrate
   ```

   Terraform asks *"Do you want to copy existing state to the new backend?"*. Type **`yes`**.

3. Confirm, then remove the local copies:

   ```bash
   aws s3 ls s3://$(terraform -chdir=infra/bootstrap output -raw state_bucket)/bootstrap/
   #   → terraform.tfstate
   rm -f infra/bootstrap/terraform.tfstate infra/bootstrap/terraform.tfstate.backup
   ```

4. Commit the uncommented backend block later, together with everything else in part 6.

> CI's roles can read and write **only** `main/*` in the state bucket, so the pipeline can't touch
> bootstrap state.

---

## Part 4 – Point the domain at Route 53 (Squarespace)

The domain stays **registered** at Squarespace. You're only changing which nameservers answer for it.

> ⚠️ **Read before switching:** changing nameservers replaces **all** DNS records that Squarespace
> currently serves for `jasonratcliffe.dev`. If the domain points at a Squarespace website or email
> forwarding today, those stop working when propagation completes. Nothing else is affected.

### 4.1 Turn off DNSSEC at Squarespace (if it's on)

If DNSSEC is enabled at the registrar and you switch nameservers, resolvers reject the new answers and
the domain goes **dark**.

1. Sign in at <https://account.squarespace.com/domains> → click **jasonratcliffe.dev**.
2. Open **DNS** → **DNSSEC** (in some layouts this is under **Advanced settings**).
3. If it's **on**, turn it **off**, then wait about 1 hour before continuing. Leave it off for now; part 11
   shows how to enable DNSSEC on Route 53 later.

### 4.2 Switch to custom nameservers

1. Still on the domain's page, open **DNS** → **Domain nameservers**.
2. Choose **Use custom nameservers**.
3. Enter **your** four values, one per field, **without a trailing dot**. Print them with:

   ```bash
   terraform -chdir=infra/bootstrap output -json route53_nameservers
   ```

   They look like `ns-<N>.awsdns-<NN>.com` (plus `.net`, `.org` and `.co.uk`) and are different for every
   zone. Never copy nameservers from an example. Delegating to nameservers that don't host your zone
   leaves the domain unresolvable. It can also let someone else claim it by creating a zone that lands
   on those servers.

4. Click **Save**. Squarespace may show a warning that its DNS records will no longer apply. Confirm.

*(The Squarespace UI changes from time to time. If the labels differ, look for "nameservers" in the
domain's DNS settings.)*

### 4.3 Wait for delegation

```bash
dig NS jasonratcliffe.dev +short @8.8.8.8
dig NS jasonratcliffe.dev +short @1.1.1.1
```

✅ **Done when** both commands return the four `awsdns` names. This usually takes 15 minutes to 2 hours,
and can take up to 48 hours.

You can do part 5 while you wait, but **don't start part 6 until delegation is done**. The certificate
in the main stack is validated through DNS, and the apply waits on it.

---

## Part 5 – Configure GitHub: environment, secrets, guardrails

Everything below is under your repo's **Settings** tab. Each section also gives a `gh` CLI equivalent
(run `gh auth login` first).

### 5.1 Create the `production` environment (the deploy gate)

1. **Settings → Environments → New environment** → name it exactly **`production`** → **Configure environment**.
2. **Deployment protection rules:**
   - ☑ **Required reviewers** → add **yourself**. Every deploy then waits for you to click **Approve**.
   - Leave **Prevent self-review** *unchecked*, because you're the only reviewer.
   - Optionally set a **wait timer** of 0.
3. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule**
   → `main`. Now only `main` can use this environment, and so only `main` can assume the apply role.
4. Click **Save protection rules**.

> **GitHub Free:** required reviewers work only on **public** repos. On a private repo the save fails with
> `HTTP 422 … billing plan supports the required reviewers protection rule`. Either make the repo public
> (`gh repo edit <owner>/<repo> --visibility public --accept-visibility-change-consequences`) or upgrade to
> GitHub Pro. Nothing personal is committable (part 6.1 checks that), so public is fine for this repo.

This is where the AWS trust policy and GitHub meet. The apply role trusts only
`repo:<owner>/<repo>:environment:production`, and GitHub issues that token only to jobs that pass the
rules above.

### 5.2 Add the secrets

**Repository secrets** (Settings → Secrets and variables → **Actions** → **Secrets** tab → **New repository secret**):

| Name | Value |
|---|---|
| `AWS_PLAN_ROLE_ARN` | `plan_role_arn` output |
| `TF_STATE_BUCKET` | `state_bucket` output |
| `CONTACT_TO_EMAIL` | The inbox that should receive contact-form messages (e.g. your Gmail) |

**Environment secret** (Settings → Environments → **production** → **Environment secrets** → **Add environment secret**):

| Name | Value |
|---|---|
| `AWS_APPLY_ROLE_ARN` | `apply_role_arn` output |

Putting the apply role only on the environment means a workflow that doesn't pass the production
approval gate never even sees its ARN.

**CLI equivalent** (run from the repo root after `git remote add`; see 6.1):

```bash
gh secret set AWS_PLAN_ROLE_ARN --body "$(terraform -chdir=infra/bootstrap output -raw plan_role_arn)"
gh secret set TF_STATE_BUCKET   --body "$(terraform -chdir=infra/bootstrap output -raw state_bucket)"
gh secret set CONTACT_TO_EMAIL  # paste the address when prompted (keeps it out of shell history)
gh secret set AWS_APPLY_ROLE_ARN --env production --body "$(terraform -chdir=infra/bootstrap output -raw apply_role_arn)"
gh secret list && gh secret list --env production
```

✅ **Expected:** three repository secrets and one environment secret.

### 5.3 Lock down Actions

**Settings → Actions → General:**

1. **Actions permissions** → **Allow \<owner\>, and select non-\<owner\>, actions and reusable workflows**:
   - ☑ Allow actions created by GitHub
   - **Allow specified actions and reusable workflows:**

     ```text
     hashicorp/setup-terraform@*, aws-actions/configure-aws-credentials@*
     ```

   - ☑ **Require actions to be pinned to a full-length commit SHA** (if your plan offers it). The workflows
     already pin every action to a SHA.
2. **Fork pull request workflows** → **Require approval for all outside collaborators** (public repos).
3. **Workflow permissions** → **Read repository contents and packages permissions**, and leave
   ☐ *Allow GitHub Actions to create and approve pull requests* unchecked. Each job asks for exactly what it needs
   (`id-token: write` only where AWS is used).

### 5.4 Match the OIDC subject format

The trust policies must match the `sub` claim GitHub puts in each job's token. Check which format your
repo uses:

```bash
gh api repos/<owner>/<repo>/actions/oidc/customization/sub
```

- **`{"use_default":true}`** (or a 404): the classic format, `repo:<owner>/<repo>:...`. Nothing to do.
- **`"use_immutable_subject":true`**: GitHub sends `repo:<owner>@<owner-id>/<repo>@<repo-id>:...`. This is
  the stronger format: a renamed or recreated repo with the same name can't assume your roles. Add the
  IDs from `sub_claim_prefix` to `infra/bootstrap/terraform.tfvars`, then re-run bootstrap:

  ```hcl
  github_ids = { owner = 12345678, repository = 123456789 }
  ```

  ```bash
  make bootstrap-plan    # expect: 0 to add, 2 to change (the two role trust policies)
  make bootstrap-apply
  ```

❌ **`Not authorized to perform sts:AssumeRoleWithWebIdentity`** in the *configure-aws-credentials* step
means the format and the trust policy disagree. Run the check above.

### 5.5 Protect `main` (after the first push)

Status checks only appear after they've run once, so finish this after part 6.

**Settings → Rules → Rulesets → New ruleset → New branch ruleset:**

- **Name:** `main`. **Enforcement:** Active. **Target branches:** *Include default branch*.
- ☑ **Restrict deletions**, ☑ **Block force pushes**
- ☑ **Require a pull request before merging** (required approvals: 0 if you work alone)
- ☑ **Require status checks to pass** → add `Site build + PII scan`, `Contact Lambda tests`,
  `Terraform fmt + validate`, `Terraform plan (read-only role)`
- **Create**.

---

## Part 6 – First deployment

### 6.1 Commit and push

From the repository root:

```bash
git status                       # review what will be committed
git ls-files --others --exclude-standard | grep -Ei 'docx|tfvars|backend.hcl|tfstate' \
  && echo "STOP: sensitive file would be committed" || echo "ok: nothing sensitive staged"
```

✅ **Expected:** `ok: nothing sensitive staged`. The `.docx` resume, `*.tfvars`, `backend.hcl` and state
files are all git-ignored.

```bash
git add -A
git commit -m "Resume site: Astro + Terraform + GitHub Actions"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git     # or the https URL
git push -u origin main
```

### 6.2 Watch the run and approve

1. Open the repo's **Actions** tab → the **deploy** run for your commit.
2. **build** runs first (about 2–3 minutes): Lambda tests, site build, PDF, PII scan.
3. **Terraform apply + publish** then shows **Waiting** with the banner *"Review pending deployments"*.
   - Click **Review deployments** → ☑ **production** → **Approve and deploy**.
4. The job runs `terraform plan` and `apply`. On the first run this creates **42 resources** and takes
   **10–25 minutes**, mostly waiting on the certificate and the CloudFront distribution. Open the run's
   **Summary** to see the list of resources it created. Full plan output is intentionally never printed,
   because it contains ARNs.
5. The same job then uploads the site, invalidates the cache, and runs the live smoke tests. When it turns
   green, the summary shows **Live checks passed for https://jasonratcliffe.dev**.

> **Tip:** on later deploys, check the merged PR's **Terraform plan** summary before you approve. It lists
> every resource that will change. For content-only changes it says `No changes`.

### 6.3 Confirm two emails from AWS

During the first apply, SES sends a **verification email** to `CONTACT_TO_EMAIL`, with a subject like
*"Amazon Web Services – Email Address Verification Request"*.

1. Open it and click the link **within 24 hours**.
2. Until you do, the contact form returns *"Something went wrong"* (the Lambda logs `send-failed`).

The domain identity (`jasonratcliffe.dev`) verifies itself through the DKIM DNS records, usually within
minutes. Check with:

```bash
aws sesv2 get-email-identity --email-identity jasonratcliffe.dev \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'
```

✅ **Expected:** `"verified": true, "dkim": "SUCCESS"`.

### 6.4 If the first run fails

The first apply is the most likely to hit a timing issue. Go to [Part 10](#part-10--troubleshooting) and
find the error text. Once it's fixed, click **Re-run failed jobs** on the run. Terraform picks up where it
stopped, because state is saved after every resource.

---

## Part 7 – Verify the live site

Run these from your laptop. They mirror the spec's acceptance tests.

```bash
SITE=https://jasonratcliffe.dev

# Security headers
curl -sI $SITE | grep -Ei 'strict-transport|content-security|x-content-type|referrer-policy|permissions-policy|x-frame'

# Redirects: http → https, www → apex
curl -sI http://jasonratcliffe.dev        | grep -Ei '^(HTTP|location)'
curl -sI https://www.jasonratcliffe.dev/  | grep -Ei '^(HTTP|location)'

# The PDF and a 404
curl -s -o /dev/null -w 'pdf %{http_code}\n' $SITE/resume.pdf
curl -s -o /dev/null -w '404 %{http_code}\n' $SITE/nope

# The bucket is NOT reachable directly (needs your admin creds to look up the name)
terraform -chdir=infra/main init -backend-config=../backend.hcl >/dev/null
B=$(terraform -chdir=infra/main output -raw site_bucket)
curl -s -o /dev/null -w 'direct-s3 %{http_code}\n' https://$B.s3.amazonaws.com/index.html   # expect 403

# Throttling: 20 fast requests → 400s (bad body) then 429s
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' \
       -H "Origin: $SITE" -d '{}' $SITE/api/contact
done; echo
```

✅ **Expected:**

- All six headers are present.
- `301` with `location: https://jasonratcliffe.dev/` for both redirects.
- `pdf 200`, `404 404`, `direct-s3 403`.
- The loop prints a few `400`s, then `429`s.

Then, in a browser:

1. **Send yourself a message** through the form. It should arrive within a minute from the
   site's `noreply` address, and **Reply** should address the sender, not noreply.
2. Score the site:
   - <https://developer.mozilla.org/en-US/observatory/analyze?host=jasonratcliffe.dev>: target **A+**
   - <https://securityheaders.com/?q=jasonratcliffe.dev&followRedirects=on>: target **A** or better
   - <https://www.ssllabs.com/ssltest/analyze.html?d=jasonratcliffe.dev>: target **A**
   - Chrome DevTools → **Lighthouse** → Mobile → all categories **90+**
3. Check the email side at <https://www.mail-tester.com>. Optionally temporarily set its address as
   `CONTACT_TO_EMAIL` and send a form message; it should show SPF, DKIM and DMARC passing.

---

## Part 8 – Day-to-day changes

```bash
git switch -c update-resume
# edit site/src/data/resume.ts      (all resume content: site, terminal and PDF)
# or add site/src/content/blog/my-post.md
make dev                            # preview at http://localhost:4321
make check                          # same gates as CI
git commit -am "Update experience" && git push -u origin update-resume
gh pr create --fill                 # or open the PR in the browser
```

On the PR, **ci** runs all four checks. Open **Terraform plan (read-only role)** → **Summary** to see
exactly which AWS resources would change. For content-only changes it says `No changes`.

Merge the PR, then approve the **production** deployment in the Actions tab.

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

## Part 9 – Rollback

Use the first option that fits.

1. **Revert the commit (preferred).**

   ```bash
   git revert <bad-sha> && git push       # via a PR if main is protected
   ```

   Approve the deploy. This rolls back the site and the infrastructure together, and leaves an audit trail.
2. **Redeploy an earlier good commit quickly.** In **Actions → deploy**, open the last good run and click
   **Re-run all jobs**. A re-run uses *that run's* commit, so its site build and Terraform config are
   redeployed. Follow up with a revert so `main` matches what's live.
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

## Part 10 – Troubleshooting

| Symptom (error text) | Cause | Fix |
|---|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The token's `sub` doesn't match the trust policy | Check `github_repository` in bootstrap tfvars (exact case, `owner/repo`), that the job uses `environment: production` (apply) or is a PR (plan), and part 5.4. Fix, then rerun `make bootstrap-plan bootstrap-apply`. |
| `Credentials could not be loaded` / `Could not get ID token` | Job lacks `id-token: write`, or the secret is empty | Check the secret names in 5.2. The secret must be an **environment** secret for apply. |
| `No OpenIDConnect provider found in your account` | `create_github_oidc_provider = false` but the provider doesn't exist | Set it to `true` and re-apply bootstrap. |
| Plan job is **skipped** on a PR | The PR comes from a fork, which gets no secrets | Expected. Push the branch to this repo instead. |
| `aws_acm_certificate_validation.site: Still creating... [20m0s elapsed]` | Nameservers not delegated yet, or DNSSEC still on at Squarespace | Finish part 4 (`dig NS` must show `awsdns`). Cancel, wait, then **Re-run failed jobs**. |
| `CNAMEAlreadyExists` on the distribution | `jasonratcliffe.dev` is an alias on another CloudFront distribution (another account) | Remove it there, or contact AWS Support to move the alias. |
| `AccessDenied ... is not authorized to perform: <service>:<Action>` during apply | The apply role's scoped policy lacks an action that a newer provider version needs | Add the action to `data.aws_iam_policy_document.deploy` in `infra/bootstrap/github-oidc.tf`, run `make bootstrap-plan bootstrap-apply` locally, then **Re-run failed jobs**. Keep the resource scoped to `resume-site-*` where possible. |
| `AccessDenied ... iam:CreateRole` | A role is being created without the permissions boundary | Every `aws_iam_role` in `infra/main` must set `permissions_boundary = data.aws_iam_policy.workload_boundary.arn`, and its name must start with `resume-site-`. |
| `Error acquiring the state lock` | A previous run was cancelled mid-apply | Make sure no run is active, then delete `s3://<state-bucket>/main/terraform.tfstate.tflock`, or run `terraform force-unlock <ID>` locally. |
| `pii-scan: N finding(s)` | Personal data or an account ID in content or code | The output names the file and kind. Remove it. For a false positive (e.g. a 12-digit number that isn't an account ID), reword the content rather than weakening the scanner. |
| `Host system is missing dependencies to run browsers` | Playwright on a fresh runner | The workflow already uses `--with-deps`. Locally run `npx playwright install chromium`. |
| Contact form says *Something went wrong* | SES recipient not verified (sandbox), or the domain's DKIM is pending | Part 6.3. Look in CloudWatch Logs → `/aws/lambda/resume-site-contact` for `send-failed`. |
| Contact form returns **403** | `Origin` header isn't `https://jasonratcliffe.dev`, or the origin secret changed while CloudFront was still deploying | Use the site at the apex URL. After rotating the secret, wait about 5 minutes. |
| Every page is a 404 after deploy | The upload steps didn't run, or the sync failed | **Re-run failed jobs** on the deploy run. Check `aws s3 ls s3://$B/index.html`. |
| Old content still shows | Browser cache (HTML is cacheable for 5 minutes) | Hard refresh. The deploy already invalidates `/*` at the edge. |
| Smoke test fails on the direct-S3 check (not 403) | Bucket became reachable | **Treat as an incident:** check Block Public Access and the bucket policy, then re-run the deploy so Terraform restores them. |

---

## Part 11 – Optional hardening

- **DNSSEC on Route 53.** Create a KMS key in us-east-1 (ECC_NIST_P256, sign/verify) and add
  `aws_route53_key_signing_key` + `aws_route53_hosted_zone_dnssec` to bootstrap. Then add the DS record
  that Route 53 shows in Squarespace's **DNSSEC** settings. Don't do this until the site has been stable
  for a few days.
- **Rotate the origin secret** that guards the API:
  `terraform -chdir=infra/main apply -replace=random_password.origin_verify` (or add the flag to a CI
  run). Expect about 5 minutes of 403s while CloudFront propagates.
- **Drift detection.** Add a scheduled workflow (`on: schedule`) that runs the read-only plan and fails
  if it's not `No changes`. It needs a third trust condition, e.g.
  `repo:<owner>/<repo>:ref:refs/heads/main`, on the plan role.
- **GitHub security features.** Settings → Code security: enable **Secret scanning** with **push
  protection**, **Dependabot alerts** (`.github/dependabot.yml` is already set up for actions, npm and
  Terraform), and **CodeQL**.
- **Signed commits.** Add ☑ *Require signed commits* to the `main` ruleset.
- **SES production access** isn't needed. The site only sends to your own verified address, which the
  sandbox allows.

---

## Part 12 – Tear down

1. Remove the main stack. Use your admin credentials, since CI can't destroy bootstrap and you'll want a
   clean exit:

   ```bash
   terraform -chdir=infra/main init -backend-config=../backend.hcl
   terraform -chdir=infra/main destroy
   ```

2. Switch Squarespace back to **Use Squarespace nameservers**.
3. Bootstrap resources have `prevent_destroy` on the state bucket and zone. Remove those `lifecycle`
   blocks first, empty the state bucket (including all versions), then run
   `terraform -chdir=infra/bootstrap destroy`.
4. In GitHub, delete the environment and the secrets.
