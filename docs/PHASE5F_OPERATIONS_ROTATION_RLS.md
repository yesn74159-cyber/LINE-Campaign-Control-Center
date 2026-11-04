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

**ระดับ C — least privilege เต็มรูปแบบ (เขียน proposal + ซ้อมแล้ว 2026-11-04, ยังไม่ apply)**
- สร้าง role `line_ccc_app` แบบ `NOBYPASSRLS`, grant เฉพาะ SELECT/INSERT/UPDATE/DELETE ที่จำเป็น และให้ API/worker ใช้ role นี้
- `FORCE ROW LEVEL SECURITY` + policies ที่ผูก `current_setting('app.workspace_id')`; ต้องแก้ repository ให้ `set local app.workspace_id` ทุก transaction — เป็นงานโค้ดแยก ไม่ควรทำพร้อม grant rollout
- เพิ่ม index ทั้ง 7 ตัวด้วย `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (ต้องรันนอก transaction, ทีละตัว, มี rollback `DROP INDEX CONCURRENTLY`)
- บันทึกผลด้วย [read-only-audit.sql](../db/audit/read-only-audit.sql) ก่อน/หลัง
- ข้อจำกัดที่ซ้อมแล้วเจอ: **role เจ้าของที่ initdb สร้างให้ `line_ccc` เป็น bootstrap user จึง `nosuperuser` ไม่ได้** รายละเอียดทั้งหมดอยู่ในหัวข้อ "Tier C — ผลซ้อม" ด้านล่าง

### ไฟล์ข้อเสนอและผลซ้อม (2026-11-01)

- [013_rls_grant_tier_ab.sql](../db/proposals/013_rls_grant_tier_ab.sql) — Tier A+B, ตรวจ `pg_roles` ก่อน revoke, เปิด RLS ทุกตารางใน schema ปัจจุบัน, ไม่มี policy, ไม่มี `FORCE`; revoke `PUBLIC` เฉพาะ schema ที่ไม่ใช่ `public`
- [013_fk_supporting_indexes.sql](../db/proposals/013_fk_supporting_indexes.sql) — 7 index ของ FK ที่ audit ระบุ ใช้ `CONCURRENTLY`
- [verify-rls-grant.sql](../db/proposals/verify-rls-grant.sql) — read-only ตรวจ coverage/policies/grants/FK index
- ซ้อมบน Postgres 16 container ที่ migrate 001–012 และจำลอง role `anon`/`authenticated`: RLS **26/26**, policy **0**, สิทธิ์ตาราง browser role **0**, owner connection ยังทำงาน และ smoke ผ่าน **16/16**
- ข้อสังเกต: `schema_usage` ของ browser role ยังเป็น true บน `public` เพราะสิทธิ์มาจาก `PUBLIC` (ข้อเสนอ revoke เฉพาะ schema ที่ไม่ใช่ `public` และต้องปิด Data API exposure แยก); การตรวจ FK แบบเข้มพบ composite FK ที่ยังไม่มี index นำหน้าเพิ่ม **18** รายการ ต้องตัดสินใจเรื่อง index bloat แยกก่อน
- ไฟล์ทั้งหมดอยู่ใต้ `db/proposals/` **ไม่อยู่ใน `db/migrations/`** จึงไม่ถูก apply อัตโนมัติ

### Tier C — ผลซ้อมบน disposable DB (2026-11-04)

สภาพที่ซ้อม: `postgres:16-alpine` ที่ start ด้วย `POSTGRES_USER=line_ccc` (เหมือนกับ compose บน staging) → migrate 001–014 + seed ด้วย `node dist/api/cli.js setup` ใน container `node:24-alpine` → apply `013_rls_grant_tier_ab.sql` ให้ได้สถานะ**เดียวกับ staging จริง** (RLS 27/27, policy 0) → ค่อย apply [015_tier_c_app_role.sql](../db/proposals/015_tier_c_app_role.sql)

**1) ประเด็นแรกที่ต้องยอมแพ้: demote ตัวเองทำไม่ได้**

```
alter role line_ccc with nosuperuser
ERROR:  permission denied to alter role
DETAIL: The bootstrap user must have the SUPERUSER attribute.
```

docker postgres image start cluster ด้วย `POSTGRES_USER=line_ccc` ทำให้ role นั้นเป็น bootstrap user ของ initdb และ PostgreSQL กันไม่ให้เอา SUPERUSER ออก (เป็นพฤติกรรมของ PostgreSQL ไม่ใช่ค่าที่เราตั้งผิด) ดังนั้น "แก้ข้อค้นพบใน audit ด้วยการ demote" จึงเป็นไปไม่ได้บน cluster ปัจจุบัน → proposal เปลี่ยนเป้าหมายเป็น **แยก connection ของ runtime ออกจาก role เจ้าของ** แทน

**2) `NOBYPASSRLS` บน superuser เป็นแค่เครื่องสำอาง — 015 จึงจงใจไม่ตั้ง**

ซ้อมตั้ง `nobypassrls` ให้ `line_ccc`: ได้ `rolbypassrls = f` จริงแต่ `select count(*) from campaigns` ยังเห็น 7 แถว และ `insert` ยังลง เพราะ superuser bypass RLS โดยไม่สน flag นั้น ถ้าตั้งไป audit จะอ่านว่า "ผ่าน" ทั้งที่พฤติกรรมเท่าเดิม — เป็นการซ่อนข้อค้นพบ ไม่ใช่แก้

**3) พิสูจน์ว่า policy block ขาดไม่ได้** (role ที่ grant DML ครบแต่ไม่มี policy)

|คำสั่ง|ผล|
|---|---|
|`select count(*) from campaigns`|**0 แถว โดยไม่มี error**|
|`update campaigns ...` / `delete from campaigns`|`UPDATE 0` / `DELETE 0`|
|`insert into campaigns (...)`|`ERROR: new row violates row-level security policy`|
|`create table ...`|`permission denied for schema public`|
|`alter table campaigns add column ...`|`must be owner of table campaigns`|

backend ที่ตกอยู่ในสภาพนี้ **ไม่ crash** — มันเสิร์ฟ admin panel ที่ว่างเปล่าให้ operator ดู ซึ่งแย่กว่า crash มาก นี่คือเหตุผลที่ 015 ไม่มี `BEGIN/COMMIT` ในไฟล์ และต้องรันด้วย `--single-transaction -v ON_ERROR_STOP=1`

**4) ผลตรวจหลัง apply 015 (27 policies / 27 ตาราง)**

- `line_ccc_app`: `rolsuper=f`, `rolbypassrls=f`, `rolcreatedb=f`, `rolcreaterole=f`, `rolconnlimit=20` (headroom บน `DB_POOL_MAX` = 5 ต่อ process มีเฉพาะ api + worker)
- อ่านครบทุกตารางตรงจำนวนเดียวกับ owner — verifier พิมพ์ `NO DIFFERENCE across 27 tables`
- write ลงจริง: `update campaigns set title = title || ' (app-role edit)'` → `UPDATE 7` และ owner เห็นแถวที่แก้; `insert into audit_log (...)` → `INSERT 0 1`
- DDL ถูกปฏิเสธครบชุด: `create table`, `truncate table` (`permission denied for table campaigns`), `create role`, `createdb`, `create extension pg_trgm`
- health query ของ [db.ts:202](../apps/api/src/db.ts#L202) รันได้เป็น app role: `current_schema=public`, `search_path="$user", public`, `pg_stat_ssl` อ่านได้, `to_regprocedure('gen_random_uuid()')` → `t`
- **app จริงรันได้**: `node dist/api/server.js` ต่อด้วย `line_ccc_app` → smoke ผ่าน **16/16** (login → `role=owner`, dashboard, delivery-health, audit log, logout — logout เป็น write path ที่วิ่งผ่าน `WITH CHECK` ของ policy)
- `node dist/api/worker.js --once` เป็น app role → exit 0 ไม่มี permission error
- owner ยังทำงานครบ: `cli.js migrate` ผ่าน, `pg_dump` ได้ 113,578 bytes (TOC นับตารางได้), `createdb` + `pg_restore --exit-on-error` ลง scratch DB แล้วนับ `campaigns` ได้ 7 แถว → nightly backup และ restore drill ไม่พังตาม
- idempotent: รัน 015 ซ้ำได้ `NOTICE: policies created for line_ccc_app: 0` และจำนวน policy ยัง 27
- sequences = 0 (`pg_class` มีเฉพาะ relkind `r` และ `i`) → ไม่ต้อง grant usage บน sequence
- default privileges ทำงานจริง: สร้าง table ใหม่ด้วย owner แล้ว app role `insert`/`select` ได้ทันที (`pg_default_acl`: `r` → `line_ccc_app=arwd/line_ccc`, `S` → `line_ccc_app=rwU/line_ccc`) แต่ table ใหม่**ไม่ได้เปิด RLS** → ต้องรัน 015 ซ้ำหลังทุก migration (block 3/4 ของ verifier จับให้ได้)
- ทดสอบ verifier โดยสร้างตารางที่เปิด RLS แต่ไม่มี policy ขึ้นมาหนึ่งตัว → รายงาน `DIFFERENCE zz_drift_gap: owner sees 2, line_ccc_app sees 0` ตรงตามตั้งใจ

**5) สิ่งที่ต้องเปลี่ยนนอกเหนือจาก SQL (เขียนเครื่องมือไว้แล้วใน `deploy/` — ยังไม่ได้รันบน staging)**

- `deploy/tier-c-apply.sh` — gate `CONFIRM=TIER-C`, refusing ถ้าไม่มี `backups/nightly-*.dump` ใหม่กว่า 26 ชม. และ refused ถ้า `pg_isready` ไม่ตอบ; apply `015` แบบ `--single-transaction` แล้วรัน verifier เก็บรายงานเป็นไฟล์ใน `backups/`
- `deploy/tier-c-switch-runtime.sh` — gate `CONFIRM=TIER-C-SWITCH`; ยืนยันว่า `line_ccc_app` อ่าน `campaigns` ผ่าน policy ของตัวเองได้ทาง unix socket ก่อนแก้ file, เก็บ owner URL ลง `.env.migrate` (chmod 600) แล้วจึงเขียน `DATABASE_URL` ใหม่ใน `.env.staging` (มี `.env.staging.bak-tierc-<stamp>`), `up -d api worker` และ **rollback env file คืนเองถ้า `/health` ไม่ผ่าน**
- [cli.ts](../apps/api/src/cli.ts) ใช้ pool เดียวจาก `DATABASE_URL` สำหรับ `migrate|seed|setup|ops|rotate-vault` → `deploy/staging-migrate.sh` เป็นทางเดียวที่อนุญาตให้เรียกงานเหล่านั้น: อ่าน owner URL จาก `.env.migrate`, `export DATABASE_URL` ด้วย builtin ของ bash (ไม่เข้า argv) แล้วส่งต่อแบบ `docker compose run --rm --no-deps -e DATABASE_URL` (ยืนยันแล้วบน Compose v2 ว่า bare `-e NAME` ทับค่าจาก `env_file`) — script ปฏิเสธการเรียกแบบไม่มี argument และปฏิเสธ `setup` เพราะค่า default ของ CLI คือ migrate+seed
- integration suites ที่สร้าง disposable DB ต้องใช้ owner URL (พวกมันรัน migration เอง)
- `LINE_IDENTITY_HASH_KEY` rotation เป็นอีกขั้น ไม่รวมมากับ Tier C

ลำดับการ apply บน staging (อนุมัติแล้ว 2026-11-04 — ผู้ดำเนินการคือเจ้าของระบบ รันเองบน VM ด้วยบัญชี `ubuntu`, หน้าต่างเวลา **2026-11-05 10:00–10:45 ICT / 03:00–03:45 UTC**)

ก่อนเข้าหน้าต่าง (read-only ทั้งหมด — ใช้ `docker exec` เพราะ repo ไม่ได้ mount เข้า container และ heredoc ไม่ต้องมี single quote ซ้อน; socket ใน container เป็น trust จึงไม่ต้องใช้พาสเวิร์ด):
```bash
tail -3 /srv/line-ccc-staging/backups/backup.log        # ต้องเห็น "nightly OK … tables=27" ของรอบ 03:30 ICT วันนี้
ls -1t /srv/line-ccc-staging/backups/nightly-*.dump | head -1
docker exec -i line-ccc-postgres-staging psql -U line_ccc -d line_campaign_ccc -X -A <<'SQL'
select id, status, scheduled_at, available_at
from scheduler_jobs
where status in ('QUEUED','PAUSED','CLAIMED','SENDING','RETRYABLE')
order by available_at nulls last;
SQL
```
ถ้าคิวงานมีรายการที่ trigger ตรงช่วง 10:00–10:45 ICT ให้ **เลื่อนหน้าต่าง** ไม่ใช่พัก worker (worker ถูก recreate เฉพาะขั้น 3 ช่วงเดียว)

ขั้นในหน้าต่าง (รันจาก `/srv/line-ccc-staging`; owner URL ไม่เคยโผล่ใน argv เพราะ psql รันใน container และ `DATABASE_URL` ถูก export ด้วย bash builtin แล้วส่งต่อแบบ bare `-e DATABASE_URL`):

1. `CONFIRM=TIER-C bash deploy/tier-c-apply.sh` — script refuse เองถ้า dump ล่าสุดเก่ากว่า 26 ชม. หรือ `pg_isready` ไม่ตอบ; copy ไฟล์เข้า container ด้วย `docker cp` แล้ว apply `015_tier_c_app_role.sql` ด้วย `--single-transaction -v ON_ERROR_STOP=1` ต่อด้วย `verify-tier-c.sql` เก็บทุกอย่างเป็นไฟล์ใน `backups/tier-c-apply-<stamp>.txt` (script ยังไม่แตะ `.env.staging`)
2. ตั้ง password ของ `line_ccc_app` **ใน session ที่มี terminal จริง** (`psql` ขอพาสเวิร์ดแบบซ่อน ต้องมี tty — `-T`/no-tty ตอบ prompt ไม่ได้):
   ```bash
   ssh -i <key> ubuntu@13.212.244.219        # เข้าแบบ interactive ไม่ใช่ ssh -T "..."
   cd /srv/line-ccc-staging
   docker exec -it line-ccc-postgres-staging psql -U line_ccc -d line_campaign_ccc -c '\password line_ccc_app'
   ```
   ห้ามพิมพ์พาสเวิร์ดใน command line หรือในแชท — หน้านี้ psql ถามเองสองครั้ง
3. `CONFIRM=TIER-C-SWITCH bash deploy/tier-c-switch-runtime.sh` — gate ด้วย unix socket login เป็น app role, เก็บ owner URL ลง `.env.migrate` (600), พิมพ์พาสเวิร์ดที่ prompt, เขียน `DATABASE_URL` ใหม่, `up -d api worker`, ตรวจ `/health` ข้างใน api container และ **rollback ไฟล์ env เองถ้า api ไม่ healthy**
4. ยืนยัน: `docker logs line-ccc-api-staging --since 5m`, smoke ผ่าน 16/16, `/api/ops/delivery-health` ไม่มี alert, `verify-tier-c.sql` พิมพ์ `NO DIFFERENCE`
5. งาน migrate ครั้งถัดไปรันผ่าน `bash deploy/staging-migrate.sh migrate` เท่านั้น (และรัน `tier-c-apply.sh` ซ้ำถ้า migration สร้าง table ใหม่ — script พิมพ์เตือนไว้ท้ายรอบ)
6. ถ้าขั้น 4 พัง: `cp .env.staging.bak-tierc-<stamp> .env.staging && docker compose ... up -d api worker` แล้วค่อยตัดสินใจเรื่อง rollback SQL (ด้านล่าง) — การปล่อย role ไว้พร้อม owner URL กลับคืน เป็น path ที่ข้อมูลไม่กระทบ

**6) ช่องโหว่ที่ยังเหลือหลัง Tier C (ต้องตัดสินใจแยก)**

superuser login ยังมีอยู่ และเอาออกได้ด้วยทางเดียวคือสร้าง cluster ใหม่ด้วย bootstrap user คนอื่นแล้ว `pg_restore` ข้อมูลเข้าไป (volume ใหม่ + dump/restore หนึ่งรอบ = ย้ายข้อมูลจริง ไม่ใช่ `ALTER`) มิฉะนั้นต้องยอมรับว่า superuser มีไว้สำหรับ break-glass/migrate/backup เท่านั้น และยืนยันด้วย verifier เป็นระยะว่า runtime ไม่ได้ใช้มัน

### Gates ก่อน apply Tier C (ต้องอนุมัติแยก)

- [x] ได้ผล audit จริงที่ยืนยัน grants/RLS/policies ปัจจุบัน (2026-11-01, บันทึกใน [PHASE5E](PHASE5E_STAGING_HARDENING.md))
- [x] Tier A/B apply บน staging แล้ว → สถานะก่อน Tier C คือ RLS ทุกตาราง, policy 0, ไม่มี `FORCE`, `line_ccc` ยัง superuser+BYPASSRLS
- [x] backup สำเร็จ + checksum + restore drill ผ่าน (2026-11-04: nightly cron บน VM + สำเนาออกนอก VM + restore dump จริงลง scratch DB และนับแถวเทียบกับบันทึก)
- [x] ซ้อมบน disposable DB — 015 ทั้งบล็อก (migrate 001–014 + seed + Tier A/B + Tier C + app จริง + worker + smoke 16/16) รายละเอียดข้างบน
- [x] อนุมัติรายการ SQL ของ 015 และหน้าต่างเวลา พร้อมชื่อผู้ดำเนินการ — **อนุมัติ 2026-11-04**: รายการ SQL ตามไฟล์ที่ commit ใน `f867d00` (ไม่มีการแก้ถ้อยคำ), ผู้ดำเนินการ = เจ้าของระบบ (รันเองบน VM, บัญชี `ubuntu`), หน้าต่าง **2026-11-05 10:00–10:45 ICT / 03:00–03:45 UTC** — choose เพราะอยู่หลังรอบ cron แรก (03:30 ICT = 20:30 UTC) ที่ verify แล้ว ~6.5 ชม. → dump ล่าสุดผ่าน gate 26 ชม. ของ `tier-c-apply.sh` ด้วยอายุจริง ไม่ใช่ dump เก่า, รอบ cron ถัดไปอยู่หลังหน้าต่างอีก ~16 ชม. จึงไม่มีงาน backup ซ้อนกับช่วงเปลี่ยนสิทธิ์ และ `APP_MODE=DRY_RUN` + `LINE_LIVE_ENABLED=false` ไม่มีสิทธิ์ส่งจริงกลางหน้าต่าง
- [ ] หลัง apply: รัน `verify-tier-c.sql` ซ้ำ, smoke, integration suites และเฝ้า error rate อย่างน้อยหนึ่งรอบ scheduler
- [x] rollback เขียนไว้ด้านล่าง **และทดสอบบน disposable DB แล้ว** (apply → rollback → apply ครบหนึ่งรอบ)

Rollback ของ Tier C (ลำดับนี้เท่านั้น — ถอน policy ก่อนถอน grant ไม่งั้น runtime จะเห็นตารางว่างกลางทาง):

```sql
begin;
do $$   -- ถอน policy ที่ 015 สร้างทุกตัว
declare t record;
begin
  for t in select c.relname, c.oid::regclass as rel from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_policy p on p.polrelid = c.oid and p.polname = c.relname || '_app_access'
           where n.nspname = 'public' order by c.relname
  loop
    execute format('drop policy %I on %s', t.relname || '_app_access', t.rel);
  end loop;
