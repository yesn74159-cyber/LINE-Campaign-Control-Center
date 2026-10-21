# Phase 4B — LINE OA Connection & Delivery Safety

สถานะปัจจุบัน: **STAGING + `APP_MODE=DRY_RUN` เท่านั้น**. `LINE_LIVE_ENABLED=false` และ `LINE_WEBHOOK_ENABLED=false` เป็นค่าเริ่มต้น; ไม่มีการเรียก LINE Messaging API จริงในชุดทดสอบนี้

## สิ่งที่เพิ่ม

- `MessagingTransport` ถูกแยกเป็น `MockTransport` และ `HttpTransport` แบบ dependency injection ใน [apps/api/src/lineAdapter.ts](../apps/api/src/lineAdapter.ts)
- `MockLineMessagingAdapter` ไม่เปิด network และ `LiveLineMessagingAdapter` ปฏิเสธการสร้างใน DRY_RUN หรือเมื่อ `LINE_LIVE_ENABLED` ไม่ใช่ `true`
- OA เก็บเฉพาะ metadata และ `secret_ref` ฝั่ง server/database; API response ไม่มี token หรือ channel secret
- `outbox_deliveries` ใน [006_phase4b_outbox_ledger.sql](../db/migrations/006_phase4b_outbox_ledger.sql) บันทึกสถานะต่อ recipient, idempotency key, retry key, attempt, provider status และ request id โดยไม่เก็บ payload/secret
- การสร้าง ledger ใช้ PostgreSQL data-modifying CTE เดียวแบบ atomic และมี unique constraints ที่ `(scheduler_job_id, recipient_key)` และ `idempotency_key`
- Trigger ตรวจว่า workspace ของ job, OA และ outbox ตรงกันก่อน insert/update
- Worker กู้ stale scheduler lease และเปลี่ยน outbox ที่ค้าง `SENDING` เป็น `RETRYABLE` ก่อน claim ใหม่
- Kill switch, OA enabled state, campaign approval, consent, quota และ rate limit ถูกตรวจซ้ำก่อนเรียก adapter
- `400/401/403` ไม่ retry; `429/5xx` retry เฉพาะกรณีที่ไม่ uncertain; `429/5xx` ที่ uncertain จะถูกบันทึก `UNKNOWN` และไม่ retry อัตโนมัติ
- `HttpTransport` ส่ง `X-Line-Retry-Key` จาก ledger key; ค่า live ยังถูก lock และ endpoint จริงไม่ถูกเรียก

## คำสั่งตรวจสอบใน Staging

ตั้งค่า `DATABASE_URL` จาก container ด้วย process environment เท่านั้น โดยไม่พิมพ์ค่าออกหน้าจอ แล้วรัน:

```powershell
$env:PERSISTENCE='postgres'
$env:APP_MODE='DRY_RUN'
$env:LINE_LIVE_ENABLED='false'
$env:LINE_WEBHOOK_ENABLED='false'
npm run db:migrate
npm run test:oa
npm run test:phase4b
```

ชุด regression เดิมยังต้องผ่านด้วย `npm test`, `npm run test:security`, `npm run test:integration`, `npm run test:phase3`, `npm run test:phase4a`, `npm run typecheck`, `npm run build` และ `npm run test:e2e` โดย E2E ตั้ง `--test-concurrency=1`

## Handoff ไปการทดสอบ LINE จริงแบบจำกัด

ยังไม่อนุมัติให้ทำใน Phase 4B. ก่อนเปิดใช้งานต้องมีการอนุมัติแยกสำหรับ: credential reference ของ OA เดียว, `APP_MODE=LIVE`, `LINE_LIVE_ENABLED=true`, production endpoint, recipient/consent dataset ที่ตรวจแล้ว, quota/rate-limit budget, kill-switch owner, rollback และ monitoring. ต้องใช้บัญชีทดสอบที่ผู้ใช้ระบุและทดสอบจำนวนข้อความจำกัด พร้อมยืนยันผลจาก outbox ledger ก่อนขยาย scope

อ้างอิงข้อกำหนด retry key และการส่งข้อความจากเอกสารทางการของ LINE:

- https://developers.line.biz/en/docs/messaging-api/retrying-api-request
- https://developers.line.biz/en/reference/messaging-api/nojs/
- https://developers.line.biz/en/docs/messaging-api/sending-messages/
