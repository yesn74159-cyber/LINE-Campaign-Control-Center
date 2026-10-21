# LINE Campaign Control Center — Deep Research และ Build-Ready Architecture

## ข้อสรุปผู้บริหาร

ผลวิจัยชี้ว่าแนวทางที่พี่วางไว้ **ทำได้จริง** และควรเดินหน้าต่อเป็นระบบเดียวที่แบ่งออกเป็นสองประสบการณ์บน Backend เดียวกัน:

**Admin Control Center** เป็น Responsive Web App + PWA ใช้ได้เต็มรูปแบบทั้ง PC และมือถือ ส่วน **Customer Experience** ใช้ LINE MINI App/LIFF สำหรับลูกค้า เปิดแคมเปญ เพิ่มเพื่อน OA ตรวจสิทธิ์ และแชร์ผ่าน LINE โดยตรง LINE MINI App เองเป็นเว็บแอป และ LIFF รองรับการ Login จาก external browser ด้วย ดังนั้นไม่จำเป็นต้องสร้าง Windows App และ Android App คนละชุดตั้งแต่ต้น. citeturn22view3turn18search18

สถาปัตยกรรมที่ผมเลือกคือ:

```text
                     LINE Platform
              ┌──────────┴───────────┐
              │                      │
       LINE MINI App             Messaging API
       / LINE Login               + Webhooks
              │                      │
              ▼                      ▼
┌────────────────────┐      ┌────────────────────┐
│ Customer MINI App  │      │ Webhook Endpoint   │
│ React + TS + LIFF  │      │ raw HMAC verify    │
└─────────┬──────────┘      └──────────┬─────────┘
          │                            │
          └────────────┬───────────────┘
                       ▼
              ┌─────────────────┐
              │ Fastify API     │
              │ TypeScript      │
              │ RBAC / Auth     │
              └───────┬─────────┘
                      │
            ┌─────────┴──────────┐
            ▼                    ▼
   ┌────────────────┐    ┌──────────────────┐
   │ PostgreSQL     │    │ Durable Worker   │
   │ Drizzle ORM    │◄──►│ Scheduler/Send   │
   │ Job Queue      │    │ Retry/Dedup      │
   └────────────────┘    └────────┬─────────┘
                                  │
                                  ▼
                           LINE Messaging API

                  ▲
                  │
       ┌──────────┴────────────┐
       │ Admin Web / PWA       │
       │ PC + Mobile           │
       │ React + TypeScript    │
       └───────────────────────┘
```

**คำตัดสินหลัก:** ผมไม่แนะนำให้ใช้ Netlify Scheduled Functions เป็นตัวส่งข้อความหลัก เพราะ Scheduled Functions มี execution limit 30 วินาทีและทำงานตาม schedule เฉพาะ published deploy; เหมาะกว่าในฐานะ heartbeat/enqueue trigger แต่ไม่ควรเป็น durable sender ของระบบส่งแคมเปญ. citeturn16view5

สำหรับ MVP ให้ใช้ **PostgreSQL เป็นทั้งฐานข้อมูลและ durable job queue** ก่อน จึงยังไม่ต้องเพิ่ม Redis/BullMQ ทำให้ระบบและค่าใช้จ่ายง่ายกว่า เมื่อปริมาณงานโตมากค่อยแยก queue layer ภายหลัง

และคำตอบของคำถามก่อนหน้านี้คือ:

| สิ่งที่พี่อยากทำ | ทำได้ไหม | วิธีที่ถูกต้อง |
|---|---:|---|
| ใช้ทั้ง PC + มือถือ | ✅ | Responsive Admin PWA + MINI App |
| Login LINE อีกบัญชีบน PC | ✅ | LINE Login/external browser |
| ใช้ LINE บัญชีส่วนตัวหลายบัญชีทดสอบ | ✅ มีเงื่อนไข | Logout/re-auth; Developing ต้องเป็น tester/role ที่อนุญาต |
| จัดการหลาย LINE OA | ✅ | OA integrations ใน Backend |
| เปลี่ยน OA ที่ใช้ “ส่งแคมเปญ” | ✅ | เลือก `oa_id` ก่อนสร้าง/ส่ง Campaign |
| เปลี่ยน native OA ของ MINI App ไทยจาก dropdown ตามแคมเปญ | ❌ ไม่ควรออกแบบแบบนั้น | Thailand ยังไม่มี multi-OA add-friend แบบ Japan |
| ตั้งเวลาให้ OA ส่งเอง | ✅ | Scheduler + Messaging API |
| ตั้งเวลาให้ LINE ส่วนตัว DM เพื่อนเอง | ❌ | เตือนได้ แต่เจ้าของบัญชีต้องเปิด Share Target Picker และเลือกผู้รับ |
| Flex Studio แบบไม่แก้ JSON | ✅ | Form editor + Preview + LINE validation API |
| คูปองจริง/สิทธิ์หนึ่งคนหนึ่งครั้ง | ✅ | Backend transaction + verified LINE identity |
| Dashboard/CRM/Report | ✅ | Webhook + DB + Insight API |

LINE มี Messaging API สำหรับ push, multicast, narrowcast และ broadcast และมี API สำหรับตรวจจำนวนข้อความ/สถิติ รวมถึง endpoint สำหรับ validate message object ก่อนส่งจริง จึงมีพื้นฐานทาง API ครบสำหรับ Control Center ลักษณะนี้. citeturn20search4turn21view2turn20search0

## ผล Audit ระบบเดิม

ผมเปิดไฟล์ `LINE_Campaign_Control_Center_Deep_Research_Master_Prompt_TH.md` และแตก `LINE_Flex_Templates_Collection_v4.zip` ตรวจของจริงใน workspace แล้ว ไม่ได้อาศัยเฉพาะคำอธิบายใน Prompt

