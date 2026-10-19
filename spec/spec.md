# Build spec: jasonratcliffe.dev: cloud security resume site

Type: website, app

## Goal

Give hiring managers, recruiters and contacts a fast, secure resume site on jasonratcliffe.dev that shows Jason's depth in cloud security through how it is built as much as through what it says.

## Success looks like

A first-time visitor reaches the full resume, the PDF download and the LinkedIn link within one click from the landing view, and the live site scores A+ on Mozilla Observatory, A on securityheaders.com, and 90+ in every Lighthouse category on mobile.

## Users

Prospective hiring managers, recruiters and networking contacts who know Jason works in security but not his title or depth; they arrive from LinkedIn, email or a shared link, on a laptop or phone, and may not be terminal users.

## Must have

| # | Must have | Accept test |
|---|---|---|
| 1 | Classic resume page with sections Summary, Experience, Certifications, Projects, Skills, Contact, built from the 2025 .docx, with links to LinkedIn, the 3 external AWS posts/talk | Open https://jasonratcliffe.dev: all six sections are present, every role, date, cert and award from the .docx appears, and nav links jump to each section. LinkedIn opens linkedin.com/in/jasonratcliffe; the 3 AWS blog/AWS TV links from the .docx each open the right page. |
| 2 | View and download a redacted PDF resume generated from the same content | Click 'Download resume': a PDF opens/downloads; searching it finds no phone number, no street/ZIP address, and no email address, but does show San Antonio, TX and the LinkedIn URL. |
| 3 | Optional terminal overlay (option b): opened by a visible button or the backtick key, closed with Esc | Press ` or click the terminal button: a terminal opens with focus in the prompt. Type help: a command list prints. whoami, experience, certs, skills, projects, blog, contact, resume, threat-model, arch, clear all produce output; an unknown command prints a hint; Up arrow recalls history; Esc closes it and the page is unchanged. |
| 4 | Architecture page showing how the site is hosted and secured, with generic labels only | Open /architecture: a diagram shows DNS, CDN, certificate, private origin bucket, security headers, contact API, function, mail service, IaC state and CI/CD with a one-line control note on each; the page source contains no 12-digit account ID, no ARN, no real bucket, distribution or function name. |
| 5 | Threat-model view of Jason's career, mapping STRIDE categories to real work from the resume | Open /threat-model: six STRIDE categories each list at least one mitigation drawn from the .docx (e.g. SSH key lifecycle, SCP guardrails, data perimeter, PAM); every claim can be traced to a resume line. |
| 6 | Contact form backed by a serverless API (API Gateway, Lambda, SES) that delivers to Jason's inbox from noreply@jasonratcliffe.dev, with the destination address never in the page, repo or Terraform state outputs | Submit the form with a name, a reply-to and a message: a success message shows and the email arrives in Jason's inbox from noreply@jasonratcliffe.dev. Filling the hidden honeypot field results in no email. Sending 20 requests in a minute triggers throttling (HTTP 429). grep the built site and repo for '@gmail' finds nothing. |
| 7 | On-site blog built from Markdown files in the repo, with an index and per-post pages | Add a .md file under the blog folder and rebuild: it appears on /blog with title and date and opens at its own URL; the site launches with one post on how this site is built. |
| 8 | ASCII cloud-security animation in the hero that respects reduced motion | Load the home page: an ASCII animation plays without blocking scroll or text; with the OS 'reduce motion' setting on, a still frame shows instead. |
| 9 | Terraform for all AWS infrastructure: private S3 origin behind CloudFront with OAC, ACM cert, Route 53 hosted zone, security headers policy, SES domain identity (DKIM/SPF/DMARC), contact API; state in a separate encrypted, versioned S3 state bucket with locking | From a clean checkout, terraform init and plan in the bootstrap module, then in the main module, run without errors; the origin bucket blocks all public access and direct S3 URLs return 403; the state bucket has versioning, encryption and public access block on. |
| 10 | Strong HTTP security posture on the live site | curl -I https://jasonratcliffe.dev shows Strict-Transport-Security, Content-Security-Policy without unsafe-inline scripts, X-Content-Type-Options, Referrer-Policy and Permissions-Policy; http:// redirects to https://; www redirects to the bare domain. |
| 11 | Responsive, accessible layout in a dark, modern cloud-security theme | At 375px wide nothing scrolls sideways and every section is readable; keyboard Tab reaches every link, the terminal button and the form; Lighthouse accessibility is 90+. |
| 12 | Detailed step-by-step guide for deploying with GitHub Actions (docs/DEPLOYMENT.md): one-time bootstrap, DNS cutover, GitHub OIDC roles, secrets/variables, PR plan workflow, main-branch apply and deploy, verification and rollback | Following docs/DEPLOYMENT.md top to bottom from a fresh AWS account and empty GitHub repo, every step names the exact command or click, what you should see, and how to fix the common failure; no step requires long-lived AWS access keys in GitHub. |

## Nice to have

- Light theme toggle
- Self-check widget that shows visitors which response headers the site sends
- Terminal easter eggs (e.g. sudo, nmap, cat /etc/shadow with a joke response)
- Print stylesheet for the resume page

## Out of scope

- Publishing personal contact details (they are a reject_if line)
- Analytics or visitor tracking
- A CMS or admin login for the blog
- A hosted inbox such as Workspace or Fastmail
- A paid web application firewall subscription
- Transferring the domain registration away from Squarespace
- Multiple languages

## Constraints

- Static site hosted from S3 via CloudFront; the only server-side piece is the contact Lambda
- Terraform only for infrastructure, state in its own S3 bucket
- No real resource names, ARNs or AWS account IDs in public site content; account-specific values live in a git-ignored tfvars file
- DNS delegated from Squarespace to Route 53 by pasting four nameservers (one manual step for Jason)
- Running cost target under $2/month at low traffic

## Reject if

- Phone, home address or any email address appears on the site, in the PDF, or in the public repo
- A real AWS account ID, ARN or resource name appears in site content
- A recruiter has to use the terminal to find the resume
- Any resume fact on the site differs from the .docx (title, dates, certs, awards, numbers)
- The origin S3 bucket is publicly readable

## Open risks

- DNS cutover depends on Jason updating nameservers in Squarespace; propagation can take up to 48 hours and will break any existing Squarespace site on the domain
- SES domain verification and DKIM need the Route 53 zone to be live first, so the contact form only works after DNS propagates
- The public repo must never contain the tfvars file with the account ID and destination email; a pre-commit secret/PII scan guards it

## Correct me before I build

| # | I am assuming | Risk |
|---|---|---|
| 1 | Deploys run from GitHub Actions using AWS OIDC: PRs get a read-only plan role, pushes to main get an apply role gated by a 'production' environment; a 'make deploy' fallback exists for the laptop. | low |
| 2 | Site is built with Astro (static output, Markdown blog, no client framework); the terminal and animation are small vanilla TypeScript modules. | med |
| 3 | Content comes from the .docx only; LinkedIn is linked, not scraped, because it requires login. | low |
| 4 | Employer name (USAA), awards and the public AWS blog posts may be shown as written in the resume. | med |
| 5 | Success targets (one-click resume, Observatory A+, securityheaders A, Lighthouse 90+) stand in for the success question you skipped. | med |
| 6 | Look is dark, terminal-adjacent: near-black background, one cyan/teal accent, monospace for code and headings, sans-serif for body text. | low |
| 7 | SES stays in sandbox mode, which works because it only ever sends to Jason's own verified address. | low |
| 8 | Infrastructure goes in us-east-1 (required for the CloudFront certificate; keeps everything in one region). | low |
| 9 | Resume text is lightly tightened for the web (shorter bullets on the page), and the full wording is kept in the PDF. | med |
| 10 | You are the only approver, and there is no hard deadline. | low |

Reply yes to build, or tell me which line to change. Anything under Correct me is a guess, not a fact.
