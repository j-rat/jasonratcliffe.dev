---
title: "OIDC and JWTs, explained by building one"
description: How OpenID Connect signs people in, how a JWT carries that proof to an API, what claims are and how to validate them, why OIDC replaced SAML for most new work, and a lab where you mint and decode your own tokens.
date: 2026-11-24
tags: [iam, oidc, jwt, oauth, security]
---

Most of identity and access management comes down to two questions, asked over and over by every
system you run:

1. **Authentication:** *who is this?*
2. **Authorization:** *what are they allowed to do?*

OpenID Connect (OIDC) answers the first question for you. OAuth 2.0 carries the answer to the second.
JSON Web Tokens (JWTs) are how both answers travel between systems that don't trust each other by
default. Once you can read a JWT and know what to check in it, a lot of modern IAM stops being magic.

Further down there's a [lab](#try-it-mint-and-decode-your-own-jwt) where you can mint a signed token in
your browser, decode it, and break its signature.

## The short version

- **OAuth 2.0** is a delegation protocol. An app asks for permission to call an API on a user's
  behalf and gets an **access token**. OAuth on its own never says who the user is.
- **OIDC** is a thin identity layer on top of OAuth 2.0. Add the `openid` scope and the identity
  provider also returns an **ID token**: a signed statement of who signed in, when, and how.
- A **JWT** is the format both tokens usually take: a small JSON document, signed so that anyone with
  the issuer's public key can check that nobody changed it.

## Anatomy of a JWT

A JWT is three Base64URL-encoded parts joined by dots: `header.payload.signature`. Here's a real one,
signed with a throwaway key:

<figure class="jwt-anatomy">
  <p class="ja-token mono"><span class="head">eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjNmOWMifQ</span>.<span class="pay">eyJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwic3ViIjoiMDB1OGYyazFxOVp4UDQiLCJhdWQiOiJvcmRlcnMtd2ViLWNsaWVudCIsImlhdCI6MTc5NTQzNTIwMCwiZXhwIjoxNzk1NDM2MTAwLCJub25jZSI6Im4tMFM2X1d6QTJNaiIsIm5hbWUiOiJBZGEgTG92ZWxhY2UifQ</span>.<span class="sig">HMAdLRUuDSPOJFjtuLkwhSwxctAnAyYVngJHu1rxZcXyNJ8F3Yi3JpTE0pID-g6rxsnaT3DtwwDHuDDR9q4iPSVAzJWQiCZJVlFFtrNN_j5vMIBSMKWNDb6GlqhDFjwzqie-27Ka7GV1-GY-hf714FPlGOmR1gqk2FrmHFo5JNW5XVwCPxhrCVE6cML7YGVviY1iiflX827hRxwEvHXhSSu23Y5yQIgd1aWBXuoWgafAvsj0WyIUisSDggKXimEwawHZXmU-VACGIG7F0o9hvz9QisxjV4kIcbpxo4I6-o78TOlyQn3r6sNP47Ntvgo_Os5OyGiKTq7m0nkZwFXekw</span></p>
  <div class="ja-parts">
    <div class="ja-part head">
      <p class="ja-name">Header</p>
      <p class="ja-what">How the token was signed (<code>alg</code>) and which key signed it (<code>kid</code>).</p>
      <pre class="ja-json">{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "3f9c"
}</pre>
    </div>
    <div class="ja-part pay">
      <p class="ja-name">Payload</p>
      <p class="ja-what">The <strong>claims</strong>: statements the issuer makes about the subject.</p>
      <pre class="ja-json">{
  "iss": "https://login.example.com",
  "sub": "00u8f2k1q9ZxP4",
  "aud": "orders-web-client",
  "iat": 1795435200,
  "exp": 1795436100,
  "nonce": "n-0S6_WzA2Mj",
  "name": "Ada Lovelace"
}</pre>
    </div>
    <div class="ja-part sig">
      <p class="ja-name">Signature</p>
      <p class="ja-what">Covers the first two parts. Change one character of either and it no longer verifies.</p>
      <pre class="ja-json">RSASSA-PKCS1-v1_5-SHA256(
  base64url(header) + "." +
  base64url(payload),
  provider's private key
)</pre>
    </div>
  </div>
