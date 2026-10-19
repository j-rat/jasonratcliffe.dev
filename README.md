# jasonratcliffe.dev

Resume site for Jason Ratcliffe: a static Astro site on a private S3 bucket behind CloudFront, with a
serverless contact form. Terraform builds the infrastructure, and GitHub Actions deploys it over OIDC
with no AWS keys stored anywhere.

**Features:** a classic resume page, a redacted PDF built from the same data, a terminal overlay (press
<kbd>`</kbd>), an architecture page, a STRIDE threat model of the career, a Markdown blog, and an ASCII
edge-filter animation.

```text
site/             Astro site (content lives in site/src/data/resume.ts)
infra/bootstrap/  one-time: state bucket, Route 53 zone, GitHub OIDC roles, permissions boundary
infra/main/       CloudFront, private S3 origin, ACM, DNS, SES, contact API + Lambda
.github/          ci.yml (PR checks + read-only plan), deploy.yml (approval-gated apply + publish)
docs/             DEPLOYMENT.md: step-by-step GitHub Actions deployment
spec/             build spec and acceptance tests
```

```bash
make install   # deps + headless Chromium
make dev       # http://localhost:4321
make check     # build + PDF + PII scan, Lambda tests, terraform fmt/validate
```

To deploy, follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

> The source resume (`*.docx`) contains personal contact details and is git-ignored. The build fails if
> an email address, phone number, street address or AWS account ID appears in the site, the PDF, or any
> committable file.
