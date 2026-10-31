# Phase 5E — Staging Hardening, CI และ Runbook

สถานะ: **local/staging preparation เท่านั้น** — ไม่มีการ deploy, ไม่เชื่อม cloud, ไม่ apply migration 012, ไม่เปิด LINE Live/Webhook

## สิ่งที่ Phase 5E เพิ่ม

| พื้นที่ | สิ่งที่เพิ่ม |
| --- | --- |
| CI | [.github/workflows/staging-ci.yml](../.github/workflows/staging-ci.yml) ครอบคลุม static suites, typecheck/build, `npm audit --omit=dev`, PostgreSQL 8 jobs, migration replay จาก DB ว่าง และ Admin E2E (Chromium) |
| Deployment | [deploy/Dockerfile](../deploy/Dockerfile) (targets `api`/`admin`), [docker-compose.staging.yml](../docker-compose.staging.yml), [deploy/nginx.conf](../deploy/nginx.conf), [deploy/Caddyfile](../deploy/Caddyfile), [deploy/staging.env.example](../deploy/staging.env.example) |
| Ops | [apps/api/src/opsHealth.ts](../apps/api/src/opsHealth.ts), `GET /api/ops/delivery-health`, `npm run ops:health` |
| Tooling | [scripts/staging-smoke.mjs](../scripts/staging-smoke.mjs), [scripts/db-backup.mjs](../scripts/db-backup.mjs), [scripts/db-restore.mjs](../scripts/db-restore.mjs), [scripts/cloud-audit.mjs](../scripts/cloud-audit.mjs), [db/audit/read-only-audit.sql](../db/audit/read-only-audit.sql) |
| Tests | [tests/phase5e.test.mjs](../tests/phase5e.test.mjs) (9 tests) และ E2E referral ที่อัปเดตตาม Staff Portal ปัจจุบัน |

## CI matrix

| Job | ฐานข้อมูล/บริการ | คำสั่งหลัก |
| --- | --- | --- |
| `verify` | – | `npm run build` + static suites (core, phase1, security, 5A–5E) |
| `audit` | – | `npm audit --omit=dev --audit-level=high` |
| `postgres-line-login` | `line_ccc_line_login_qa_ci` (55433) | `npm run test:line-login:postgres` |
| `postgres-referral` | `line_ccc_referral_qa_ci` (55434) | `npm run test:referral:postgres` |
| `postgres-webhook` | `line_ccc_webhook_qa_ci` (55435) | `npm run test:webhook:postgres` |
| `postgres-delivery` | `line_ccc_delivery_qa_ci` (55436) | `npm run test:delivery:postgres` |
| `postgres-tenant` | `line_ccc_tenant_qa_ci` (55437) | `npm run db:migrate` (replay จาก DB ว่าง) → tenant integration |
| `postgres-phase4a` | `line_ccc_phase4a_qa_ci` (55438) | `npm run db:setup` → phase4a |
| `postgres-phase4b` | `line_ccc_phase4b_qa_ci` (55439) | `npm run db:setup` → phase4b |
| `postgres-integration` | `line_ccc_integration_qa_ci` (55440) | `npm run db:setup` → integration |
| `admin-e2e` | memory API + Vite | Chromium, dev servers, `npm run test:e2e`, artifact บน failure |

ทุก service ใช้ `POSTGRES_DB` เดียวกับ `--health-cmd pg_isready` ของตัวเอง และรหัส CI เป็นค่ารายงานใน workflow เท่านั้น (ไม่ใช่ credential จริง)

## Topology

```
Internet → Caddy 80/443 (TLS, HSTS)
          → admin (nginx :8080, static + /api proxy, rate limit, CSP)
              → api :8787 (private network, trustProxy=true)
                  → postgres :5432 (127.0.0.1:55433 บน host)
          worker (private, no ports) → postgres + LINE adapter (DRY_RUN mock)
```

- `api` และ `worker` ไม่มี `ports:`; เข้าถึงได้เฉพาะ network ภายใน
- `postgres` ผูกกับ loopback ของ host เท่านั้น
- `admin`/`api`/`worker` ใช้ `read_only: true`, `tmpfs /tmp`, `no-new-privileges`
- `worker` override `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false` แม้ env file จะถูกแก้
- secrets ทั้งหมดมาจาก `--env-file .env.staging` (ไม่ commit; `.dockerignore` และ `.gitignore` กันไว้)

