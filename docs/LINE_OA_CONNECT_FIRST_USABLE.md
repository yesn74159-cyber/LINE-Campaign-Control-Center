# LINE CCC — OA Connection Vertical Slice

Status: DEPLOYED TO AWS STAGING / DRY_RUN on 2026-10-21.
Verified public HTTPS page and anonymous access guard. No real owner LINE credentials have been supplied or validated yet.

## Owner workflow
1. Open Admin > Workspace > Connect LINE OA.
2. Enter LINE Provider ID, Messaging API Channel ID, access token and channel secret.
3. Backend confirms session + OWNER + ACTIVE workspace membership + CSRF.
4. Backend fails closed if LINE_CREDENTIAL_ENCRYPTION_KEY (32-byte base64) is absent.
5. Backend calls ONLY GET https://api.line.me/v2/bot/info to validate the access token.
6. If bot info succeeds, save an inactive staging OA and encrypted credentials under
   a workspace-bound AES-256-GCM envelope (random IV, authenticated workspace/OA/purpose AAD).
7. Return only OA name/basicId and validation status. Do not return plaintext secrets.
8. Show access-token validated; Channel Secret is NOT verified yet and LIVE send is OFF.

## Restrictions
- Do not paste tokens or secrets into a ChatGPT conversation or logs.
- Master key must be generated using CSPRNG, stored outside PostgreSQL in
  a root-controlled EnvironmentFile, and backed up securely offline.
- Do not print the master key or configure it in browser/Vite environment.
- Do not enable LIVE send: LINE_LIVE_ENABLED=false, APP_MODE=DRY_RUN,
  LINE_WEBHOOK_ENABLED=false.
- Channel ID and Provider ID entered here are metadata. LINE bot/info cannot verify
  their relationship to the bot token; full channel/provider ownership needs later
  authenticated provisioning checks. Channel Secret verification needs a signed webhook.
- Back up the current staging PostgreSQL database and verify an isolated restore
  BEFORE applying migrations 008 and 009 in any shared database.
- Rate-limit sensitive connection endpoint at the reverse proxy.
- Keys should eventually be migrated to a managed secrets vault with IAM, rotation,
  and monitored access. The AES-GCM vault is a staged prerequisite.

## Tests (without contacting real LINE)
- AES-GCM round-trip, randomized IV, wrong tenant/OA/purpose and tamper rejection
- Invalid vault master key rejected
- Mock LINE GET bot/info and non-200 rejection
- Owner+CSRF+active membership; other roles and missing key fail closed
- Invalid token and cross-workspace OA claim rejected
- Response never returns access token or secret
- Chrome UI smoke tests clear sensitive inputs after successful submission
- Migration 009 applied to a disposable PostgreSQL DB; original DB unchanged

## Next integration milestone
After safe deployment, owner can input real LINE credentials from the Admin.
Still remaining: signed webhook verification tied to the secret, LINE Login,
staff account linking, customer invite URLs/QR, verified referral analytics.
## AWS staging deployment (2026-10-21)
- New release path: /opt/line-ccc/releases/v2-oa-connect-20261021
- New static Admin root: /var/www/line-ccc-v2
- Existing prior release and static root retained for rollback.
- Pre-upgrade database backup:
  /var/backups/line-ccc/before_oa_connect_v2_20261021.dump
- Restore of snapshot + migration 008/009 verified in disposable database first.
- Staging database migrated 001..009; 7 campaigns and 1 owner remain.
- Server-side AES-256-GCM master key provisioned only on AWS in
  /etc/line-ccc/credentials.env with permissions 0640 root:lineccc.
- No encryption key shown in tool output, committed, or written to Postgres.
- Master key MUST be backed up securely outside the instance before real
  customer credentials are saved. Loss of the key prevents decrypting backups.
- New Nginx credential POST rate-limited; HTTPS via Caddy.
- Public page and bundle HTTP 200; anonymous OA status endpoint 401.
- No LINE webhook activated. API and Mock Worker still DRY_RUN.
- Provider ID/Channel ID are unverified user-entered metadata. Channel secret
  needs signed Webhook proof before it is considered verified.

## Rollback
- Revert service drop-in:
  /etc/systemd/system/line-ccc-api.service.d/50-oa-connect.conf
- Restore nginx configuration backup:
  /etc/nginx/sites-available/line-ccc-local.before-oa-connect-20261021
- Reload systemd/restart API, test Nginx config/reload Nginx and verify
  mode stays DRY_RUN. Database schema migrations 008 and 009 are additive.