ZIP มีโครงสร้างที่ระบุไว้จริง ได้แก่:

```text
index.html
app.js
core.mjs
config.js
campaigns.json

flex/
  welcome.json
  activity.json
  news.json
  flash.json
  gradient.json
  purple.json
  profile.json

ready-json/
assets/
tests/core.test.mjs
styles.css
README_TH.md
```

ผมรัน:

```text
node --test tests/core.test.mjs
```

ผลเป็น:

```text
tests       12
pass        12
fail        0
cancelled   0
skipped     0
```

จึงจัดสถานะ baseline ได้ดังนี้:

| รายการ | สถานะวิจัย | ผล |
|---|---|---|
| Flex Collection 7 templates | **VERIFIED** | มีจริงใน ZIP |
| Unit tests | **VERIFIED** | 12/12 PASS |
| LIFF ID `2012104116-08P8b7g6` | **VERIFIED IN SOURCE** | อยู่ใน `config.js` |
| OA `@453yfyvc` | **VERIFIED IN SOURCE** | อยู่ใน `config.js` |
| Add Friend `lin.ee/Ql6Lqk2` | **VERIFIED IN SOURCE** | อยู่ใน `config.js` |
| Environment | **VERIFIED IN SOURCE** | `DEVELOPING` |
| Real rewards | **VERIFIED IN SOURCE** | `false` |
| Backend | **VERIFIED ABSENT** | เป็น static frontend |
| Admin authentication | **VERIFIED ABSENT** | ไม่มี server authorization |
| Database | **VERIFIED ABSENT** | ไม่มี DB |
| Scheduler | **VERIFIED ABSENT** | ไม่มี worker/job queue |
| Flex editor persistence | **VERIFIED** | `localStorage` |
| Friendship | **VERIFIED IN CODE** | `liff.getFriendship()` |
| Add friend dialog | **VERIFIED IN CODE** | `liff.requestFriendship()` |
| Personal share | **VERIFIED IN CODE** | `liff.shareTargetPicker()` |
| Test D แยกจากระบบนี้ | **USER-REPORTED / DESIGN CONSTRAINT** | ห้ามแตะ |
| Provider `7632464` | **USER-REPORTED** | ยังไม่ได้ยืนยันจาก Console |

เว็บที่ deploy ไว้มีหน้าทดสอบ MINI App/Flex จริง แต่สิ่งที่มีปัจจุบันยังเป็น **prototype ฝั่ง client** ไม่ใช่ Campaign Control Center แบบหลายผู้ใช้ เนื่องจาก campaign/Flex override ถูกบันทึกใน browser-local `localStorage` และยังไม่มีระบบกลางสำหรับ revisions, approval, recipient state, jobs หรือ audit trail

มีอีกจุดหนึ่งที่ดี: baseline โหลด LIFF SDK ผ่าน edge path ของ LINE ทำให้ได้รับ SDK รุ่นอัปเดตอัตโนมัติ ปัจจุบัน LINE ประกาศเลิกใช้ LIFF 2.31.0 เพราะประเด็นด้านความปลอดภัย และระบุให้อัปเดตเป็น 2.31.1 ขึ้นไป; LINE ยังเปลี่ยนพฤติกรรม URL query ตั้งแต่ 2.31.2 เมื่อ 7 ตุลาคม 2026. citeturn17view2

ในการสร้างแอปใหม่ ผมแนะนำให้เปลี่ยนเป็น dependency ที่ pin เวอร์ชัน LIFF ที่ไม่ deprecated แทนการพึ่ง edge รุ่นล่าสุดแบบไม่มี lock เพื่อให้ CI/Staging/Production ใช้เวอร์ชันเดียวกัน และทำ dependency-update PR เป็นรอบ ๆ

อีกประเด็นที่ต้องแก้ตั้งแต่ UI ใหม่คือ Android LINE 26.3.0 ขึ้นไปใช้ edge-to-edge แล้ว ทำให้ปุ่มล่างของ LIFF/MINI App อาจซ้อน navigation bar; LINE ขอให้แอปรองรับ safe-area โดยตรง. citeturn17view3

ดังนั้น Customer MINI App ใหม่ควรมีอย่างน้อย:

```css
padding-bottom:
  max(
    env(safe-area-inset-bottom),
    var(--android-safe-area-inset-bottom, 0px)
  );
```

### สิ่งที่ควรเก็บจากโค้ดเดิม

**ไม่ควรเขียนใหม่หมด** ครับ

ควร port ต่อทันที:

- campaign manifest concept
- Flex templates ทั้ง 7
- placeholder/URI/image validation ที่มีอยู่
- deep-link generation
- template compilation
- friendship/share flow
- unit tests เดิมทั้ง 12
- visual assets

แต่ validation ใน `core.mjs` ควรถือเป็น **local guard** ไม่ใช่ตัวแทน official LINE validation ทั้งหมด เพราะ LINE มี Messaging API endpoints สำหรับ validate message objects จริงโดยไม่ต้องส่งข้อความจริง. citeturn20search0turn20search10

Flow ที่ถูกต้องจึงควรเป็น:

```text
Form Validation
      ↓
Local Flex Validation
      ↓
Generate Message Object
      ↓
Server-side Policy Check
      ↓
LINE /validate/... API
      ↓
Preview
      ↓
Publish immutable revision
```

## ข้อเท็จจริง LINE ที่เปลี่ยนการออกแบบ

### PC กับมือถือใช้ระบบเดียวกันได้ แต่ความสามารถไม่เท่ากัน

