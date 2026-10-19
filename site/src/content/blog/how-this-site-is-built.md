---
title: How this site is built (and why a resume needs a threat model)
description: A static site on a private S3 bucket behind CloudFront, a strict CSP, a serverless contact form, and GitHub Actions deploying with OIDC and no access keys.
date: 2026-10-18
tags: [aws, cloudfront, terraform, github-actions]
---

A resume site is a tiny system, so it's a good place to practice the habits I'd expect on a big one. Every
decision below answers one of two questions: *what's the smallest thing that can be exposed?* and
*what happens when a piece of the pipeline is compromised?*

## The shape

```text
visitor ──TLS 1.2+──> CloudFront ──OAC (SigV4)──> private S3 bucket
                          │
                          └── /api/contact ──> HTTP API (throttled) ──> Lambda ──> SES ──> my inbox
```

There's no web server, no container and no database. The only code that runs server-side is about
130 lines of Python behind the contact form.

## The bucket is not a website

S3 can host a website directly, but the website endpoint is HTTP-only and the bucket has to be public.
Here the bucket has **Block Public Access** on, **ACLs disabled**, and a bucket policy that allows one
principal: `cloudfront.amazonaws.com`, conditioned on the ARN of *this* distribution. CloudFront signs
each origin request with SigV4 through Origin Access Control. A second statement denies any request that
isn't using TLS.

Because the bucket doesn't grant `s3:ListBucket`, a missing object returns 403 instead of 404. That way
nobody can enumerate keys, and CloudFront turns the 403 into a friendly 404 page.

## Headers do most of the work

A CloudFront response headers policy attaches the following to every response:

| Header | Value (abridged) | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | `.dev` is already HSTS-preloaded as a TLD; this is belt and braces |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; …` | No inline script, no third-party anything |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), …` | The site never needs device APIs |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates the browsing context |
| `X-Content-Type-Options` | `nosniff` | No MIME confusion |

Getting to `script-src 'self'` with no `'unsafe-inline'` took some build changes. Astro bundles every
script into an external file, stylesheets are never inlined, and Markdown code highlighting uses Prism's
CSS classes rather than inline `style` attributes. The terminal and the hero animation build their output
with DOM text nodes and never use `innerHTML`, so nothing a visitor types can become markup.

## A contact form that can't leak an inbox

I didn't want my email address on the page, and a static site can't send mail. So the form posts to
`/api/contact` **on the same origin**. CloudFront routes that path to an API Gateway HTTP API, which means
there's no CORS and no extra origin in the CSP.

- **Throttling**: the API stage allows one request per second with a burst of five. Anything beyond that gets a `429`.
- **Origin secret**: CloudFront adds a random header to every API request, and the Lambda rejects requests
  without it. Finding the `execute-api` URL doesn't let anyone bypass the edge.
- **Honeypot**: there's a hidden field that only bots fill in. They get a cheerful `200`, and no email is sent.
- **Header injection**: CR/LF characters are stripped from anything that ends up in a mail header, and the
  reply-to address is validated.
- **Least privilege**: the function's role can call `ses:SendEmail` only on the site's identities, and only
  when the `From` address is `noreply@` this domain. The role also carries a **permissions boundary**, so
  even the pipeline that created it couldn't have given it more.

The mail is DKIM-signed with a 2048-bit key, uses a custom MAIL FROM domain so SPF aligns, and the domain
publishes `DMARC p=quarantine`.

## Terraform, in two stacks

- **bootstrap** runs once from a laptop. It creates the state bucket (versioned, encrypted, TLS-only,
  protected from destroy), the Route 53 zone, the GitHub OIDC provider and two IAM roles.
- **main** contains everything else, and only GitHub Actions applies it.

State uses S3's native lock file, so there's no DynamoDB table. Account IDs, the state bucket name and
the recipient address are never committed. They live in a git-ignored `backend.hcl` locally and in
GitHub secrets in CI.

## No keys in CI

GitHub Actions authenticates to AWS with **OIDC**, so there are no access keys to leak or rotate:

- Pull requests can assume only a **plan** role (`ReadOnlyAccess` plus the state lock), and only when the
  token's `sub` is `repo:<this repo>:pull_request`.
- The **apply** role trusts only `repo:<this repo>:environment:production`. That GitHub environment is
  restricted to `main` and requires my approval.
- The apply role's permissions are scoped to the `resume-site-*` prefix. It can create IAM roles *only*
  with the boundary attached, and an explicit deny stops it from removing boundaries or editing policies.

Plan output contains ARNs, so the workflow never prints it. The job summary lists only resource addresses
and actions.

## A build that refuses to leak me

My source resume contains a phone number and home address. The build renders the PDF from the same
redacted data as the site. Then a scanner checks every built file, the PDF's text, and every file git
would commit for:

- email addresses and phone-shaped numbers
- street addresses and 12-digit account IDs
- the specific values from my real resume, matched by salted hash so the values themselves never live in the repo

If anything turns up, the deploy stops.

## What it costs

At resume-site traffic it's close to nothing. Route 53 is $0.50/month for the zone. CloudFront, Lambda,
API Gateway and SES fit comfortably in the free tiers. There's deliberately no WAF subscription:
throttling, the origin secret and the honeypot cover this threat model.

## Try it

Press <kbd>`</kbd> anywhere on the site and run `arch`, or `threat-model E`. And yes, try `sudo`.