## Secrets และ key management

- ค่าที่ห้ามเข้า git/repo: `POSTGRES_PASSWORD`, `DATABASE_URL`, `STAGING_ADMIN_PASSWORD`, `STAGING_VIEWER_PASSWORD`, `LINE_CREDENTIAL_ENCRYPTION_KEY`, `LINE_LOGIN_CHANNEL_SECRET`, `LINE_IDENTITY_HASH_KEY`, `LINE_LOGIN_FLOW_ENCRYPTION_KEY`, `STAGING_WEBHOOK_SECRET`
- บน host ใช้ EnvironmentFile ของ systemd/compose หรือ secret manager; หลีกเลี่ยงการใส่ secret ใน command line เพราะจะโผล่ใน process list
- **Backup ของ `LINE_CREDENTIAL_ENCRYPTION_KEY`**: เก็บสำเนาใน secret manager และ offline escrow แยกจาก DB backup; ถ้า key หายจะถอดรหัส OA credential ไม่ได้และต้องเชื่อม OA ใหม่
- **Rotation**: ปัจจุบันยังไม่มี CLI re-seal อัตโนมัติ (จัดเป็นงาน Phase 5F) ขั้นตอนที่ปลอดภัยคือ rotate key ใน secret store แล้ว reconnect OA แต่ละตัวเพื่อ seal ด้วย key ใหม่; ระหว่าง rotate ห้ามลบ key เก่าจนกว่าจะยืนยันว่า vault ทุกแถวถูก seal ใหม่
- ห้ามพิมพ์ค่า secret ลง log, screenshot หรือบทสนทนา; smoke/audit scripts ในชุดนี้ไม่พิมพ์ cookie, token หรือ connection string

## Metrics และ alerts

`GET /api/ops/delivery-health` (ต้องมี session + role read) และ CLI:

```bash
DATABASE_URL=... npm run ops:health   # exit 1 เมื่อมี alert
```

Response มี `counts`, `oldestPendingSeconds`, `lastWorkerActivity`, `workerStale`, `quota[]`, `alerts[]`, `ok` — เป็น aggregate เท่านั้น ไม่มี recipient key หรือ payload

| Alert | ความหมาย | การทำงาน |
| --- | --- | --- |
| `UNKNOWN_DELIVERIES` | มี outbox ที่ผลไม่แน่นอนจาก 429/5xx | ตรวจกับ LINE ด้วยตนเองแล้ว reconcile ผ่าน Admin |
| `STUCK_DELIVERIES` | PENDING/SENDING/RETRYABLE เก่ากว่า `OPS_STUCK_MINUTES` | ตรวจ worker heartbeat และ lease |
| `WORKER_STALE` | มีงานค้างแต่ไม่มี audit activity เกิน `OPS_WORKER_STALE_MINUTES` | restart worker / ตรวจ DB connectivity |
| `QUOTA_NEAR_LIMIT` | monthlyUsed ≥ `OPS_QUOTA_WARN_PERCENT` | ลด campaign หรือรอรอบเดือนใหม่ |
| `OA_RATE_LIMIT_REACHED` | usedThisMinute ≥ quotaPerMinute | ลด concurrency/ตรวจ scheduler |

แนะนำให้ตั้ง cron/systemd timer เรียก CLI ทุก 1 นาทีผ่าน EnvironmentFile แล้วแจ้งเตือนเมื่อ exit code ≠ 0 (ยังไม่ผูกผู้ให้บริการแจ้งเตือนใด ๆ ในเฟสนี้)

## Smoke, backup, restore, audit

```bash
# smoke (read-only; admin checks จะ skip ถ้าไม่ใส่ credential)
SMOKE_BASE_URL=http://127.0.0.1:8787 npm run smoke:staging

# backup ก่อน migration ทุกครั้ง
BACKUP_DATABASE_URL=... npm run db:backup -- --out staging-backups --confirm

# restore drill ลง DB ที่ชื่อมี restore/drill/scratch เท่านั้น
RESTORE_DATABASE_URL=postgres://.../line_ccc_restore_drill \
  npm run db:restore -- --file staging-backups/<dump> --confirm-restore

# cloud read-only audit (SELECT เท่านั้น + transaction read only)
AUDIT_DATABASE_URL=... npm run audit:cloud -- --confirm --role line_ccc
```

