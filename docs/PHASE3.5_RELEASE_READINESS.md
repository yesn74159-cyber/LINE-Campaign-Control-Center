# Phase 3.5 Staging Release Readiness

สถานะเอกสารนี้คือ Staging + `DRY_RUN` เท่านั้น ไม่มี LINE Production traffic, Messaging API outbound หรือ Production webhook

## ผลตรวจหลัก

- Scheduler/Worker ใช้ PostgreSQL จริง, `FOR UPDATE SKIP LOCKED`, idempotency key, retry/backoff และ stale-lease recovery
- API ทุก route ที่อ่านหรือเปลี่ยนข้อมูลต้องมี session; mutation ต้องผ่าน RBAC และ double-submit CSRF token
- Job mutation ตรวจ `workspace_id`; migration 004 เพิ่ม database guard ไม่ให้ Job จับ Campaign revision กับ OA คนละ workspace
- Migration 004 บังคับ `DRY_RUN`, `Asia/Bangkok` และ canonical job statuses ใน Staging
- Worker สร้าง `MockLineMessagingAdapter` เท่านั้น และหยุดทันทีหาก `APP_MODE` ไม่ใช่ `DRY_RUN`
- `.env`, staging backups, dumps และ QA screenshots ถูก ignore; ห้ามเก็บ credential ใน tracked files

## คำสั่งตรวจที่ผ่าน

รันจาก PowerShell โดยตั้ง `DATABASE_URL` จาก Container metadata หรือ secret store ของผู้ใช้เอง และไม่พิมพ์ค่าออกหน้าจอ:

```powershell
npm test
npm run test:security
npm run test:integration
npm run test:phase3
npm run test:e2e
npm run typecheck
npm run build
```

`test:e2e` ต้องมี API ที่ `127.0.0.1:8787`, Admin Vite ที่ `127.0.0.1:5173`, Chrome และ `STAGING_ADMIN_PASSWORD` ใน process environment เท่านั้น ผลทดสอบใช้ viewport 1280×720 และ 390×844 และไม่กด Schedule/Run

## ข้อจำกัดที่ยังตรวจไม่ได้

- การเปิดจากมือถือจริงบนทุกยี่ห้อ/เบราว์เซอร์ยังต้องให้ผู้ใช้ทดสอบบน Private LAN เอง; automated browser เป็น headless Chrome บนเครื่องนี้
- ยังไม่มี live LINE OA credential, quota จริง, provider response/429, production webhook หรือ LINE Messaging API acceptance
- GitHub Actions integration job จะทำงานเมื่อเจ้าของระบบตั้ง repository secrets ที่จำเป็นครบเท่านั้น

## Git และการอนุมัติ

ยังไม่มีการ commit/push/deploy จากงานนี้ ควรใช้ branch `phase3.5/release-readiness` แล้วเปิด Pull Request เข้า `main` หลังผู้ใช้ตรวจ diff และอนุมัติเท่านั้น ตั้ง branch protection ให้ require CI, review และห้าม force-push

ถ้ายังไม่มี remote ให้เจ้าของระบบสร้าง Private repository ก่อน แล้วตรวจชื่อจริงด้วย `git remote -v` จากนั้นจึงค่อยอนุมัติคำสั่ง `git remote add origin ...`, commit และ push แยกเป็นขั้นตอน ไม่ใช้ token ใน URL และไม่ใส่ secret ลง Git

## Deploy Staging ที่เสนอ (ยังไม่ execute)

1. ตรวจ Container/Volume เดิมและ backup checksum
2. ตั้ง environment ใน process/secret store: `DATABASE_URL`, staging admin/viewer credentials, `PERSISTENCE=postgres`, `APP_MODE=DRY_RUN`, `LINE_WEBHOOK_ENABLED=false`
3. รัน `npm run db:migrate` และตรวจ `schema_migrations`, counts และ health
4. รัน API bind loopback และ Admin Vite bind Private LAN ตาม firewall policy; ใช้ Vite proxy ไป API localhost
5. รัน Worker ด้วย `npm run worker:staging`
6. ทำ smoke login, read-only navigation, save Flex revision และ reload หลัง API restart
7. เก็บผล test/screenshot และหยุดก่อน Phase 4 live adapter