</figure>

> **Signed is not encrypted.** Base64URL is an encoding, not a cipher. Anyone holding a JWT can read
> every claim, so never put secrets in one. (Encrypted JWTs, JWE, exist but are rare in practice.)

## Claims: what a token says

A claim is a name/value pair the issuer vouches for. There are three kinds.

**Registered claims** come from the JWT spec (RFC 7519) and mean the same thing everywhere:

| Claim | Meaning | What a verifier does with it |
|---|---|---|
| `iss` | Issuer: who created and signed the token | Must exactly match the provider you trust |
| `sub` | Subject: a stable, opaque ID for the user or workload | Use it as the user key, not the email |
| `aud` | Audience: who the token is meant for | Must contain *your* client ID or API identifier |
| `exp` | Expiry time (Unix seconds) | Reject if it has passed (allow a minute of clock skew) |
| `nbf` / `iat` | Not before / issued at | Reject tokens from the future |
| `jti` | Unique token ID | Lets you detect replays or revoke one token |

**OIDC claims** describe the sign-in itself and the person: `nonce` (ties the ID token to the login
request that asked for it), `auth_time` (when the user actually authenticated), `acr` and `amr` (how
strongly, for example with MFA), `azp` (the client the token was issued to), plus profile claims like
`name`, `email` and `email_verified`, released only when the app requests the matching scope.

**Custom claims** are whatever your provider adds: `roles`, `groups`, `tenant`, `department`. This is
where authorization data lives, and it's why claims design matters. A role claim is only as trustworthy
as the process that assigns it.

## ID token, access token, refresh token

These get mixed up constantly, and the mix-up causes real bugs.

| | ID token | Access token | Refresh token |
|---|---|---|---|
| Comes from | OIDC | OAuth 2.0 | OAuth 2.0 |
| Answers | Who signed in? | What may the caller do? | Can I get a new access token? |
| Audience (`aud`) | The client app | The API (resource server) | The authorization server only |
| Read by | The app that asked for the sign-in | The API | Never read; sent back to the token endpoint |
| Format | Always a JWT | Often a JWT, sometimes opaque | Usually opaque |
| Lifetime | Minutes | Minutes to an hour | Hours to days, rotated on use |

The rule that prevents most mistakes: **send access tokens to APIs, never ID tokens.** An ID token's
audience is the app, so an API that accepts one is trusting a token that was never issued to it.

## The flow: Authorization Code with PKCE

This is the flow to use for web apps, single-page apps and mobile apps. The browser only ever carries a
short-lived, one-time **code**. The tokens come back over a direct server-to-server call.

Press **Play** to watch a sign-in from the first click to the API's answer, or step through it. **Show
full flow** draws every step at once. Switch the scenario to see an expired token get a `401` and a
missing scope get a `403`.

<div class="card auth-flow" data-auth-flow>
  <p class="jl-noscript">The animated flow needs JavaScript.</p>
</div>

- **Steps 3–8 are authentication.** The app learns who the user is from the ID token.
- **Steps 9–12 are authorization.** The API decides from the access token's claims (`scope`, `roles`)
  whether *this* call is allowed.
- `state` stops cross-site request forgery on the redirect. `nonce` stops an old ID token being replayed.
  **PKCE** (`code_challenge` / `code_verifier`) means a stolen authorization code is useless to anyone
  who didn't start the flow.
- The API never talks to the user and doesn't need to call the provider per request. It downloads the
  provider's public keys once from the `jwks_uri` and verifies tokens locally.

## Validating a JWT: the checklist

Libraries do this for you, but you should know what they're doing, because misconfiguring one is how
JWT vulnerabilities happen.

1. **Pin the algorithm.** Accept only what you expect (say `RS256`). Never accept `alg: none`, and never
   let an HMAC verifier be handed an RSA public key as its "secret" (the classic algorithm-confusion bug).
