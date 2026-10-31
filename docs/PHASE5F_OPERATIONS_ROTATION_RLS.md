# Phase 5F — Vault Rotation, Alert Delivery และ RLS/Grant Proposal

สถานะ: **local-only** — โค้ดและข้อเสนอพร้อม, compose stack ผ่านการทดสอบบน Docker ในเครื่องแล้ว, SQL ข้อเสนอ RLS/grant อยู่ใน [db/proposals](../db/proposals/) และซ้อมบน disposable DB แล้ว แต่ยังไม่มีการเชื่อม cloud, ไม่มี RLS/grant change, ไม่มี migration ใหม่, ไม่มี deploy

ผลทดสอบ compose (2026-11-01): migrations 001–012 บน DB ว่างผ่านหลังแก้ FK ordering ใน 010, seed สร้าง membership ทำให้ login ได้, smoke 16/16 ผ่าน; รายละเอียดอยู่ใน [WORKLOG](./WORKLOG.md)

## 1) Vault key re-encrypt CLI

โมดูล: [vaultRotate.ts](../apps/api/src/vaultRotate.ts) · CLI: `npm run vault:rotate` (คำสั่ง `rotate-vault`)

### หลักการ

- อ่านทุกแถวใน `oa_credential_vault` แล้ว `openOaSecret` ด้วย key เก่า จากนั้น `sealOaSecret` ด้วย key ใหม่โดยใช้ AAD เดิม (`lineccc:v1:<workspaceId>:<oaId>:<kind>`) จึงผูก tenant/OA เหมือนเดิม
- ตรวจ round-trip: เปิด envelope ใหม่ด้วย key ใหม่แล้วต้องได้ค่าเดิมก่อนเขียนลง DB
- ทุกแถวอยู่ใน transaction เดียว: ถ้าแถวใดเปิดไม่ได้หรือ verify ไม่ผ่าน จะ rollback ทั้งหมด
- ค่า plaintext ไม่ถูก log, ไม่ถูกส่งออก response; summary มีเพียงจำนวนแถว/workspace
- เมื่อ `--confirm` จะเขียน audit `OA_VAULT_REKEYED` ต่อ workspace โดยเก็บเฉพาะจำนวน credential

### วิธีใช้

```bash
# 1) dry-run: ยังใช้ key ปัจจุบันเป็น old, key ใหม่เป็น NEW
LINE_CREDENTIAL_ENCRYPTION_KEY=<current> \
LINE_CREDENTIAL_ENCRYPTION_KEY_NEW=<new-base64-32-bytes> \
npm run vault:rotate

# 2) ตรวจผลแล้วค่อยเขียนจริง
LINE_CREDENTIAL_ENCRYPTION_KEY=<current> \
LINE_CREDENTIAL_ENCRYPTION_KEY_NEW=<new-base64-32-bytes> \
npm run vault:rotate -- --confirm

# 3) หลังสำเร็จ: ตั้ง LINE_CREDENTIAL_ENCRYPTION_KEY = key ใหม่, ลบ NEW/OLD ออกจาก environment
```

- `LINE_CREDENTIAL_ENCRYPTION_KEY_OLD` ใช้เมื่อ key ปัจจุบันถูกเปลี่ยนไปแล้วแต่ยังต้อง rotate จาก key เก่า; ถ้าไม่ตั้งจะใช้ `LINE_CREDENTIAL_ENCRYPTION_KEY`
- ต้องเป็น base64 ของ 32 bytes (รูปแบบเดียวกับ `vaultKey`) และ old/new ต้องต่างกัน
- **Rollback**: ระหว่างที่ยังเก็บ key เก่าไว้ สามารถ rotate กลับได้โดยสลับบทบาท (`_OLD` = key ใหม่, `_NEW` = key เก่า) หรือ restore backup ที่ถ่ายก่อน rotate แล้วใช้ key เก่า
- ควรถ่าย backup ก่อน `--confirm` และเก็บ key ทั้งสองไว้จนกว่าจะยืนยันว่า API/worker ใช้ key ใหม่ได้จริง