Guard rails:

- backup ต้องมี `--confirm`; ตรวจ magic `PGDMP` และเขียน `.sha256`
- restore ปฏิเสธ target ที่เป็น source เดิม, ชื่อไม่อยู่ใน restore/drill/scratch, และ checksum mismatch
- audit runner ตรวจทุก statement ต้องเริ่มด้วย `SELECT`/`WITH` และรันใน `begin read only` + `statement_timeout`
- SQL audit ตรวจ migration ledger 001–012, schema parity, ตารางแปลกปลอม, RLS/policies, grants ของ role, FK ที่ไม่มี index และ vault inventory (นับจำนวนเท่านั้น)

## Runbook: pre-migration gate

1. `npm run audit:cloud -- --confirm` เก็บผล ledger/RLS/grants/index รอบก่อน
2. `npm run db:backup -- --out staging-backups --confirm` แล้วเก็บ checksum แยกจาก dump
3. ยืนยัน `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false`
4. ขออนุมัติชัดเจนก่อน apply migration 012 หรือ migration ใด ๆ บน cloud
5. หลัง apply: `npm run ops:health`, `npm run smoke:staging`, แล้วรัน integration suite ที่เกี่ยวข้อง

## Runbook: rollback / restore drill

1. หยุด `worker` ก่อน (ไม่ให้มี send ระหว่างสลับ)
2. Rollback image: redeploy commit/tag ก่อนหน้า แล้ว `docker compose --env-file .env.staging up -d --build`
3. ถ้าต้องย้อนข้อมูล: สร้าง DB ใหม่ชื่อ `line_ccc_restore_drill`, restore จาก dump ที่ผ่าน checksum
4. ตรวจ `schema_migrations`, ตารางสำคัญ และ `select count(*)` ของ outbox/audit เทียบกับ backup record
5. ชี้ `DATABASE_URL` ของ stack ชั่วคราวไปที่ drill DB เฉพาะกรณีซ้อม; ห้ามสลับ production data
6. บันทึกเวลา, dump ที่ใช้, ผลตรวจ และผู้ดำเนินการลง worklog

## Acceptance checklist

- [x] CI มี job สำหรับ PG ครบ (line-login, referral, webhook, delivery, tenant, phase4a, phase4b, integration)
- [x] migration replay จาก DB ว่างใน job `postgres-tenant`
- [x] E2E ใช้ Chromium และ artifact บน failure
- [x] `npm audit --omit=dev --audit-level=high` เป็น gate
- [x] compose เปิดเฉพาะ Caddy; worker/API private; Postgres loopback
- [x] nginx rate limit + security headers/CSP; Caddy HTTPS/HSTS
- [x] ops delivery health + CLI + thresholds/alert
- [x] smoke/backup/restore/audit scripts พร้อม guard
- [x] tests Phase 5E ผ่านในเครื่อง (9/9)
- [x] ทดสอบ compose/Caddy บนเครื่องที่มี Docker — build 3 images, migrations 001–012 บน DB ว่าง, seed 7 campaigns, Caddy HTTPS 200, smoke 16/16 (login/ops/audit/logout), worker 0 restart (2026-11-01)
- [ ] เชื่อม cloud read-only audit และเก็บหลักฐานจริง (ต้องมี `AUDIT_DATABASE_URL` + `psql`)
- [ ] สำรอง/restore drill บน staging จริง (ต้องมี `BACKUP_DATABASE_URL`/`RESTORE_DATABASE_URL` + PostgreSQL client tools)

## Limits ที่ยังค้าง

- ยังไม่มีการ deploy ขึ้น `13-251-108-245.sslip.io` หรือ cloud ใด ๆ
- เตรียม host สำหรับเครื่อง staging แยกแล้วที่ `deploy/host-bootstrap.sh` (Docker, swap, ufw, fail2ban, journald cap) แต่ยังไม่สร้างเครื่องและไม่ deploy
- migration 012 ยังไม่ถูก apply; ไม่มี RLS/grant change จากเฟสนี้
- worker ยังใช้ mock adapter เพราะ `APP_MODE=DRY_RUN`
- การ rotate vault key ยังต้องทำ manual re-connect; ยังไม่มี re-encrypt CLI
- แนะนำตั้ง external uptime check และ alert delivery (เช่น LINE Notify/อีเมล) ใน Phase 5F
