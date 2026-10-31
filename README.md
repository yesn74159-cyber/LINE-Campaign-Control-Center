# LINE Campaign Control Center

Staging-first Responsive Web App + PWA สำหรับจัดการ LINE campaigns, Flex Studio, หลาย LINE OA, customer data และ scheduler โดยค่าเริ่มต้นเป็น `DRY_RUN` และไม่ส่ง LINE Messaging API จริง

## สถานะ Phase 3

Phase 3 เพิ่ม Campaign Automation Studio บน PostgreSQL Staging จริง โดยยังคง `DRY_RUN` และปิดการส่ง LINE:

- Scheduler UI เลือก OA Staging, Flex Template, เวลา และ `Asia/Bangkok` พร้อม Preview/Validation ก่อนบันทึก
- สถานะงาน `DRAFT`, `SCHEDULED`, `PAUSED`, `CANCELLED`, `COMPLETED`, `FAILED` และประวัติ Automation
- Queue Worker ใช้ PostgreSQL `FOR UPDATE SKIP LOCKED`, idempotency key, retry/backoff, audit log และ stale-lease recovery หลัง restart
- Mock LINE Messaging Adapter ตรวจว่าไม่มี outbound request และล็อก LIVE mode ใน Staging
- ทุก query ที่อ่าน/สร้างงานผูกกับ workspace ของ Admin เพื่อป้องกัน OA/campaign ข้ามบัญชี

รัน migration ที่มีอยู่และเริ่ม worker แบบปลอดภัย:

```powershell
$env:DB_TARGET='LOCAL_DEV'
$env:DB_SCHEMA='public'
# Set LOCAL_DATABASE_URL or DATABASE_URL through a local secret store; never write the value here.
$env:PERSISTENCE='postgres'
$env:APP_MODE='DRY_RUN'
$env:LINE_LIVE_ENABLED='false'
$env:LINE_WEBHOOK_ENABLED='false'
npm run test:db-connection
npm run worker:staging
```

สำหรับทดสอบ worker หนึ่งรอบใช้ `npm run worker:once`; Phase 3 integration ใช้ `npm run test:phase3` และไม่ลบข้อมูลทดสอบจาก Staging

## สถานะ Phase 3.5

เพิ่ม staging hardening ใน [db/migrations/004_phase35_staging_hardening.sql](./db/migrations/004_phase35_staging_hardening.sql): Job ต้องเป็น `DRY_RUN`, ใช้ `Asia/Bangkok`, ใช้สถานะมาตรฐาน และ Campaign revision/OA ต้องอยู่ workspace เดียวกัน นอกจากนี้เพิ่ม CSRF double-submit, workspace-scoped audit และ automated visual E2E ที่ 1280×720 กับ 390×844

อ่านผลตรวจและขอบเขตที่ยังรออนุมัติได้ที่ [docs/PHASE3.5_RELEASE_READINESS.md](./docs/PHASE3.5_RELEASE_READINESS.md) และแบบออกแบบ Phase 4 ที่ [docs/PHASE4_LINE_OA_ADAPTER_DESIGN.md](./docs/PHASE4_LINE_OA_ADAPTER_DESIGN.md)

## สถานะ Phase 2

Phase 2 เปลี่ยน Admin API ให้ใช้ PostgreSQL persistence ใน Staging และเพิ่ม:

- Admin authentication ด้วย HttpOnly session cookie และ password hash แบบ scrypt
- RBAC: `owner`, `admin`, `editor`, `reviewer`, `viewer`
- PostgreSQL migrations 001–002 และ repeatable staging seed
- Campaigns, Flex revisions, OA, Customers, Scheduler และ Audit Log ผ่าน repository จริง
- Flex revision บันทึกแล้วโหลดกลับได้หลัง restart
- LINE webhook HMAC-SHA256 verification และ `webhookEventId` deduplication
- ทุก Admin API ต้องมี session; mutation ต้องมี role ที่อนุญาต
- `PERSISTENCE=postgres`, `APP_MODE=DRY_RUN` และ `LINE_WEBHOOK_ENABLED=false` เป็น staging-safe defaults

Flex เดิมทั้ง 7 แบบใน [campaigns.json](./campaigns.json) และ [flex/](./flex/) ยังถูกเก็บไว้ ไม่แตะ LINE MINI App เดิม, LINE OA เดิม หรือ Netlify Production

## รัน Staging PostgreSQL ในเครื่อง