### ข้อจำกัด

- CLI นี้ไม่ตรวจ LINE API และไม่เปลี่ยน `access_token_checked_at`
- plaintext อยู่ใน memory ของ process ชั่วคราว (string ของ Node ล้างไม่ได้แบบ deterministic) จึงควรรันบน host ที่เชื่อถือได้และไม่เปิด debug logging
- ยังไม่รองรับ envelope version ใหม่; รองรับเฉพาะ `v1`

## 2) Alert delivery ไปยังช่องทางแจ้งเตือน

โมดูล: [opsNotify.ts](../apps/api/src/opsNotify.ts) · CLI: `npm run ops:health -- --notify`

```bash
# ตั้ง OPS_ALERT_WEBHOOK_URL เป็น HTTPS endpoint ของช่องทางที่ต้องการ
OPS_ALERT_WEBHOOK_URL=https://alerts.example.invalid/line-ccc \
DATABASE_URL=... npm run ops:health -- --notify
```

- ส่ง POST JSON เมื่อมี alert เท่านั้น; ถ้าไม่มี alert จะพิมพ์ `{"notified":false,"reason":"no alerts"}` ทาง stderr
- Payload: `source`, `generatedAt`, `alerts[]`, `counts`, `workerStale`, `oldestPendingSeconds`, `quota[]` (เฉพาะ `monthlyPercent`/`usedThisMinute`/`limitPerMinute`)
- `OPS_ALERT_FORMAT` เลือกรูปแบบ: `generic` (JSON ข้างต้น), `slack` (`{"text": "..."}`), `discord` (`{"content": "..."}`) — ข้อความสรุปมีเฉพาะ alert codes และ counters
- ไม่มี workspace/OA id, ชื่อ OA, recipient key, ข้อความ push, cookie หรือ secret
- ต้องเป็น HTTPS ยกเว้น loopback สำหรับ test; URL ต้องไม่มี username/password; timeout 5 วินาที, ไม่ follow redirect
- ถ้าส่งไม่สำเร็จ CLI exit 1 และพิมพ์เฉพาะ `{"notified":false,"status":...}` ไม่พิมพ์ URL
- แนะนำตั้ง cron/systemd timer ทุก 1 นาทีผ่าน EnvironmentFile แล้วใช้ exit code เพื่อ trigger escalation; ควรมี suppression/dedup ที่ฝั่งปลายทาง เพราะ CLI ไม่เก็บ state

## 3) RLS / GRANT rollout — ข้อเสนอ (ยังไม่ apply)

### ข้อเท็จจริงจากรายงานเดิม

- Supabase project `bgwsxoeseyqwwcupzeoo`, schema `line_ccc`; RLS ถูกปิดบนทั้ง 14 ตาราง (รายงาน 2026-10-21)
- migrations 001–012 ไม่มี `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY`, `GRANT` หรือ `REVOKE` เลย
- แอปใช้ direct PostgreSQL connection ด้วย role ของ connection string (มักเป็น owner) — owner bypass RLS เว้นแต่ `FORCE ROW LEVEL SECURITY`
- มี 7 FK columns ที่ยังไม่มี supporting index: `scheduler_jobs.campaign_revision_id`, `scheduler_jobs.oa_integration_id`, `scheduler_jobs.workspace_id`, `audit_log.workspace_id`, `webhook_events.workspace_id`, `auth_sessions.user_id`, `outbox_deliveries.oa_integration_id`

### ความเสี่ยง

ถ้า schema `line_ccc` ถูก expose ผ่าน Supabase Data API และ role `anon`/`authenticated` มี grant อยู่ ข้อมูล admin/auth/customer/outbox อาจถูกอ่านได้โดยไม่ผ่าน Fastify แม้แอปจะมี session/RBAC ของตัวเอง

### แนวทางที่แนะนำ (แบ่งเป็น 3 ระดับ)