LINE MINI App เป็นเว็บแอป และ LIFF รองรับการเปิดใน external browser รวมถึง LINE Login จาก external browser; `withLoginOnExternalBrowser` สามารถใช้ให้เริ่ม login อัตโนมัติได้ด้วย. citeturn22view3turn18search18

ดังนั้นบน PC เราทำ:

```text
Chrome / Edge
     ↓
Admin PWA
     ↓
LINE Login
     ↓
Backend session + RBAC
```

ได้ตามปกติ

แต่ **อย่าออกแบบ Admin ทั้งระบบให้ขึ้นกับ `liff.isInClient()`** เพราะ API บางชนิดมีความหมายเฉพาะ LINE client/mobile environment ให้ Admin เป็นเว็บมาตรฐาน ส่วน MINI App ค่อยตรวจ feature availability ด้วย LIFF runtime

### Login ด้วย LINE อีกบัญชีทำได้

สำหรับ web app LINE Login รองรับการ authenticate LINE account ผ่าน OpenID Connect และเมื่อ Backend ได้ ID token จาก client จะต้อง verify token ก่อนเชื่อถือข้อมูลผู้ใช้; LINE ยังแนะนำโดยตรงว่าให้ส่ง raw token ไปตรวจที่ server แทนส่ง user ID/profile ที่ client อ้างเอง. citeturn18search3turn18search0turn18search8

ดังนั้น Admin PC ควรมี:

```text
ออกจากระบบ
     ↓
revoke/end local session
     ↓
Login with LINE
     ↓
server verifies token
     ↓
map LINE identity -> admin_user
     ↓
check workspace role
```

ในสถานะ **Developing** บัญชีที่ใช้ทดสอบ LINE Login ต้องเป็นบัญชีที่ได้รับ role สำหรับ channel และ Business ID ต้อง link กับ LINE account ที่ใช้ทดสอบ ส่วน Production/Published จึงเป็น flow สำหรับผู้ใช้ทั่วไป. citeturn18search14

และที่สำคัญมากคือ **LINE Login สำเร็จไม่ได้แปลว่าเป็น Admin** ผู้ใช้ต้องมี record ใน `workspace_memberships` และ Backend ต้องตรวจ role ทุก request

### Multi-OA ทำได้ แต่ต้องแยก “OA ที่ส่ง” กับ “OA ที่ MINI App ผูก”

นี่คือจุดที่สำคัญที่สุดของการวิจัยรอบนี้

LINE ระบุว่า user ID ของคนเดียวกันจะ **ต่างกันเมื่ออยู่คนละ Provider** แต่ถ้า channel อยู่ใต้ Provider เดียวกัน user ID จะเหมือนกันข้าม LINE Login/Messaging API channel. citeturn22view0

และเมื่อเปิด Messaging API ให้ OA แล้ว Provider ที่เลือก **เปลี่ยนหรือถอดไม่ได้ภายหลัง** LINE เตือนให้เลือก Provider ให้ถูกตั้งแต่ต้น. citeturn22view1

ดังนั้น key ของลูกค้า **ห้าม** เป็นเพียง:

```text
line_user_id
```

ต้องเป็นอย่างน้อย:

```text
(provider_id, line_user_id)
```

สำหรับหลาย OA:

```text
Workspace
   │
   ├── OA A
   │    └── Provider X
   │
   ├── OA B
   │    └── Provider X
   │
   └── OA C
        └── Provider Y
```

A และ B อาจจับ identity เดียวกันได้เพราะอยู่ Provider เดียวกัน แต่ C ต้องถือเป็น identity คนละ namespace เว้นแต่มี lawful/account-linking mechanism อื่นที่ผู้ใช้ยินยอม

### ข่าวใหม่มากของปี 2026: LINE รองรับ native multi-OA ใน MINI App แล้ว แต่ยังใช้กับไทยไม่ได้

เดือนกันยายน 2026 LINE เปิดความสามารถให้ MINI App เลือกจากหลาย OA ใน add-friend flow ได้ และ allowlist ได้สูงสุด 1,000 OA **แต่ข้อกำหนดปัจจุบันคือต้องตั้ง Region ของ MINI App เป็น Japan**. citeturn22view2turn17view2

สำหรับ MINI App ประเทศไทยของเรา จึง **ไม่ควรออกแบบ** ว่า:

> เลือก OA B จาก dropdown ใน Admin → `getFriendship()` ใน MINI App จะสลับเป็น OA B

นี่ไม่ใช่พฤติกรรมที่รองรับสำหรับ Thailand ในเอกสารปัจจุบัน

สำหรับไทย LINE ระบุให้ตั้ง Linked LINE Official Account ใน MINI App channel และ Messaging API channel กับ MINI App channel ต้องอยู่ Provider เดียวกัน. citeturn22view2

สถาปัตยกรรมจึงต้องแยก:

```text
Admin OA selector
       │
       ├─ controls Messaging API sender ✅
       └─ does NOT silently reconfigure
          native MINI App friendship OA ❌
```

แคมเปญของ OA อื่นยังสามารถใช้ `add_friend_url` ของ OA นั้นเป็น external CTA ได้ แต่ถ้าธุรกิจต้องการ `getFriendship()` แบบ native สำหรับ OA หลายตัวในไทยจริง ๆ จะต้องออกแบบช่องทาง/LINE MINI App channels ตามข้อจำกัดของ LINE แทนการหลอกด้วย dropdown