ต้องใช้ Node.js 20+ และ Docker Desktop:

```powershell
Copy-Item deploy/staging.env.example .env.staging
# แก้ .env.staging ในเครื่องเท่านั้น: POSTGRES_PASSWORD, DATABASE_URL, STAGING_*_PASSWORD
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d postgres

$env:DB_TARGET='LOCAL_DEV'
$env:DB_SCHEMA='public'
# ตั้ง DATABASE_URL ผ่าน process environment หรือ secret store ก่อนรัน db:setup
$env:STAGING_ADMIN_EMAIL='admin@staging.local'
$env:STAGING_ADMIN_PASSWORD='ใส่รหัสผ่านทดสอบอย่างน้อย 12 ตัวอักษร'
$env:STAGING_VIEWER_EMAIL='viewer@staging.local'
$env:STAGING_VIEWER_PASSWORD='ใส่รหัสผ่าน viewer อย่างน้อย 12 ตัวอักษร'
npm run db:setup
npm run dev:staging
```

เปิด Admin ที่ `http://127.0.0.1:5173/` และ API health ที่ `http://127.0.0.1:8787/health` จากนั้น login ด้วย admin email/password ที่ตั้งใน environment เท่านั้น

สำหรับ mock-only local UI ให้ตั้ง `MEMORY_ADMIN_PASSWORD` เป็นค่าทดสอบเฉพาะเครื่องก่อนใช้ `npm run dev` ซึ่งตั้ง `PERSISTENCE=memory` อย่างชัดเจน; ห้ามใช้โหมดนี้เป็น Staging acceptance และห้ามใช้ credential ของ Production/Cloud

สำหรับ stack เต็ม (Caddy → Admin/Nginx → API, worker แบบ private) ใช้ `docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build` หลังตั้ง `STAGING_DOMAIN`/`CADDY_TLS`; รายละเอียดและ runbook อยู่ที่ [docs/PHASE5E_STAGING_HARDENING.md](./docs/PHASE5E_STAGING_HARDENING.md)

## Vault rotation และ alert delivery

```powershell
# dry-run ก่อนเสมอ แล้วค่อย --confirm
$env:LINE_CREDENTIAL_ENCRYPTION_KEY_NEW='<base64 32 bytes>'
npm run vault:rotate
npm run vault:rotate -- --confirm

# แจ้งเตือนเมื่อมี alert (ต้องตั้ง OPS_ALERT_WEBHOOK_URL เป็น HTTPS)
npm run ops:health -- --notify
```

ขั้นตอนฉบับเต็ม, payload ที่ไม่มีความลับ, ข้อจำกัด และข้อเสนอ RLS/grant (ยังไม่ apply) อยู่ที่ [docs/PHASE5F_OPERATIONS_ROTATION_RLS.md](./docs/PHASE5F_OPERATIONS_ROTATION_RLS.md) และ SQL ข้อเสนอที่ซ้อมบน Docker แล้วอยู่ที่ [db/proposals/](./db/proposals/) (ไม่อยู่ใน migrations จึงไม่ถูก apply อัตโนมัติ)

## สถานะ Phase 4A — LINE OA Integration Readiness

Phase 4A เพิ่ม OA readiness บน Staging โดยคง `APP_MODE=DRY_RUN`:

- แยก `MockLineMessagingAdapter` และ `LiveLineMessagingAdapter`; Live ถูกล็อกด้วย `APP_MODE`/`LINE_LIVE_ENABLED` และไม่มี provider transport ใน Phase นี้
- OA metadata รองรับหลายบัญชีต่อ Workspace โดย API รับเฉพาะ identity metadata; secret value ไม่เข้า Frontend และไม่ถูกส่งกลับใน response
- เพิ่ม flow `Preview → Validate → Approve → Schedule`, quota/consent/rate policy และ kill switch ระดับ System, OA และ Campaign
- เพิ่ม provider error classification สำหรับ 400/401/403/409/429/5xx และ retry backoff โดยคง idempotency key เดิม
- เพิ่ม PostgreSQL migration `005_phase4a_oa_readiness.sql`, OA integration tests และ adapter policy tests

อ่านคู่มือทีละขั้นได้ที่ [docs/PHASE4A_OA_READINESS.md](./docs/PHASE4A_OA_READINESS.md)

## สถานะ Phase 4B — Connection & Delivery Safety

Phase 4B ยังเป็น `STAGING + DRY_RUN` และเพิ่ม [docs/PHASE4B_CONNECTION_DELIVERY_SAFETY.md](./docs/PHASE4B_CONNECTION_DELIVERY_SAFETY.md):