end $$;
revoke all on all tables in schema public from line_ccc_app;
revoke usage on schema public from line_ccc_app;
do $$ begin execute format('revoke all on database %I from line_ccc_app', current_database()); end $$;
alter default privileges in schema public revoke all on tables from line_ccc_app;
alter default privileges in schema public revoke all on sequences from line_ccc_app;
drop role line_ccc_app;
commit;
```

กับดักที่เจอตอนซ้อม rollback จริง: `drop role` ตรวจ dependency **ทั้ง cluster ไม่ใช่เฉพาะ database ที่เชื่อมต่อ** ถ้าเคยซ้อม restore dump (ที่ dump มาหลัง Tier C) ลง scratch DB ไว้บน container เดียวกัน policy ใน DB นั้นยังอ้างถึง role →

```
ERROR:  role "line_ccc_app" cannot be dropped because some objects depend on it
DETAIL:  27 objects in database line_ccc_restore_drill
```

ทางแก้คือ `dropdb <scratch db>` ก่อน (หรือเล็งว่าไม่ต้องลบ role เลย — rollback ที่ปลอดภัยกว่าคือเปลี่ยน `DATABASE_URL` กลับเป็น owner URL แล้วปล่อย role ไว้) ผลซ้อมหลัง rollback: policy 0, role หาย, `pg_default_acl` 0, grant ของ app role 0, **ข้อมูลครบ (campaigns ยัง 7 แถว)** และ RLS ยังเปิด 27 ตารางเท่าเดิม = กลับสู่สถานะ Tier B พอดี

หมายเหตุ 2026-11-04 (รอบสองของวัน): Tier A/B ผ่านไปแล้ว, Tier C ถูกเขียนเป็น proposal + ซ้อมครบ + **อนุมัติรายการ SQL และกำหนดหน้าต่างเวลาแล้ว** แต่ยังไม่ถูก apply บน staging — gate ที่เหลือคือ executions ตามลำดับข้างบน ซึ่งผู้ดำเนินการรันเอง (ไม่มีอะไรในขั้นเหล่านี้ที่ agent รันแทนได้: ทุกคำสั่งแตะ host จริง) และ `.env.staging` ต้องสลับในขั้น 3 ของหน้าต่าง ไม่ใช่พร้อม SQL อย่างเดียว

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