**ระดับ A — ลด exposure ทันทีหลัง audit (ควรทำก่อน)**
1. ใน Supabase ตั้งค่าไม่ expose schema `line_ccc` ผ่าน Data API (ถ้าไม่ได้ใช้ PostgREST กับ schema นี้)
2. `revoke all on all tables in schema line_ccc from anon, authenticated;`
3. `revoke all on schema line_ccc from anon, authenticated;` (คง `usage` เฉพาะ backend role)
4. ทดสอบด้วย anon key ว่า query ทุกตารางได้ `permission denied` / schema not exposed

**ระดับ B — defense in depth สำหรับ browser roles**
- `alter table ... enable row level security;` ทุกตาราง โดย**ไม่**ใส่ policy ให้ `anon`/`authenticated` (deny-by-default)
- ถ้า backend ยังเป็น owner จะไม่ถูกกระทบ; ห้ามใช้ `FORCE ROW LEVEL SECURITY` จนกว่าจะมี dedicated app role + policies ครบ
- ตรวจว่า `service_role`/dashboard ไม่ถูกใช้งานจาก browser

**ระดับ C — least privilege เต็มรูปแบบ (Phase ถัดไป)**
- สร้าง role `line_ccc_app` แบบ `NOBYPASSRLS`, grant เฉพาะ SELECT/INSERT/UPDATE/DELETE ที่จำเป็น และให้ API/worker ใช้ role นี้
- `FORCE ROW LEVEL SECURITY` + policies ที่ผูก `current_setting('app.workspace_id')`; ต้องแก้ repository ให้ `set local app.workspace_id` ทุก transaction — เป็นงานโค้ดแยก ไม่ควรทำพร้อม grant rollout
- เพิ่ม index ทั้ง 7 ตัวด้วย `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (ต้องรันนอก transaction, ทีละตัว, มี rollback `DROP INDEX CONCURRENTLY`)
- บันทึกผลด้วย [read-only-audit.sql](../db/audit/read-only-audit.sql) ก่อน/หลัง

### ไฟล์ข้อเสนอและผลซ้อม (2026-11-01)

- [013_rls_grant_tier_ab.sql](../db/proposals/013_rls_grant_tier_ab.sql) — Tier A+B, ตรวจ `pg_roles` ก่อน revoke, เปิด RLS ทุกตารางใน schema ปัจจุบัน, ไม่มี policy, ไม่มี `FORCE`; revoke `PUBLIC` เฉพาะ schema ที่ไม่ใช่ `public`
- [013_fk_supporting_indexes.sql](../db/proposals/013_fk_supporting_indexes.sql) — 7 index ของ FK ที่ audit ระบุ ใช้ `CONCURRENTLY`
- [verify-rls-grant.sql](../db/proposals/verify-rls-grant.sql) — read-only ตรวจ coverage/policies/grants/FK index
- ซ้อมบน Postgres 16 container ที่ migrate 001–012 และจำลอง role `anon`/`authenticated`: RLS **26/26**, policy **0**, สิทธิ์ตาราง browser role **0**, owner connection ยังทำงาน และ smoke ผ่าน **16/16**
- ข้อสังเกต: `schema_usage` ของ browser role ยังเป็น true บน `public` เพราะสิทธิ์มาจาก `PUBLIC` (ข้อเสนอ revoke เฉพาะ schema ที่ไม่ใช่ `public` และต้องปิด Data API exposure แยก); การตรวจ FK แบบเข้มพบ composite FK ที่ยังไม่มี index นำหน้าเพิ่ม **18** รายการ ต้องตัดสินใจเรื่อง index bloat แยกก่อน
- ไฟล์ทั้งหมดอยู่ใต้ `db/proposals/` **ไม่อยู่ใน `db/migrations/`** จึงไม่ถูก apply อัตโนมัติ

### Gates ก่อน apply (ต้องอนุมัติแยก)

- [ ] ได้ผล audit จริงที่ยืนยัน grants/RLS/policies ปัจจุบัน
- [ ] backup สำเร็จ + checksum + restore drill ผ่าน
- [ ] อนุมัติรายการ SQL และหน้าต่างเวลา
- [x] ซ้อมบน disposable DB (migrate 001–012 + apply proposal + smoke) — ยังต้องซ้อมซ้ำจาก backup จริงก่อน apply
- [ ] หลัง apply: audit ซ้ำ, `npm run test:db-connection`, smoke, integration suites
- [ ] เอกสาร rollback: `GRANT` เดิม / `DROP POLICY` / `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` เฉพาะที่เพิ่มในรอบนั้น

หมายเหตุ 2026-11-01: ผู้ใช้ไฟเขียวให้ดำเนินการ RLS/grant rollout แล้ว แต่ gate สองข้อแรกยังเปิดอยู่เพราะยังไม่มี `AUDIT_DATABASE_URL`/`BACKUP_DATABASE_URL` จึงยังไม่มีการ apply กับ cloud ใด

**ยังไม่มี SQL ใดถูก apply หรือสร้างเป็น migration ในเฟสนี้**

## 4) Cloud audit / backup / restore drill — สถานะและสิ่งที่ต้องเตรียม

ยัง execute ไม่ได้เพราะ:

| ต้องมี | สถานะปัจจุบัน |
| --- | --- |
| `AUDIT_DATABASE_URL` / `BACKUP_DATABASE_URL` / `RESTORE_DATABASE_URL` | ไม่มีใน environment ของ session |
| PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`) | ไม่ได้ติดตั้ง |
| ปลายทาง restore เป็น disposable DB | ยังไม่มี DB ปลายทางที่ได้รับอนุมัติ |
| Docker (สำหรับ compose test) | ไม่มี Docker Desktop; WSL ใช้งานไม่ได้ |

