# RLS / GRANT proposals (not applied)

ไฟล์ในโฟลเดอร์นี้เป็น **ข้อเสนอ** ไม่ได้อยู่ใน `db/migrations/` จึงไม่ถูก `npm run db:migrate` หรือ `db:setup` รันโดยอัตโนมัติ และ **ห้ามย้ายเข้า migrations ก่อน gate ใน [PHASE5F](../docs/PHASE5F_OPERATIONS_ROTATION_RLS.md) ผ่าน**

| ไฟล์ | ระดับ | ผล |
| --- | --- | --- |
| `013_rls_grant_tier_ab.sql` | A + B | revoke สิทธิ์ `anon`/`authenticated` (ถ้า role มีอยู่) และ `ENABLE ROW LEVEL SECURITY` ทุกตารางใน schema ปัจจุบัน โดยไม่สร้าง policy และไม่ใช้ `FORCE` — **apply บน staging แล้ว 2026-11-01** |
| `013_fk_supporting_indexes.sql` | C (บางส่วน) | 7 index สำหรับ FK ที่ audit พบว่าไม่มี index รองรับ; ต้องรัน `CONCURRENTLY` นอก transaction |
| `verify-rls-grant.sql` | read-only | ตรวจ RLS coverage, policy, สิทธิ์ browser role และ FK index ก่อน/หลัง |
| `015_tier_c_app_role.sql` | C | สร้าง role `line_ccc_app` (NOBYPASSRLS) + grant DML + default privileges + permissive policy ทุกตารางที่ยังไม่มี policy — **proposal only, ยังไม่ apply** |
| `verify-tier-c.sql` | read-only | ตรวจ attributes ของ role, coverage ของ policy, drift (ตารางที่ app role มองไม่เห็น/เขียนไม่ได้), สิทธิ์ DDL, default privileges, sequences และ probe เทียบจำนวนแถว owner vs app role ใน transaction เดียว |

## Tier C สรุปจากผลซ้อม 2026-11-04

- **demote `line_ccc` ไม่ได้** — เป็น bootstrap user ของ initdb (เพราะ compose ตั้ง `POSTGRES_USER=line_ccc`) และ PostgreSQL ห้ามเอา SUPERUSER ออกจาก role นี้ (`DETAIL: The bootstrap user must have the SUPERUSER attribute.`) Tier C จึงเป็น "แยก connection" ไม่ใช่ "ลบสิทธิ์": runtime ใช้ `line_ccc_app`, owner เหลือไว้สำหรับ migrate/DDL/backup/restore เท่านั้น
- **`NOBYPASSRLS` บน superuser ไม่มีผล** — ซ้อมแล้ว `rolbypassrls=f` แต่ยังเห็นครบ 7 แถวและเขียนได้ 015 จึงไม่ตั้ง flag นี้ (ตั้งไป audit จะสวยแต่พฤติกรรมเท่าเดิม)
- **policy block ขาดไม่ได้** — role ที่มี grant DML ครบแต่ไม่มี policy จะ `select` ได้ 0 แถว**เงียบ ๆ**, `insert` จะ error เรื่อง RLS; backend ไม่ crash แต่เสิร์ฟ admin panel ว่างเปล่า
- ผลซ้อมเต็ม + rollback ที่รันจริง + ลำดับการ apply บน staging อยู่ใน [PHASE5F](../../docs/PHASE5F_OPERATIONS_ROTATION_RLS.md) หัวข้อ "Tier C — ผลซ้อมบน disposable DB"
- งานที่ต้องทำพร้อมกัน (ยังไม่ได้ทำ): สลับ `DATABASE_URL` ใน `.env.staging` และเรียก `cli.js migrate|seed|setup|ops|rotate-vault` ด้วย owner URL เพราะ [cli.ts](../../apps/api/src/cli.ts) ใช้ pool เดียว

## ทำไมยังไม่ใช้ FORCE

API/worker ต่อด้วย role เจ้าของตาราง ซึ่ง bypass RLS อยู่แล้ว การเปิด RLS แบบไม่ FORCE จึงตัด exposure ผ่าน browser roles โดยไม่ทำให้ backend ล่ม จนกว่าจะมี role `line_ccc_app` แบบ `NOBYPASSRLS` + tenant policies + `set local app.workspace_id` (Tier C)

## ซ้อมบน disposable DB (Docker)

```bash
# 1) DB ชั่วคราว (loopback เท่านั้น)
docker run --rm -d --name line-ccc-rls-drill \
  -e POSTGRES_USER=line_ccc -e POSTGRES_PASSWORD=drill-only-password \
  -e POSTGRES_DB=line_ccc_rls_drill -p 127.0.0.1:55499:5432 postgres:16-alpine

# 2) migrations 001–012 (ใช้ compiled CLI; ไม่ seed ก็ได้)
DATABASE_URL=postgres://line_ccc:drill-only-password@127.0.0.1:55499/line_ccc_rls_drill \
  node dist/api/cli.js migrate

# 3) ตรวจก่อน + apply ข้อเสนอ
psql "$DRILL_URL" -f db/proposals/verify-rls-grant.sql
psql "$DRILL_URL" --single-transaction -f db/proposals/013_rls_grant_tier_ab.sql
psql "$DRILL_URL" -f db/proposals/013_fk_supporting_indexes.sql
psql "$DRILL_URL" -f db/proposals/verify-rls-grant.sql

# 4) ยืนยันว่า owner connection ยังใช้งานได้ แล้วลบ DB ชั่วคราว
docker rm -f line-ccc-rls-drill
```

