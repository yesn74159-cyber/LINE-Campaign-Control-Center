# LINE CCC - Multi-workspace and Multi-OA rollout

Status: Phase 1 foundation developed on isolated feature branch.
Not deployed to the public AWS preview. LIVE sending remains disabled.

## Phase 1 implemented
- DB migration 008 supports workspace slugs, tenant-scoped team memberships,
  OA channel metadata, LINE staff identity HMAC digests, hashed staff-invite
  tokens, and referral evidence for verified follow events.
- PostgreSQL composite foreign keys refuse associating staff, OA, invite links,
  and attribution events across different workspaces.
- A click alone cannot count as a verified OA follow; database requires
  subject HMAC plus evidence reference. A confirmed follow is unique per OA/user.
- LINE access tokens, channel secrets, and raw personal IDs are never written
  to the migration tables.
- Email-only login fails closed when multiple workspaces have the same email
  (future workspace selector or validated LINE Login is required).
- Existing single-workspace seed is preserved by automatic workspace slug default.

## Verification
- TypeScript/Admin/API build and existing baseline tests passed.
- Local ambiguous-login unit tests passed for 1 vs 2 matching accounts.
- PostgreSQL scratch instance in a separate temporary database on line-ccc-v1
  applied migrations 001-008 and passed cross-tenant negative insertion tests.
  Scratch database was dropped; primary line_ccc_v1 remained untouched.
- Unit tests alone do not establish cross-tenant safety of future API endpoints.

## Next phases before external multi-tenant launch
1. Authenticated workspace onboarding, member invitation/revocation, membership
   status, and staff-facing workspace selection with RBAC and audit logs.
2. Per-workspace OA CRUD with sensitive access token/secret storage in managed
   secrets, authenticated channel validation, and safe credential rotation.
3. LINE Login/OIDC callback: state, nonce, issuer, signature, audience, expiry,
   redirect URI, and provider-scoped staff identity linking/unlinking.
4. Invite QR/deep links generated with cryptographic random tokens, safe share UI,
   customer opt-in, attribution policy for repeated shares, signed follow webhooks.
5. Two-workspace end-to-end isolation tests and negative access-control tests.
6. Per-workspace reporting, backup outside this Lightsail VM, failure alerts,
   retention/privacy compliance, MFA, and reviewed production rollout.
7. LIVE LINE sending remains a separate approval and a separate implementation.

## Boundaries
- Existing AWS preview: https://13-251-108-245.sslip.io/ stays DRY_RUN and unchanged.
- No migration on live line_ccc_v1; no app deploy or LINE OA credential changes.
- No changes to PG77, STUKUTO, Docker volumes, or original main branch.
- Do not enable self-registration or allow multiple customers yet.