2. **Get the key from your configuration, not the token.** Look the `kid` up in the issuer's JWKS that
   you discovered yourself. Ignore `jku`, `x5u` or embedded keys in the header.
3. **Verify the signature** before reading anything else.
4. **Check `iss`** exactly, **`aud`** contains you, and **`exp`** / **`nbf`** with a small skew.
5. **For ID tokens**, check `nonce` matches what you sent, and `azp` if there are several audiences.
6. **Then authorize:** map `scope`, `roles` or `groups` to what this endpoint allows. A valid token is
   not the same as a permitted request.

## Why JWTs are so useful

- **Verification is local.** An API checks a signature with a cached public key. There's no session
  table and no call to the identity provider per request, so it scales and keeps working if the
  provider has a blip.
- **Asymmetric signing separates powers.** Only the issuer holds the private key. Every API can verify;
  none of them can mint. Compare that with a shared secret, where every verifier is also a potential forger.
- **They're self-describing.** Issuer, audience, subject, expiry and permissions travel together, so a
  decision can be made and logged from the token alone.
- **Keys rotate cleanly.** Providers publish several keys in the JWKS and the `kid` picks one, so a key
  can be replaced without breaking tokens in flight.
- **They cross boundaries.** Compact, URL-safe and JSON, they work for browsers, phones, microservices,
  CLIs and CI pipelines, across companies and clouds.

### Why you can't just make one up

Anyone can write a JWT. The header and payload are just JSON, and the lab below will happily put
`"roles": ["admin"]` in one for you. What nobody can do without the issuer's private key is produce a
**signature the verifier accepts**, and the verifier, not the token, decides which key that is.

| What an attacker tries | Why it fails |
|---|---|
| Write a token from scratch with the right claims and sign it with their own key | The API only trusts keys from the JWKS of the issuer *it* was configured with. The attacker's key isn't there, so the signature check fails. |
| Take a real token and change a claim (`reader` → `admin`, a different `sub`) | The signature covers every byte of the header and payload. Change one and it no longer verifies. Try **Tamper** in the lab. |
| Guess or brute-force a valid signature | Forging RS256 means recovering a 2048-bit RSA private key (about 112 bits of security); forging HS256 with a random 256-bit secret means up to 2²⁵⁶ guesses. Neither is feasible. |
| Run their own identity provider with real keys | Their tokens carry *their* `iss`. The API checks `iss` against the one issuer it trusts and rejects everything else. |
| Reuse a token that was issued for a different app | The `aud` claim names that app, not this API, so the audience check fails. |
| Set `alg: none`, swap RS256 for HS256, or point `jku` at their own key | These only work against a misconfigured verifier: one that lets the token choose its algorithm or its key. Pinning the algorithm and loading keys from configuration closes all three. |
| Crack a weak shared secret | This one *can* work. An HS256 token signed with `secret` or `password123` can be cracked offline, because the token itself lets an attacker test guesses. Use long random secrets, or better, asymmetric keys. |

So a JWT is secure for a precise reason: **only the holder of the private key can produce a signature
that verifies against a public key the API already trusts, for an issuer and audience the API already
expects.** Every hole in the table comes from skipping one of those checks.

What signatures *don't* protect against is theft. A JWT is a **bearer token**: whoever holds a valid
one can use it until it expires, just as anyone holding a house key can open the door. That's why access
tokens live for minutes, travel only over TLS, stay out of reach of page scripts, and, in
high-assurance systems, are bound to the client that requested them (sender-constrained tokens such as
DPoP or mutual-TLS binding), so a stolen copy is useless on its own.

They have trade-offs too, and good designs plan for them:

- **Revocation is hard.** A signed token stays valid until `exp`. Keep access tokens short-lived and
  use refresh tokens (which *can* be revoked) to keep sessions going.