และ ณ วันที่วิจัย 20 ตุลาคม 2026 ยังมีเหตุการณ์ล่าสุดอีกอย่าง: ส่วนหนึ่งของ multi-OA feature ใน Japan ถูก LINE ระงับชั่วคราวตั้งแต่ 15 กันยายน โดยการเปลี่ยน OA บน consent screen ผ่าน `prompt_bot_id` ยังถูกระงับ และ LINE อัปเดตวันที่ 16 ตุลาคมว่าคาดว่าจะกลับมา “ต้นเดือนพฤศจิกายน 2026”. citeturn17view2

สำหรับไทยเรื่องนี้ไม่กระทบ MVP โดยตรง แต่แสดงให้เห็นว่าการทำ abstraction ฝั่งเราเองเหนือ LINE config เป็นสิ่งจำเป็น

### Personal LINE Share กับ Automation ต้องแยกกันเด็ดขาด

`liff.shareTargetPicker()` แสดงหน้าจอให้ **ผู้ใช้เลือกผู้รับเอง** จากเพื่อน กลุ่ม หรือแชท และข้อความจะปรากฏเสมือนส่งโดยผู้ใช้เอง. citeturn16view1

ดังนั้นระบบสามารถทำ:

```text
21:00 Reminder
"มีแคมเปญที่พี่ตั้งใจแชร์"
        ↓
พี่กด Open
        ↓
Share Target Picker
        ↓
พี่เลือกผู้รับ
        ↓
พี่ยืนยัน
```

แต่ไม่ทำ:

```text
21:00
Backend เลือกเพื่อนส่วนตัวของพี่
        ↓
ส่ง DM อัตโนมัติ
```

ส่วน **LINE OA** ต่างกัน เพราะ Messaging API รองรับ push, multicast, narrowcast และ broadcast จาก server ได้ จึงตั้งเวลา Automation จริงได้. citeturn20search4

### Friendship และคูปองต้องเชื่อ Backend

`liff.requestFriendship()` มีไว้เปิดหน้าต่างให้เพิ่ม/ปลดบล็อก OA และหลังปิด dialog ควรตรวจสถานะอีกครั้ง; linked/default OA เป็นตัวกำหนดเป้าหมายเมื่อไม่ได้ใช้ความสามารถ multi-account. citeturn17view0turn22view2

แต่ reward จริงไม่ควรเชื่อเพียงค่าที่ client ส่งมา

Flow ที่ผมเลือกคือ:

```text
LIFF
 │
 ├─ get raw LINE token
 │
 ▼
Backend
 │
 ├─ verify token with LINE
 ├─ derive trusted Provider-scoped user ID
 ├─ check campaign
 ├─ check OA relationship / eligibility
 ├─ transaction: has this user claimed?
 │
 └─ issue reward
```

LINE แนะนำให้ server ตรวจ raw token แทนเชื่อข้อมูล user/profile จาก client โดยตรง. citeturn18search8turn18search15

อีกอย่างที่ค้นเจอเพิ่มเติมคือ Messaging API ปัจจุบันมี **Coupon API อย่างเป็นทางการ** สามารถสร้าง coupon แล้วส่งผ่าน Messaging API ได้ และมีข้อมูลการดู/ใช้งานบางส่วน ดังนั้น Phase 2 สามารถเลือกได้ว่าจะใช้ “คูปองภายในระบบเรา” หรือ LINE Coupon เป็น distribution layer. citeturn20search12

## สถาปัตยกรรมที่แนะนำ

### Monorepo

ผมแนะนำโครงสร้างนี้:

```text
line-campaign-control-center/
│
├─ apps/
│  ├─ admin-web/
│  ├─ customer-miniapp/
│  ├─ api/
│  └─ worker/
│
├─ packages/
│  ├─ db/
│  ├─ contracts/
│  ├─ flex/
│  ├─ line/
│  ├─ ui/
│  └─ testing/
│
├─ infra/
│  ├─ docker/
│  ├─ migrations/
│  └─ deploy/
│
└─ .github/workflows/
```

เทคโนโลยี:

| Layer | Decision |
|---|---|
| Admin | React + TypeScript + Vite |
| PWA | Vite PWA/service worker เฉพาะ Admin |
| Customer | React + TypeScript + LIFF |
| Backend | Node.js + TypeScript + Fastify |
| DB | PostgreSQL |
| ORM | Drizzle |
| Queue MVP | PostgreSQL durable jobs |
| Frontend hosting | Netlify |
| API/Worker | Persistent container/VPS |
| CI | GitHub Actions |
| Time | DB UTC, UI `Asia/Bangkok` |
| Secret storage | server-only env/secret manager |
| Observability | structured logs + job/event correlation IDs |

ผม **ไม่แนะนำให้ Customer MINI App พึ่ง PWA offline/service worker เป็น core requirement** เพราะ LINE MINI App มี lifecycle และ browser context ของ LINE เอง จุดที่ควรเป็น PWA จริงคือ Admin ที่พี่ใช้งานบน PC/มือถือ

### Stack ที่เปรียบเทียบ

**ทางเลือก A — Managed-first**

```text
Netlify
  +
Supabase PostgreSQL/Auth/Storage
  +
Managed Worker / App Platform
```

Supabase Pro ปัจจุบันเริ่ม $25/เดือน รวม 100,000 MAU, 8 GB disk, 250 GB egress และ daily backups 7 วัน พร้อม compute credit $10 สำหรับ Micro instance. citeturn19search3

ข้อดีคือดูแลง่าย สำรองฐานข้อมูลง่าย และโตง่ายกว่า แต่ต้นทุนเริ่มต้นสูงกว่า self-host เล็กน้อย และ architecture กระจายหลาย vendor

**ทางเลือก B — Lean production**

```text
Netlify frontend
        +
DigitalOcean/VPS
 ├─ Fastify API
 ├─ Worker
 └─ PostgreSQL
```

