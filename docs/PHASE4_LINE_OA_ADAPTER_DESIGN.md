# Phase 4 LINE OA Adapter Design

เอกสารนี้เป็น design ก่อนเชื่อมต่อจริง ไม่ได้เปิดใช้ credentials, outbound Messaging API หรือ Production webhook

## Boundary และ adapter

ใช้ interface เดียวต่อ OA เช่น `MessagingAdapter.send(job, oaContext)` แต่สร้าง implementation แยก `MockStagingAdapter` กับ `LineMessagingAdapter` ที่เลือกได้จาก server-side feature flag เท่านั้น ผู้ใช้เลือก OA จาก workspace เดียวกับ Campaign revision เสมอ และ adapter ต้องตรวจ `oa_id`, workspace, environment และ `mode` ก่อนส่ง

`DRY_RUN` เป็น default และ kill switch เริ่มต้นเป็นปิด (`global`, `workspace`, `oa`, `campaign/job`) หาก flag ใดปิดอยู่ adapter ต้อง return blocked result และไม่สร้าง outbound request

## Credentials

- เก็บเฉพาะ `secret_ref` ใน PostgreSQL; token/channel secret อยู่ secret manager หรือ protected environment
- Frontend รับเพียงสถานะ `configured/not configured` ไม่รับค่า secret
- แยก secret ต่อ OA และ environment; ห้ามใช้ Production secret กับ Staging
- rotation ต้องสร้าง version ใหม่, ทดสอบ health แบบไม่ส่งข้อความ และ revoke version เดิมหลังยืนยัน

## Quota, consent และ idempotency

- ตาราง quota ต่อ OA มี window, limit, used, reserved และ lock/transaction สำหรับการจองก่อนส่ง
- ตรวจ `customers.opt_in=true`, `blocked_at is null` และ consent source/time ก่อนสร้าง delivery attempt
- ใช้ `idempotency_key` ต่อ job/recipient/message และ unique constraint ป้องกันการส่งซ้ำเมื่อ worker หลายตัว
- เก็บ provider response code, retry-after, attempt count และ redacted error; ไม่เก็บ token หรือ payload ที่มีข้อมูลลับ

## Audit และ kill switch

ทุกการ approve, consent change, quota rejection, adapter selection, send attempt, provider response, retry, kill-switch change และ emergency stop ต้องเขียน audit ที่มี workspace/OA/job/actor/time แต่ redact credential และ PII ตาม policy

Kill switch ต้องมี API สำหรับ owner/admin พร้อมเหตุผล, audit, read-only status endpoint และ worker ตรวจซ้ำก่อนทุก outbound boundary ไม่พึ่ง UI เพียงอย่างเดียว

## Rollout gates

1. Implement contract + contract tests ด้วย mock provider
2. Staging `DRY_RUN` และ synthetic recipients เท่านั้น
3. User approval สำหรับ secret entry, OA mapping, quota, consent policy และ kill-switch owner
4. Provider sandbox/canary ที่ผู้ใช้ยืนยันเอง
5. แยก approval ก่อน Production credential/webhook และก่อนเปิด live adapter