วิธีเตรียมอย่างปลอดภัย (ไม่พิมพ์ค่าในแชท):

1. สร้างไฟล์ secret นอก git เช่น `C:\Users\ADMIN\.line-ccc-secrets\staging.env` (หรือ `.env.staging` ที่ถูก ignore) แล้วใส่ `AUDIT_DATABASE_URL`, `BACKUP_DATABASE_URL`, `RESTORE_DATABASE_URL`
2. ติดตั้ง PostgreSQL 16 client tools เพื่อให้ `pg_dump`/`pg_restore` อยู่ใน PATH
3. แจ้งเพียง **path ของไฟล์** (ไม่ใช่ค่า) แล้วผมจะรันคำสั่งโดย `source` ไฟล์และไม่ echo ค่า
4. สำหรับ restore drill ต้องสร้าง database ชื่อมี `restore|drill|scratch` และอนุญาตให้เขียนเฉพาะ DB นั้น

เมื่อพร้อมแล้วลำดับที่จะรันคือ: read-only audit → backup + checksum → restore ลง drill DB → audit/เทียบจำนวนแถว → smoke (ไม่ apply migration ใด ๆ)

## 5) Docker compose test — สถานะ

- เครื่องนี้ไม่มี Docker Desktop, ไม่มี `docker.exe`, ไม่มี Docker engine ใน WSL จึงยังรัน compose ไม่ได้
- เมื่อติดตั้ง Docker Desktop แล้ว ใช้ลำดับนี้:

```bash
cp deploy/staging.env.example .env.staging   # เติมค่าในเครื่องเท่านั้น
docker compose --env-file .env.staging -f docker-compose.staging.yml config
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
docker compose --env-file .env.staging -f docker-compose.staging.yml ps
curl -k https://localhost/health
SMOKE_BASE_URL=https://localhost npm run smoke:staging
docker compose --env-file .env.staging -f docker-compose.staging.yml down
```

- ห้ามชี้ `DATABASE_URL` ไปที่ cloud ระหว่างทดสอบนี้; ใช้เฉพาะ container postgres ในเครื่อง
- ต้องตรวจว่า worker ไม่มี published port, Caddy เป็นตัวเดียวที่เปิด 80/443 และ `/health` ผ่าน reverse proxy