DigitalOcean Basic Droplet ปัจจุบันมี 2 GB / 1 vCPU ที่ $12/เดือน, 2 GB / 2 vCPU ที่ $18 และ 4 GB / 2 vCPU ที่ $24; หากใช้ Managed PostgreSQL แยก จะเริ่มประมาณ $15.15/เดือนสำหรับ 1 GB instance. citeturn19search0turn19search1

DigitalOcean App Platform ก็มี shared container เริ่ม $5/เดือนสำหรับ 512 MB และ $10/เดือนสำหรับ 1 GB จึงเป็นอีกตัวเลือกสำหรับ API/worker หากไม่อยาก patch VPS เอง. citeturn19search6

**คำแนะนำของผมสำหรับเรา:** เริ่ม MVP ด้วย Managed Postgres + containerized API/worker หรือ single VPS staging แล้วค่อยแยก DB เมื่อเริ่มส่งจริงจำนวนมาก หากเป้าหมายอันดับหนึ่งคือ “เร็วและไม่อยากดู server” ให้เลือก Supabase + managed worker; หากเป้าหมายคือ “ประหยัดและควบคุมได้” ให้ VPS + PostgreSQL ก่อน

ไม่ควรประหยัดโดยเอา critical sender ไว้ใน short-lived scheduler อย่างเดียว เพราะ automation ต้องรับมือ process crash, retry และ concurrent workers ได้

## ฐานข้อมูล API และ Automation

### ERD หลัก

```text
workspaces
    │
    ├── workspace_memberships ── admin_users
    │
    ├── providers
    │      │
    │      ├── oa_integrations
    │      │       │
    │      │       ├── oa_contacts
    │      │       └── webhook_events
    │      │
    │      └── line_identities
    │
    ├── flex_templates
    │      └── flex_template_revisions
    │
    ├── campaigns
    │      └── campaign_revisions
    │               │
    │               ├── approvals
    │               └── schedules
    │                       └── send_jobs
    │                               └── send_attempts
    │
    ├── reward_definitions
    │      └── reward_claims
    │
    └── audit_logs
```

หลักการสำคัญคือ **ทุก Campaign revision ต้อง immutable หลัง approval**

ตัวอย่าง:

```text
Campaign "โปรตุลาคม"
       │
       ├─ Draft revision 7
       │
       └─ Published revision 8
             ├─ OA = OA-02
             ├─ Flex revision = 14
             ├─ Audience snapshot
             ├─ CTA snapshot
             ├─ Image snapshot
             └─ send config snapshot
```

ต่อให้วันพรุ่งนี้พี่แก้ Template ต้นฉบับ Scheduler ของวันเก่าก็ยังรู้แน่นอนว่าเคยอนุมัติอะไรไว้

### Multi-OA model

แต่ละ OA มี record ประมาณ:

```ts
{
  id,
  workspaceId,
  providerId,
  basicId,
  messagingChannelId,
  addFriendUrl,
  tokenSecretRef,
  channelSecretRef,
  status,
  liveSendEnabled
}
```

**ไม่มี access token หรือ channel secret ถูกส่งกลับ frontend**

ทุก Campaign บังคับมี:

```text
campaign.oa_id NOT NULL
```

ช่วยแก้ปัญหาที่พี่ถามว่า “เวลาเปลี่ยน LINE OA ล่ะ?”

UI จะเป็น:

```text
สร้างแคมเปญ
   ↓
เลือก OA
   ↓
OA: HEE Turbo
   ↓
Flex / Audience / Schedule
```

ถ้าเปลี่ยน OA หลังสร้าง revision แล้ว ระบบต้องสร้าง **revision ใหม่** ไม่แก้ snapshot เดิม

### Webhook pipeline

LINE กำหนดให้ Webhook signature ตรวจด้วย HMAC-SHA256 โดยใช้ exact raw request body; หาก parse หรือแก้ JSON ก่อนตรวจ signature อาจทำให้ verification ล้มเหลว และ LINE ไม่เผยแพร่ IP ต้นทาง webhook เพื่อให้ใช้ signature verification เป็นหลัก. citeturn16view2turn20search16

ดังนั้น:

```text
POST webhook
   ↓
read RAW bytes
   ↓
HMAC-SHA256
   ↓
constant-time compare X-Line-Signature
   ↓
JSON.parse
   ↓
INSERT webhookEventId
   ↓
duplicate?
 ┌─yes─────────────┐
 │ ACK 200         │
 │ no side-effect  │
 └─────────────────┘
   ↓ no
follow/unfollow/message/postback
   ↓
update contact/event state
   ↓
ACK quickly
```

LINE ระบุเองว่า webhook เดียวกันอาจถูกส่งมากกว่าหนึ่งครั้ง และเมื่อ redelivery เกิด ลำดับ events ก็อาจไม่เหมือนลำดับจริง จึงต้อง deduplicate ด้วย `webhookEventId` และพิจารณา `timestamp`; `deliveryContext.isRedelivery` ใช้บอก redelivery ได้. citeturn16view3

### Scheduler

State machine ที่ผมกำหนด:

```text
DRAFT
  ↓
PREVIEWED
  ↓
DRY_RUN_READY
  ↓
AWAITING_APPROVAL
  ↓
APPROVED
  ↓
SCHEDULED
  ↓
CLAIMED
  ↓
SENDING
  ↓
COMPLETED
```

ทางออก:

```text
PAUSED
CANCELED
FAILED_RETRYABLE
FAILED_FINAL
```

Worker ใช้รูปแบบ:

```sql
SELECT ...
FROM send_jobs
WHERE state IN ('queued','retryable')
  AND available_at <= now()
ORDER BY available_at
FOR UPDATE SKIP LOCKED
LIMIT ...
```

