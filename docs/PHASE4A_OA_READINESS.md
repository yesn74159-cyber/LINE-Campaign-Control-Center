# Phase 4A — LINE OA Adapter Readiness (Staging)

สถานะเริ่มต้นของ Phase นี้คือ `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false` และ `LINE_WEBHOOK_ENABLED=false` ระบบจึงไม่เรียก LINE Messaging API จริงและไม่เปิด Production Webhook

## Flow ที่ใช้งานใน Staging

1. Preview Flex ใน Flex Studio
2. Validate JSON และ Campaign (`POST /api/campaigns/:id/validate`)
3. Approve โดยผู้มีสิทธิ์ approve (`POST /api/campaigns/:id/approve`)
4. เลือก Staging OA และตรวจ readiness
5. Schedule เป็น DRY_RUN เมื่อไม่มี blocker

การสร้าง OA ใน Phase 4A รับเฉพาะ `providerId`, `basicId` และ `displayName` เพื่อแยกบัญชี/Workspace metadata เท่านั้น ไม่รับ Channel Access Token หรือ Channel Secret ผ่าน Frontend และ API response ไม่ส่งค่า secret กลับ

## เชื่อมบัญชี OA ทีละขั้น

1. เตรียมข้อมูล OA ฝั่งผู้ดูแลระบบโดยเก็บ credential ใน Server secret store ตามระบบ deploy ที่ได้รับอนุมัติ ห้ามใส่ใน Source Code, Git หรือ Browser
2. เปิดหน้า Admin Staging แล้วเข้าเมนู `LINE OA`
3. กดเพิ่ม OA metadata ด้วย Provider ID, Basic ID และชื่อที่อ้างอิงได้
4. กด `Validate reference` เพื่อตรวจ readiness metadata ฝั่ง Server — ขั้นนี้ยังไม่เรียก LINE
5. ตรวจว่า Environment เป็น `STAGING`, สถานะเป็น `DRY_RUN_READY` และ Credential value ไม่ปรากฏใน UI
6. ตรวจ Campaign ใน Flex Studio: `Preview → Validate → Approve`
7. จัด Schedule และทดสอบด้วย Worker Mock เท่านั้น

Phase 4A ยังไม่ถือว่า credential ใช้งานกับ Provider จริงได้ เพราะยังไม่มี live transport และไม่มีการทดสอบ outbound call

## Policy และความปลอดภัย

- Kill switch มี 3 ระดับ: Workspace/System, OA และ Campaign
- ตรวจ approval, consent, quota และ staging rate limit ก่อน dispatch
- Error 400/401/403 ไม่ retry; 429 และ 5xx retry ได้ตาม backoff ใน policy
- เมื่อออกแบบ live transport ในอนาคต ให้ใช้ idempotency key เดิมเป็น `X-Line-Retry-Key` ของ request เดิม และหยุด retry เมื่อ provider ตอบรับการประมวลผลแล้ว ตาม [LINE retry guidance](https://developers.line.biz/en/docs/messaging-api/retrying-api-request)
- ประเภท error provider อ้างอิง [LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api/nojs/)
- การส่งข้อความจริงยังปิดอยู่ และควรพิจารณา quota/limit ตามชนิดการส่งใน [LINE sending messages guide](https://developers.line.biz/en/docs/messaging-api/sending-messages/)

## คำสั่งตรวจสอบ

```powershell
$env:APP_MODE='DRY_RUN'
$env:LINE_LIVE_ENABLED='false'
$env:LINE_WEBHOOK_ENABLED='false'
npm run test:oa
npm run test:phase4a
npm run test:integration
npm run test:phase3
npm run test:security
npm run typecheck
npm run build
```

ก่อนใช้ PostgreSQL ต้องตั้ง `DATABASE_URL` ของ Staging ใน process environment โดยไม่พิมพ์ค่าที่มี password ลง console และควรตรวจว่า database host/port เป็น loopback ของ Staging เท่านั้น

## สิ่งที่ต้องอนุมัติก่อน Phase 4B / Live

- อนุมัติ Provider/OA และ Workspace mapping ที่จะทดสอบ
- อนุมัติ secret storage และการกรอก credential โดยผู้ดูแลระบบเอง
- อนุมัติ quota, recipient scope, consent evidence และ rate limit
- อนุมัติเปิด live transport, production webhook หรือ Messaging API จริงเป็นรายขั้นตอน
- อนุมัติ commit/push/deploy แยกจากการพัฒนาในเครื่อง
