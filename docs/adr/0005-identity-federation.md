# ADR-0005 — Identity federation with miniOrange

- Status: **Accepted** by Boris (Head of Tech), 24 Sep 2026. Items that also need Finance or other owners stay open in 07 (for example DEC-07 hosting cost, DEC-06 IdP facts)
- Date: 2026-09-24

## Context

miniOrange stays the IdP (brief §1), and already federates Brightspace and Hivebrite (§2). ID-01 needs an immutable subject identifier and a verified email, with no identification by email alone. ID-03 needs account linking without duplicate identities. ID-04 needs deactivation and recovery through the IdP.

We don't know yet (A-01, A-02):
- Which protocol TCGI's miniOrange tenant exposes for new SPs.
- Which attribute is stable and non-reassignable.
- Whether it supports back-channel or single logout, or SCIM provisioning.
- Whether a sandbox or non-prod tenant exists.

## Options

| | OIDC (Authorization Code + PKCE) | SAML 2.0 (SP-initiated, signed assertions) |
|---|---|---|
| Implementation risk | Lower. Mature, well-audited libraries (for example `openid-client`) | Higher. XML signature validation is a known source of vulnerabilities (signature wrapping). Must use a well-maintained library with strict settings |
| Subject | `iss` + `sub` | Issuer + persistent `NameID`, or an agreed immutable attribute |
| Logout | RP-initiated, and back-channel logout if supported | SLO (often unreliable across SPs) |
| Existing TCGI use | Unknown | Unknown. Possibly what Brightspace uses |

## Proposed decision

- **Prefer OIDC** if miniOrange offers it for our tenant. Otherwise use SAML 2.0 with a strict configuration: signed assertions required, audience, recipient and destination checked, `InResponseTo` tracked, clock skew ≤ 2 min, replay cache on assertion ID, no unsolicited IdP-initiated login unless approved.
- The identity key is **`IdentityLink(issuer, subject)`**, unique. Email is a *mutable attribute* updated on each login, never used for lookup at sign-in.
- **First sign-in:**
  - If an `IdentityLink` exists, sign in.
  - Otherwise, if a pending **invitation** matches (by a signed token in the invite link, *not* by email alone), bind the new IdentityLink to the pre-created Person (for migrated or invited users, ID-03).
  - Otherwise, create a new Person **only if** the policy allows self-registration for B2C (DEC-06). Pre-migrated records must never auto-merge on email. An email match raises a link-review task for support instead.
- **Sessions:** a server-side session store, `HttpOnly` + `Secure` + `SameSite=Lax` cookies, rotated on login. Idle and absolute timeouts are set per DEC-06. Periodic re-validation with the IdP where it's supported, so IdP deactivation (ID-04) takes effect within the agreed window.
- Every login, failed login, link, unlink and role change creates an `AuditEntry`.
- Phase B uses a **miniOrange sandbox or non-prod tenant with test users only**. Using the production IdP is an external write and needs explicit approval.

## Open facts to obtain (DEC-06)

1. The protocol, metadata or discovery URL of the sandbox tenant.
2. The stable subject attribute, and confirmation that it is never reassigned.
3. The email verification flag or claim.
4. Logout and deactivation mechanics.
5. Whether Hivebrite and Brightspace receive the same subject (for linking, A-02).
6. MFA policy for TCGI staff roles. We recommend MFA be enforced at the IdP for `tcgi_*` roles.