เพื่อให้หลาย worker claim งานคนละ row ได้โดยไม่รอกัน ซึ่งสอดคล้องกับ semantics ของ PostgreSQL row locking/`SKIP LOCKED` และเหมาะกับ queue-like table. นี่เป็นข้อเสนอทางสถาปัตยกรรมจากคุณสมบัติ locking ของ PostgreSQL ไม่ใช่ข้อกำหนดของ LINE

### ป้องกันส่งซ้ำสองชั้น

ชั้นเรา:

```text
UNIQUE execution_key
```

ชั้น LINE:

```http
X-Line-Retry-Key: <UUID>
```

LINE แนะนำให้ใส่ retry key ตั้งแต่ request แรกของ push/multicast/narrowcast/broadcast เมื่อจะรองรับ retry; retry key มีระยะจัดการ 24 ชั่วโมง และ request ซ้ำที่เคย accepted แล้วจะตอบ `409`. ควร retry เฉพาะ timeout/5xx ไม่ใช่ 2xx หรือ 4xx ปกติ และใช้ exponential backoff. citeturn16view4turn21view5

จึงไม่ทำ:

```text
LINE timeout
   ↓
generate NEW retry key
   ↓
send again        ❌
```

แต่ทำ:

```text
ก่อนส่งครั้งแรก
   ↓
persist retry key
   ↓
LINE timeout
   ↓
retry SAME payload + SAME retry key
```

### Quota และ preflight

ก่อนทุก LIVE job:

```text
✓ OA connection healthy
✓ LIVE enabled at workspace
✓ LIVE enabled at OA
✓ revision approved
✓ Flex validates
✓ audience eligible
✓ opt-out excluded
✓ correct Provider
✓ quota available
✓ kill switch off
✓ schedule not canceled
```

Messaging API มี API สำหรับตรวจ quota/consumption และจำนวนข้อความส่งแล้วได้ และข้อจำกัด rate limit เป็น per endpoint/per channel. citeturn21view2turn21view4

อย่าคิดว่า HTTP `200` หมายถึงผู้รับเห็นข้อความเสมอ: สำหรับ push LINE ระบุว่าบางกรณี เช่นผู้ใช้บล็อก OA หรือไม่ได้เป็นเพื่อนตามเงื่อนไข อาจตอบ `200` แต่ข้อความไม่ได้ถึงผู้ใช้. citeturn20search2

### สิ่งที่ Automation ทำเพิ่มได้

นอกจาก “ตั้งเวลาบรอดแคสต์” ผมออกแบบระบบต่อยอดได้ถึง:

```text
Follow OA
   ↓
Wait 5 min
   ↓
Welcome Flex

Claim coupon
   ↓
tag customer
   ↓
Wait 3 days
   ↓
Reminder

Campaign A clicked
   ↓
put into segment A
   ↓
send follow-up

Unfollow
   ↓
disable outbound eligibility

Birthday / expiry / service reminder
   ↓
schedule personalized push

No activity X days
   ↓
re-engagement workflow
```

แต่ทุก journey ต้องอยู่ภายใต้ recipient eligibility, quota และ consent ที่เหมาะสม ไม่ใช่การดึงรายชื่อเพื่อนส่วนตัวมาใช้

LINE OA ไทยปัจจุบันมีแพ็กเกจอ้างอิงที่หน้า LINE for Business ระบุ Free 300 ข้อความ/เดือน, Basic 15,000 ข้อความที่ 1,280 บาท และ Pro 35,000 ข้อความที่ 1,780 บาท พร้อมค่าข้อความเพิ่มตามแพ็กเกจ ดังนั้น Scheduler ต้องมี **cost/quota guard ก่อน LIVE** ไม่ใช่ปล่อย campaign ใหญ่ส่งก่อนแล้วค่อยรู้ทีหลัง. citeturn21view0turn21view3

ราคานี้เป็นข้อมูล ณ วันที่ตรวจและสามารถเปลี่ยนได้ จึงควร query quota จาก API/runtime และไม่ hard-code plan assumptions

## หน้าจอ สิทธิ์ และการทดสอบ

### Admin PC

สำหรับจอประมาณ 1440×900:

```text
┌────────────────────────────────────────────────────────┐
│ Workspace        OA: @xxxx ▼      DRY RUN     👤 Admin │
├────────────┬───────────────────────────────────────────┤
│ Dashboard  │  วันนี้                                  │
│ OAs        │  ┌─────────┐ ┌─────────┐ ┌────────────┐ │
│ Campaigns  │  │Friends  │ │Messages │ │Next Job    │ │
│ Flex       │  └─────────┘ └─────────┘ └────────────┘ │
│ Audience   │                                           │
│ Scheduler  │  Upcoming jobs                            │
│ Customers  │  10:00  Campaign A   DRY_RUN             │
│ Rewards    │  18:00  Campaign B   WAIT APPROVAL       │
│ Reports    │                                           │
│ Audit Log  │  [ + Create Campaign ]                    │
│ Settings   │                                           │
└────────────┴───────────────────────────────────────────┘
```

### Mobile Admin

ประมาณ 390×844:

```text
┌─────────────────────┐
│ Campaign Control    │
│ OA: HEE Turbo ▼     │
│ 🟡 DRY RUN          │
├─────────────────────┤
│ Next send           │
│ วันนี้ 18:00        │
│ Flash Sale          │
│                     │
│ [Preview] [Pause]   │
├─────────────────────┤
│ Drafts       3      │
│ Waiting      1      │
│ Scheduled    2      │
├─────────────────────┤
│ Home Campaign Time  │
│ OA          More    │
└─────────────────────┘
```

