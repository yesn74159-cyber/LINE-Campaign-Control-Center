# LINE CCC — Phase 2 Workspace and LINE OA Admin

Status: IMPLEMENTED IN ISOLATED DEVELOPMENT BRANCH; NOT DEPLOYED.
Requires Migration 008 before enabling this API (otherwise fail closed).

## Delivered
- Admin sidebar Workspace page with editable workspace name, member listing,
  OA channel metadata (Messaging API Channel ID, LINE Login Channel ID, Provider ID).
- Tenant-safe API:
  GET /api/workspace/settings
  PATCH /api/workspace/settings (owner only, CSRF)
  GET /api/workspace/members (owner/admin)
  GET /api/workspace/oa-channels (owner/admin)
  PUT /api/workspace/oa-channels/:oaId (owner only, CSRF)
- Each endpoint checks the authenticated user's own ACTIVE membership against
  workspace_memberships; authorization does not trust a caller-supplied workspace ID.
- OA ID is checked inside the workspace before a write; composite DB FKs also
  protect against cross-workspace association.
- Channel metadata stays VERIFY_PENDING, never falsely reports API connectivity.
- Unknown request fields (including tokens/secrets) are rejected. This phase has
  no endpoint for real credential input and makes no external LINE requests.
- Existing login session and password login enforce active membership.
- Identical emails across multiple tenants fail closed rather than arbitrarily
  choosing a tenant. A workspace-aware login selector is still required.

## Verification
- TypeScript/Vite/Admin/API build passes (there is a non-blocking Vite
  warning for 500KB JS chunk size).
- API tests cover CSRF, owner/viewer RBAC, inactive membership, attempted
  cross-tenant OA updates, and attempted credential injection.
- Database constraints in Migration 008 tested separately against a temporary
  PostgreSQL database on line-ccc-v1; no real send/LINE credentials.
- This is development QA only; authenticated browser end-to-end against a
  clean scratch deployment is still required before release.

## Not yet delivered
- Creation/assignment of staff user accounts; invitation and revocation UI.
- Workspace selector, LINE Login OAuth, QR Login and verified identity link.
- Per-OA token/secret secret-manager storage and authenticated channel check.
- Staff referral links, signed LINE follows, attribution, consent, dashboard.
- Full tenant isolation and performance QA, public production rollout.
- LIVE Messaging API sending. Explicit separately approved send test required.

## Deployment restrictions
- Do not deploy onto https://13-251-108-245.sslip.io/ yet.
- Never apply Migration 008 without verified backup and fresh release rollout.
- Maintain APP_MODE=DRY_RUN, LINE_LIVE_ENABLED=false, LINE_WEBHOOK_ENABLED=false.
- Do not modify production OA, PG77/STUKUTO, other services, or original main.
## Browser QA added
- Chrome headless smoke test validates the Workspace page renders, one existing
  member appears, and Owner submits a rename with a CSRF token.
- Test uses a local ephemeral HTTP server and mocked API data. It does not change
  production data or prove the complete authenticated AWS release.
- Run: npm run test:tenant:ui