Tier C ซ้อมบน network เดียวกัน (host ไม่มี `node` ใน PATH จึงรัน CLI ใน container) — ผลเต็มอยู่ใน PHASE5F หัวข้อ "Tier C — ผลซ้อม":

```bash
docker network create line-ccc-tierc-drill
docker run -d --name line-ccc-tierc-pg --network line-ccc-tierc-drill \
  -e POSTGRES_USER=line_ccc -e POSTGRES_PASSWORD=drill-only-password \
  -e POSTGRES_DB=line_ccc_tierc_drill postgres:16-alpine

# migrate 001–014 + seed ด้วย compiled CLI
docker run --rm --network line-ccc-tierc-drill -v "$PWD:/app" -w /app \
  -e DATABASE_URL=postgres://line_ccc:drill-only-password@line-ccc-tierc-pg:5432/line_ccc_tierc_drill \
  -e STAGING_ADMIN_PASSWORD=drill-admin-password node:24-alpine node dist/api/cli.js setup

# จำลองสถานะ staging จริง (RLS ทุกตาราง, policy 0) แล้วค่อย apply Tier C
docker cp db/proposals/013_rls_grant_tier_ab.sql line-ccc-tierc-pg:/tmp/013.sql
docker cp db/proposals/015_tier_c_app_role.sql line-ccc-tierc-pg:/tmp/015.sql
docker exec line-ccc-tierc-pg psql -U line_ccc -d line_ccc_tierc_drill -X -v ON_ERROR_STOP=1 --single-transaction -f /tmp/013.sql
docker exec line-ccc-tierc-pg psql -U line_ccc -d line_ccc_tierc_drill -X -v ON_ERROR_STOP=1 --single-transaction -f /tmp/015.sql
docker exec line-ccc-tierc-pg psql -U line_ccc -d line_ccc_tierc_drill -X -c "\password line_ccc_app"

# app จริงรันด้วย role ใหม่ + smoke + verifier
docker run -d --name line-ccc-tierc-api --network line-ccc-tierc-drill -v "$PWD:/app" -w /app \
  -e DATABASE_URL=postgres://line_ccc_app:drill-only-password@line-ccc-tierc-pg:5432/line_ccc_tierc_drill \
  -e PERSISTENCE=postgres -e APP_MODE=DRY_RUN -e LINE_WEBHOOK_ENABLED=false -e HOST=0.0.0.0 \
  node:24-alpine node dist/api/server.js
docker cp db/proposals/verify-tier-c.sql line-ccc-tierc-pg:/tmp/verify.sql
docker exec line-ccc-tierc-pg psql -U line_ccc -d line_ccc_tierc_drill -X -f /tmp/verify.sql

docker rm -f line-ccc-tierc-api line-ccc-tierc-pg && docker network rm line-ccc-tierc-drill
```

บน Git Bash ต้อง `export MSYS_NO_PATHCONV=1` ไม่งั้น docker.exe จะแปลง path ฝั่ง container (`/tmp/...`) เป็น path Windows — เป็นปัญหาเฉพาะ workstation ไม่ใช่ตัว script

## ผลซ้อมบน Docker (2026-11-01)

- migrate 001–012 บน Postgres 16 container, สร้าง role `anon`/`authenticated` + grant SELECT เพื่อจำลอง Supabase
- หลัง apply: RLS เปิดครบ **26/26 ตาราง**, policy **0**, สิทธิ์ตารางของ browser role **0**
- FK index ที่ audit ระบุ 7 ตัวถูกสร้างครบ
- API ต่อด้วย owner connection ยังทำงานปกติ: smoke ผ่าน **16/16** (login, session, ops health, audit, logout)
- ข้อสังเกต: `has_schema_privilege(..., 'USAGE')` ยังเป็น true บน schema `public` เพราะสิทธิ์มาจาก `PUBLIC` ไม่ใช่ grant ตรงของ role; ข้อเสนอนี้ revoke จาก `PUBLIC` เฉพาะ schema ที่ไม่ใช่ `public` (เช่น `line_ccc`) แต่ยังต้องปิด schema exposure ใน Supabase Data API แยกต่างหาก
- `verify-rls-grant.sql` ใช้การตรวจ FK แบบเข้มกว่าจึงพบ composite FK ที่ยังไม่มี index นำหน้าเพิ่มอีก 18 รายการ นอกเหนือจาก 7 ตัวที่ audit เดิมระบุ ต้องตัดสินใจแยกเรื่อง index bloat ก่อนเพิ่ม

## ก่อน apply จริง

1. รัน read-only audit กับ staging จริงและเก็บผลก่อน/หลัง
2. backup + checksum + restore drill ผ่าน
3. ระบุหน้าต่างเวลาและผู้ดำเนินการ
4. ตรวจว่า schema ไม่ถูก expose ผ่าน Supabase Data API (ถ้าไม่ได้ใช้)
5. หลัง apply: audit ซ้ำ, smoke, integration suites, และเฝ้า error rate

Rollback: `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` เฉพาะตารางที่เปิดในรอบนั้น และ `DROP INDEX CONCURRENTLY` เฉพาะ index ที่เพิ่ม; การคืน `GRANT` ต้องคืนตามผล audit เดิมเท่านั้น ห้าม grant แบบเหมารวม