การออกแบบ Mobile จะเน้นงานที่เจ้าของต้องทำทันที:

**เลือก OA → แก้ข้อความ/ภาพ → Preview → Approve → Schedule → Pause/Cancel**

ส่วนข้อมูลเยอะอย่าง Audience Builder, event log และ report table ใช้ PC จะสะดวกกว่า แต่เปิดมือถือได้ทั้งหมด

### Flex Studio

พี่ไม่ต้องเห็น JSON ในการใช้งานปกติ

```text
Template: Flash Gradient
┌─────────────────────┬───────────────────────┐
│ Form                │ LINE Preview          │
│                     │                       │
│ หัวข้อ              │   🔥 FLASH SALE      │
│ [_______________]   │                       │
│                     │   SALE 50% OFF       │
│ รายละเอียด          │                       │
│ [_______________]   │   [ Shop Now ]       │
│                     │                       │
│ สี [■]              │                       │
│ รูป [Upload]        │                       │
│ ปุ่ม [_________]    │                       │
│ URL  [_________]    │                       │
│                     │                       │
│ [Save Draft]        │                       │
│ [Validate]          │                       │
└─────────────────────┴───────────────────────┘
```

Advanced JSON Mode มีได้ แต่ซ่อนหลัง “โหมดผู้เชี่ยวชาญ”

ก่อน Publish ระบบเรียก official LINE message validation endpoint ซึ่งตรวจ message object ได้โดย **ไม่ต้องส่งข้อความและไม่กินจำนวนการส่ง**. citeturn20search10turn20search2

### Permission matrix

| Action | Owner/Admin | Editor | Reviewer | Viewer |
|---|:---:|:---:|:---:|:---:|
| ดู Dashboard | ✅ | ✅ | ✅ | ✅ |
| แก้ Flex Draft | ✅ | ✅ | ✅ | ❌ |
| สร้าง Campaign | ✅ | ✅ | ✅ | ❌ |
| Publish revision | ✅ | ✅ | ✅ | ❌ |
| Approve LIVE | ✅ | ❌ | ✅ | ❌ |
| Schedule DRY RUN | ✅ | ✅ | ✅ | ❌ |
| Schedule LIVE | ✅ | ❌ | ✅* | ❌ |
| Add/remove OA | ✅ | ❌ | ❌ | ❌ |
| Kill switch | ✅ | ❌ | ✅ | ❌ |
| Export PII | ✅ | ❌ | ตาม policy | ❌ |

`*` ต้องมี workspace policy อนุญาต

### Test Gate

ก่อนแตะ Production ต้องผ่านอย่างน้อย:

| Test | เกณฑ์ |
|---|---|
| Baseline Flex | 7 templates compile |
| Existing behavior | port 12 tests แล้ว PASS |
| Admin auth | token ปลอม/expired ถูกปฏิเสธ |
| RBAC | Viewer mutate ไม่ได้ |
| Webhook HMAC | body จริง PASS |
| Modified webhook | FAIL |
| Webhook replay | side effect ครั้งเดียว |
| Provider identity | ไม่ merge ข้าม Provider |
| Flex official validate | invalid Flex ถูก block |
| Scheduler concurrency | worker 2 ตัวไม่ส่ง job ซ้ำ |
| Restart | job กลับมาทำต่ออย่างปลอดภัย |
| Cancel race | cancel แล้วไม่เกิด external send |
| Kill switch | หยุดก่อน next batch |
| Timeout/5xx | retry same retry key |
| 4xx | ไม่ retry |
| Quota exceeded | block before live |
| Timezone | เวลาไทยตรงหลัง UTC conversion |
| Desktop | Chrome + Edge |
| Mobile web | responsive |
| Android LINE | safe-area ไม่บัง CTA |
| External browser | LINE login สำเร็จ |
| Share Target Picker | ทดสอบด้วยเพื่อนจริง ≥ 1 |
| DRY RUN | network outbound to LINE send API = 0 |

Share Target Picker ต้องทดสอบกับเพื่อนจริงอย่างน้อยหนึ่งคน เพราะ API ให้ผู้ใช้เลือก recipient และ LINE ไม่เปิดเผยรายละเอียด recipient ให้ระบบเราแบบที่ควรใช้เป็นฐาน CRM ส่วนตัว. citeturn16view1

## แผนพัฒนา ต้นทุน ความเสี่ยง และ Handoff

### ลำดับพัฒนาที่เร็วที่สุด

ผมแบ่งเป็น PR เล็กแทนการให้ agent สร้างทั้งโปรเจกต์ก้อนเดียว:

| PR | งาน | Definition of Done |
|---|---|---|
| `repo-bootstrap` | Monorepo, TS, lint, CI | lint/typecheck/test PASS |
| `baseline-import` | port 7 Flex + 12 tests | behavior เดิม PASS |
| `admin-shell-auth` | PC/mobile shell + Auth/RBAC | server auth PASS |
| `postgres-schema` | migrations + seed | migrate clean DB PASS |
| `flex-studio` | Form editor/revisions/preview | ไม่ต้องแก้ JSON |
| `oa-integrations` | หลาย OA + secrets | client ไม่เห็น token |
| `webhook` | HMAC/events/dedup | replay test PASS |
| `campaign-audience` | revision/audience | provider-safe |
| `scheduler-dry-run` | durable worker | concurrent test PASS |
| `messaging-adapter` | LINE sender | MOCK default |
| `customer-miniapp` | LIFF/backend identity | mobile/external PASS |
| `rewards-reports` | claim/report | concurrency PASS |
| `staging-qa` | end-to-end | production untouched |

