# Admin log viewer (localhost prototype)

Read-only views of the site's CloudWatch logs behind an MFA sign-in, without opening the AWS console.
Spec: **M15** in `spec/spec.json`. This is phase 0: everything runs on your machine.

```text
browser ──▶ app (backend-for-frontend)  http://localhost:4322
              │  /auth/start ─▶ identity provider  http://localhost:4323   (stand-in for Cognito)
              │                 Authorization Code + PKCE, password + TOTP, RS256 tokens, JWKS
              │◀─ /auth/callback: code exchanged server-side, ID token checked (sig, iss, aud, exp, nonce)
              │   browser gets only an HttpOnly SameSite=Strict session cookie
              └─ /api/query {view, range} ─▶ access token re-validated (sig, iss, aud, exp, typ, scope)
                                          ─▶ named Logs Insights query, your local AWS credentials, read-only
```

## Run it

```bash
make log-viewer-setup     # once: npm ci + creates the admin (prints password and TOTP key)
make log-viewer           # http://localhost:4322  (real logs with your `aws login` session)
make log-viewer-sample    # same UI with sample data, no AWS calls
```

Add the printed TOTP key to an authenticator app. `npm run code` (in this folder) prints the current code
for local testing. `node setup.mjs --reset` starts over with a new user, keys and secrets.

Real data needs credentials that can run `logs:StartQuery`, `logs:GetQueryResults` and `logs:StopQuery`
on the site's log groups (`aws login`, or `AWS_PROFILE=...`). Without them the views show labeled sample data.

## Tables

Every log table sorts by any column (click the header; numbers sort numerically) and can be grouped by any
text column, which collapses rows into one per value with a row count and summed numeric columns. Country
codes show the full name, for example `Germany (DE)`. Edge views carry the source network and country;
**Contact API requests** shows the same for `/api/*`, because the functions themselves never see the viewer.

## Paging and loading

Tables show **50 rows per page**.

- **Event views** (Recent requests, Contact API requests, Lambda errors) fetch one page per query: Logs
  Insights is asked for 51 lines older than the last one shown (the extra line says whether there's a next
  page). Nothing beyond the current page is fetched.
- **Summary views** (top paths, sources, errors, …) have to scan the whole period to count anything, so the
  server keeps the computed rows for 5 minutes per session and hands the browser 50 at a time.
- **Show all for this period** returns every row, up to Logs Insights' 10,000-row ceiling. While paged,
  sorting and grouping apply to the current page; Show all sorts and groups the whole period.
- Anything slower than a quarter second shows the loader: `jasonratcliffe.dev` drawn as a circuit board (letters
  as copper traces, a bus along the bottom, a via down to each letter). Current enters at the left terminal and a
  spark carries it left to right; each powered letter lights up with current flowing around its outline, and the
  right-hand pad lights when the data arrives (no flowing dashes or crackle with reduced motion).
  `LV_SAMPLE_DELAY_MS=3000 make log-viewer-sample` slows sample data down so you can see it.

## Cost overview

**Costs → Cost overview** shows month to date, the month-end forecast, last month and six months of spend,
broken down by architecture component (CloudFront, S3, Route 53, CloudWatch, API Gateway, Lambda, SES, …).
It only counts costs tagged **`application = resume`**: both Terraform stacks set that tag on every
resource through the provider's `default_tags`.

- **Activate the tag first.** Cost Explorer can only filter on an *active* cost allocation tag. About 24 hours
  after the tag first reaches AWS, set `activate_cost_tag = true` in `infra/bootstrap/terraform.tfvars` and
  apply bootstrap (see docs/RUNBOOK.md section 7). Until then the view says the tag isn't active and totals are $0.
- **Not everything is taggable.** Charges with no resource behind them (Cost Explorer API calls, tax, some
  per-request fees) never carry the tag, so they're excluded by design.
- **It costs money to look.** Cost Explorer bills $0.01 per API request. A refresh makes 3 requests, results
  are cached for 6 hours, and **Refresh** re-queries at most every 10 minutes.
- Credentials need `ce:GetCostAndUsage`, `ce:GetCostForecast` and `ce:ListCostAllocationTags`.

## Security model

| Control | How |
|---|---|
| No credentials in the browser | Tokens live in server memory; the browser holds an opaque, HttpOnly, SameSite=Strict cookie. No AWS credentials ever leave the server. |
| MFA | Two steps: password (scrypt) first, and only after it succeeds a TOTP code (RFC 6238) on a new, server-tracked transaction, so the code step can't be reached directly. A TOTP code works once; 3 wrong codes or 5 minutes send you back to the password. 5 failures of either step lock sign-in for 15 minutes. |
| No user enumeration | Every credential failure says only "Authentication failed." The username and password checks both always run, so a wrong username takes as long as a wrong password and returns an identical page. |
| OIDC done properly | PKCE S256, `state`, `nonce`, exact redirect URI, single-use 60-second codes, confidential client with a secret. |
| Every API call re-checked | RS256 only, key from the provider's JWKS by `kid`, then `iss`, `aud`, `exp`, `typ: at+jwt` and the `logs:read` scope (what an API Gateway JWT authorizer does). |
| Viewer IPs as prefixes only | CloudFront logs `c-ip` (kept 7 days). Before any row leaves the server, `ip` becomes `source`: the /24 (IPv4) or /48 (IPv6) network, and rows that collapse into the same prefix are merged. Full addresses never reach the browser. |
| No query injection | The browser sends a view id and a range id. Query text and log groups come from `lib/views.mjs`. |
| CSRF / clickjacking | Origin check on POSTs, SameSite cookies, `frame-ancestors 'none'`, strict CSP, `no-store`. |
| Local only | Both servers bind to 127.0.0.1. `.local/` (keys, hashes, secrets) is git-ignored and mode 0600. |
| Audit | One JSON line per sign-in, failure, lockout, query and denial on stdout. Never passwords, codes or tokens. |

## Tests

```bash
npm test    # JWT forgery/alg tricks, RFC 6238 vectors, then the full sign-in flow and the attacks that must fail
```

## Toward production (later phases)

1. Cognito user pool (MFA required, no self sign-up) replaces `lib/provider.mjs`: change the issuer and client.
2. The BFF routes become a Lambda behind CloudFront `/admin/*`; sessions move to DynamoDB with a TTL;
   cookies get `Secure` and the `__Host-` prefix.
3. `/api/admin/*` gets an API Gateway JWT authorizer; a `resume-site-log-reader` role (under the boundary)
   may only run Logs Insights on the allowlisted groups.
4. Sign-ins and denials feed the `/edge/` defense counters and an alarm.
5. The cost view runs from a role limited to the three Cost Explorer read actions, with the same cache.
