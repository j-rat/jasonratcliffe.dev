# jasonratcliffe.dev

Resume site for Jason Ratcliffe: a static Astro site on a private S3 bucket behind CloudFront, with a
serverless contact form. Terraform builds the infrastructure, and GitHub Actions deploys it over OIDC
with no AWS keys stored anywhere.

**Features:** a classic resume page, a redacted PDF built from the same data, a terminal overlay (press
<kbd>&#96;</kbd>), an architecture page, a STRIDE threat model of the career, a Markdown blog, an ASCII
edge-filter animation, and a daily edge-telemetry dashboard (`/edge/`) that maps probes against the site to
MITRE ATT&CK and charts what the contact form's honeypot and API defenses blocked.

```text
site/             Astro site (content lives in site/src/data/resume.ts)
infra/bootstrap/  one-time: state bucket, Route 53 zone + DNSSEC, GitHub OIDC roles, permissions boundary
infra/main/       CloudFront, private S3 origin, ACM, DNS, SES, contact API + Lambda, edge report, alarms
.github/          workflows (checks, security scans, approval-gated deploy), scripts, scanner configs
docs/             SETUP.md (first deploy, step by step) and RUNBOOK.md (day-to-day operations)
spec/             build spec and acceptance tests
```

```bash
make install   # deps + headless Chromium
make dev       # http://localhost:4321
make check     # build + PDF + PII scan, Lambda tests, terraform fmt/validate
```

To set it up, follow **[docs/SETUP.md](docs/SETUP.md)**. After that, **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

> The source resume (`*.docx`, kept in `private/`) contains personal contact details and is git-ignored. The build fails if
> an email address, phone number, street address or AWS account ID appears in the site, the PDF, or any
> committable file.