- Dependency injection ระหว่าง `MockTransport` และ `HttpTransport`; Live adapter สร้างไม่ได้ใน DRY_RUN หรือเมื่อ `LINE_LIVE_ENABLED` ไม่ใช่ `true`
- Outbox delivery ledger ต่อ recipient ใน migration `006_phase4b_outbox_ledger.sql` พร้อม atomic insert, unique idempotency, workspace trigger และสถานะ `SENT/RETRYABLE/FAILED/UNKNOWN`
- Worker recovery เปลี่ยน stale scheduler/outbox lease กลับเป็น retryable; provider 400/401/403 ไม่ retry และ 429/5xx ที่ไม่แน่นอนถูกเก็บ `UNKNOWN` โดยไม่ retry อัตโนมัติ
- ตรวจ campaign readiness, approval, consent, quota, rate limit, OA enabled และ kill switch ซ้ำก่อนเรียก transport
- มี `npm run test:phase4b` และ E2E รัน sequential ด้วย `npm run test:e2e`; ไม่มีการเรียก LINE Messaging API จริง

## ทดสอบ

```powershell
npm install
npm test
npm run test:security
npm run test:oa
npm run test:phase4a  # ต้องมี PostgreSQL Staging และ credentials ใน process environment
npm run test:phase4b  # Outbox, restart recovery, kill switch, retry safety และ RBAC
npm run test:e2e  # ต้องมี API/Admin ที่เปิดอยู่และ STAGING_ADMIN_PASSWORD ใน process environment
npm run test:phase5e  # CI/compose/edge assets, ops health และ guard scripts (รวม smoke กับ memory API)
npm run test:phase5f  # vault rotation, alert payload/webhook และ CLI opt-in
npm run typecheck
npm run build

# ต้องตั้ง DATABASE_URL และ seed credentials ก่อน
npm run test:integration
```

Integration tests ใน [tests/integration.test.mjs](./tests/integration.test.mjs) ตรวจ unauthenticated 401, owner login, viewer 403, invalid Flex 400, Flex revision persistence หลัง restart และ webhook HMAC/deduplication กับ PostgreSQL จริง

Security tests ใน [tests/security.test.mjs](./tests/security.test.mjs) รันแบบ in-memory เพื่อเช็ค authentication, Flex validation, HMAC tampering, deduplication และ customer opt-in โดยไม่ต้องใช้ข้อมูลหรือ credential จริง ส่วน `test:integration` ต้องมี Docker Engine/PostgreSQL Staging ที่กำลังทำงานอยู่

## Webhook safety

Webhook route คือ `/api/webhooks/line/:oaId` แต่ปิดด้วย `LINE_WEBHOOK_ENABLED=false` โดย default และต้องมี `LINE_CHANNEL_SECRET` ใน environment ของ Staging เท่านั้น ระบบตรวจ `x-line-signature` จาก raw JSON body และ dedupe ด้วย `(oa_integration_id, webhook_event_id)` ใน PostgreSQL ไม่มี production traffic หรือ outbound LINE send ใน Phase 2

## GitHub Private Repository

โฟลเดอร์นี้ยังต้องตรวจ `git status` และ `git remote -v` ก่อนเปิด PR หากยังไม่มี remote ให้สร้าง Private repository บน GitHub ด้วยบัญชีเจ้าของระบบเอง แล้วตั้ง remote ผ่านคำสั่งที่ผู้ใช้ตรวจชื่อ repository และ base branch ก่อน:

```powershell
git init
git add .
git commit -m "Build Phase 2 staging control center"
git branch -M main
git remote add origin https://github.com/<OWNER>/<PRIVATE-REPO>.git
git push -u origin main
```

ห้ามใส่ `.env`, Channel Secret, Access Token หรือ password จริงใน commit; ใช้ [`.env.example`](./.env.example) เป็น template เท่านั้น

## สิ่งที่ยังไม่เปิด

- LINE Messaging API sender และ LIVE mode ยังถูกล็อก
- LINE webhook ยังไม่เปิด production และยังไม่มีการผูก credential จริง
- official LINE Flex validation, LINE Login/OIDC และ production secret manager เป็นงานเฟสถัดไป
- Customers table พร้อมรับข้อมูลแต่ยังไม่มีข้อมูลลูกค้าจริงและไม่ใช้ข้อมูล production