- **Anyone can read them.** No secrets or sensitive personal data in claims.
- **Where you keep them matters.** A token in `localStorage` is readable by any script that runs on the
  page, so one XSS bug leaks it. For browser apps, a backend-for-frontend holding tokens server-side
  behind an `HttpOnly` cookie is the safer pattern.

## Try it: mint and decode your own JWT

The lab below signs demo tokens and decodes any token **entirely in your browser** with the Web Crypto
API. Nothing is sent anywhere, and generated keys disappear when you reload.

1. Pick a token type and an algorithm, adjust the claims, and press **Generate**.
2. Press **Send to decoder**. The decoder splits the token into its parts, decodes the header and payload
   (they're only Base64URL), explains each claim and turns timestamps into dates. The signing key comes
   along, so it also checks the signature.
3. Press **Tamper**, then **Send to decoder** again. The lab changed a claim without re-signing: an access
   token's `roles` become `admin`, an ID token's `sub` becomes someone else. The token still decodes fine,
   but the signature fails. That one check is what stops a user from promoting themselves.
4. Set the expiry to `-5` minutes and generate again to see the token reported as expired.
5. Paste a token from somewhere else, with a PEM public key, a JWK or a provider's whole JWKS document, to
   decode and verify it. You can also **Copy** a generated token into [jwt.io](https://jwt.io/) and get
   the same results there.

<div class="card jwt-lab" data-jwt-lab>
  <p class="jl-noscript">The lab needs JavaScript and the Web Crypto API.</p>
</div>

> Treat real tokens like passwords: anyone holding a live access token can use it until it expires. This
> decoder never sends what you paste anywhere, but get into the habit of only pasting tokens that are
> expired or from a test tenant, and never into a site you haven't checked.

## OIDC vs SAML

SAML 2.0 (2005) solved enterprise single sign-on long before OIDC (2014) existed, and it still runs a
lot of workforce SSO into SaaS apps. Both let an identity provider vouch for a user to an application.
They differ in almost everything else.

| | SAML 2.0 | OpenID Connect |
|---|---|---|
| Built on | Its own XML protocol | OAuth 2.0 |
| Token | XML assertion | JWT (JSON) |
| Signing | XML Signature (XML-DSig) | JWS (`RS256`, `ES256`, …) |
| Transport | Browser POST or redirect bindings; the assertion passes through the browser | Browser redirect carries a code; tokens come back channel from the token endpoint |
| Clients | Browser-based web apps | Web, single-page and mobile apps, CLIs, devices, workloads |
| Calling APIs | Not covered; needs something extra | Built in: pairs with OAuth access tokens |
| Setup | Exchange metadata XML and certificates per app, often by hand | Discovery document plus a JWKS endpoint; keys rotate automatically |
| Classic pitfalls | XML signature wrapping, XXE, canonicalization bugs | Algorithm confusion, missing `aud` / `iss` / `nonce` checks |

**When to use which:** for anything new, especially if it has a mobile app, a single-page app or an API,
use OIDC. Keep SAML where an enterprise customer or an existing SaaS integration requires it. Most
identity providers speak both, so you rarely have to choose one for the whole company.

## OIDC without a human: this site's own pipeline

OIDC isn't only for people. The pipeline that deploys this site uses it in place of stored AWS keys,
as described in [how this site is built](/blog/how-this-site-is-built/):

1. When a deploy job runs, GitHub's OIDC provider issues the job a short-lived JWT. Its `iss` is
   GitHub's token service, its `aud` is `sts.amazonaws.com`, and its `sub` names the exact repository and
   environment, for example `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:production`.
2. The job hands that JWT to AWS STS, which verifies the signature against GitHub's published keys.
3. The IAM role's trust policy is the authorization step. It allows the exchange only when `aud` and
   `sub` match exactly, so a pull request, another branch or another repository gets nothing.
4. STS returns credentials that expire within the hour.

Nothing long-lived is stored anywhere, and the policy decision rests entirely on claims. That's the
whole idea of OIDC in miniature: a trusted issuer makes signed statements, and each system that
receives them checks the signature and then decides what those statements permit.