### จุดที่ต้องขออนุมัติพี่ในอนาคต

เรา **ไม่ต้องขอ password, OTP, Channel Secret หรือ Access Token ผ่านแชท**

เมื่อถึงเวลาต่อระบบจริง ต้องการเพียงการกระทำโดยเจ้าของระบบในหน้าที่ปลอดภัย เช่น:

1. สร้าง/อนุมัติ Staging credentials ผ่าน secret environment
2. ยืนยัน Provider/OA/Channel จาก Console
3. อนุมัติ Webhook Staging
4. เพิ่มบัญชีทดสอบจริงอย่างน้อยหนึ่งคน
5. หลังทุก Test Gate ผ่าน จึงมี Production Change Request อีกครั้ง

Production change request ต้องบอก:

```text
BEFORE
AFTER
IMPACT
ROLLBACK
EXACT OA/CHANNEL
```

ก่อนพี่กดยืนยัน

### Risk register

**ความเสี่ยงสูงสุดคือ identity ข้าม Provider** เพราะ LINE user ID เปลี่ยนตาม Provider; ถ้าฐานข้อมูลออกแบบผิดตั้งแต่แรก CRM จะรวมคนผิดภายหลังแก้ยากมาก. citeturn22view0

**ความเสี่ยงถัดมาคือส่งซ้ำ** จาก timeout, process restart หรือ webhook redelivery จึงต้องใช้ unique DB keys + persisted LINE retry key + webhook dedup ทั้งสามชั้น. citeturn16view3turn16view4

**อีกความเสี่ยงคือ OA switching ใน MINI App ไทย** หากสร้าง UI ให้ดูเหมือนเปลี่ยน native OA ได้ทั้งที่ LINE จำกัด multi-account add-friend ไว้ที่ Japan จะทำให้ friendship/reward check ผิด OA. citeturn22view2

**ความเสี่ยงด้านข้อมูลส่วนบุคคล** ต้องจัดการตั้งแต่ schema: LINE user ID และพฤติกรรม campaign ที่ผูกกลับหาบุคคลได้ควรจัดเป็นข้อมูลที่ต้องมี purpose, access control, retention และ audit ที่ชัดเจน และการใช้งาน Production ควรให้ผู้เชี่ยวชาญกฎหมายไทยตรวจ Privacy/PDPA policy ขั้นสุดท้ายด้วย

### สิ่งที่ยัง NOT VERIFIED

ผมจงใจไม่อ้างว่าได้ตรวจสิ่งที่ยังไม่มีสิทธิ์ตรวจ ได้แก่:

- Provider `7632464` ใน Console จริง
- OA `@453yfyvc` อยู่ Provider ใดใน Console จริง
- Messaging API channel ID ของ OA ใหม่
- Channel Secret / Channel Access Token
- Webhook setting ปัจจุบัน
- Add friend linkage ใน Console
- Published/Review configuration
- OA subscription plan ปัจจุบันของบัญชีพี่
- การส่ง Flex ถึงเพื่อนจริง เพราะบัญชีที่ใช้ทดสอบก่อนหน้านี้มีเพื่อน 0
- Production DB/Backend เพราะยังไม่มี

ทั้งหมดนี้ **ไม่เป็น blocker สำหรับเริ่มสร้าง PR-01 ถึง PR-09 ใน Staging**

### Build artifact ที่ผมสร้างจากงานวิจัยรอบนี้

ผมจัด Implementation Handoff ให้พร้อมส่งต่อ Codex/ChatGPT Work แล้ว มีสามไฟล์:

- Implementation Handoff พร้อม architecture, security rules, Scheduler state machine, PR plan และ Definition of Done
- PostgreSQL schema draft สำหรับ multi-OA, provider-scoped identity, campaigns, revisions, jobs, webhooks และ rewards
- OpenAPI draft สำหรับ Auth, OA, Flex validation, campaign approval/scheduling, kill switch, webhook และ customer rewards

**ดาวน์โหลดชุด Build-Ready ทั้งหมด:**

[ดาวน์โหลด LINE Campaign Control Center — Research Handoff v1](sandbox:/mnt/data/LINE_Campaign_Control_Center_Research_Handoff_v1.zip)

ข้างในมี:

```text
LINE_Campaign_Control_Center_Implementation_Handoff_v1.md
LINE_Campaign_Control_Center_Schema_Draft_v1.sql
LINE_Campaign_Control_Center_OpenAPI_Draft_v1.yaml
```

สถานะ ณ ตอนนี้จึงเป็น:

```text
Baseline Audit                  PASS
Existing tests                  12/12 PASS
LINE feasibility                PASS
PC + Mobile architecture        DECIDED
Multi-OA architecture           DECIDED
Thailand native OA limitation   VERIFIED
Scheduler architecture          DECIDED
Webhook security design         DECIDED
Database draft                  CREATED
API contract draft              CREATED
Implementation handoff          CREATED

New application code            NOT YET IMPLEMENTED
Staging backend                 NOT DEPLOYED
Production changes              NONE
Live Messaging API send         NONE
Test D changes                  NONE
```

**ข้อสรุปสุดท้าย:** เราไม่ต้องทำ “เว็บ Flex อีกตัว” แล้วครับ ขั้นถัดไปควรเปลี่ยนฐานโค้ดจาก static prototype เป็น **Campaign Control Center จริง** โดยเริ่ม `repo-bootstrap → baseline-import → admin/auth → database → Flex Studio → multi-OA → webhook → scheduler DRY_RUN` ตาม Handoff ที่สร้างไว้ และยังไม่เปิด LIVE จนกว่า test gate ทั้งชุดจะผ่าน.