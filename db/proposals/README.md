# RLS / GRANT proposals (not applied)

ไฟล์ในโฟลเดอร์นี้เป็น **ข้อเสนอ** ไม่ได้อยู่ใน `db/migrations/` จึงไม่ถูก `npm run db:migrate` หรือ `db:setup` รันโดยอัตโนมัติ และ **ห้ามย้ายเข้า migrations ก่อน gate ใน [PHASE5F](../docs/PHASE5F_OPERATIONS_ROTATION_RLS.md) ผ่าน**

| ไฟล์ | ระดับ | ผล |
| --- | --- | --- |
| `013_rls_grant_tier_ab.sql` | A + B | revoke สิทธิ์ `anon`/`authenticated` (ถ้า role มีอยู่) และ `ENABLE ROW LEVEL SECURITY` ทุกตารางใน schema ปัจจุบัน โดยไม่สร้าง policy และไม่ใช้ `FORCE` |
| `013_fk_supporting_indexes.sql` | C (บางส่วน) | 7 index สำหรับ FK ที่ audit พบว่าไม่มี index รองรับ; ต้องรัน `CONCURRENTLY` นอก transaction |
| `verify-rls-grant.sql` | read-only | ตรวจ RLS coverage, policy, สิทธิ์ browser role และ FK index ก่อน/หลัง |

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
