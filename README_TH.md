# LINE Flex Collection v4 — เพิ่ม Template 07: Profile Card

- เพิ่มการ์ดโปรไฟล์แนวขาว–เขียวจาก JSON ที่ส่งมาให้ (หัวโปรไฟล์ + handle + 3 ช่อง + 2 ปุ่ม)
- **ไม่อ้างตัวตน Sarah Wilson, ไม่แสดงยอดผู้ติดตามหรือสถิติสมมติ** และไม่ดึงภาพโปรไฟล์คนสุ่มจาก pravatar
- เปลี่ยนปุ่ม **Follow** ที่เดิมเป็น `postback` ให้เป็น **URI เพิ่มเพื่อน LINE OA** `https://lin.ee/Ql6Lqk2` ซึ่งจะเปิดหน้าจอเพิ่มเพื่อนจริง (ไม่ได้รับประกันว่าผู้ใช้กดยืนยัน)
- เปลี่ยนปุ่ม **Message** เป็น **เปิด MINI App** `https://miniapp.line.me/2012104116-08P8b7g6?campaign=profile...`
- แก้ข้อความหลัก 3 ช่องได้ในหน้า Studio ไม่ต้องแก้ JSON; ข้อความ handle `@453yfyvc` และ URI เพิ่มเพื่อนเป็นค่าของระบบใหม่นี้
- รวม 7 เทมเพลต: Welcome, Activity, News, Flash, Gradient, Purple, Profile
- JSON สำหรับ Flex Simulator: `ready-json/profile-ready.json`; ไฟล์แม่แบบแก้ไขอยู่ที่ `flex/profile.json`
- **ยังไม่ Deploy** ไป `heeturbocharger.netlify.app`, ไม่แตะ Test D เดิม และยังไม่ทดสอบส่งถึงผู้รับจริง
- ผู้ใช้ทดสอบ LINE ส่วนตัวบัญชีใหม่มีเพื่อน 0: Share Target Picker เปิดได้แต่การส่งถึงผู้รับยังไม่ได้ยืนยัน

---

# Flex Collection v3 — รวมเทมเพลต 2 อันที่เพิ่งส่งมา

- **Gradient Flash**: โทนแดงส้มไล่เฉด 45 องศาตาม JSON ที่ส่งมา โดยตัดคำว่า SALE 50% OFF / Today only ที่ยังไม่มีข้อเสนอจริง
- **Purple Info Card**: โทนม่วงและบล็อกข้อมูลสี่ช่องตาม JSON ประกาศงาน แต่เปลี่ยนเป็นการ์ดกิจกรรม LINE OA โดยไม่อ้างว่ามีบริษัทเปิดรับสมัครจริง เงินเดือน หรือรับสมัครงาน
- มีเมนูเลือกเทมเพลต 7 แบบ (Welcome, Activity, News, Flash Black/Red, Gradient Flash, Purple Info Card)
- เปิดหน้า Studio ใน LIFF ผ่าน `https://miniapp.line.me/2012104116-08P8b7g6?studio=1` (หมายเหตุ: query บนลิงก์ MINI App อาจถูก LINE ปรับเปลี่ยน; ใช้แท็บ เลือก Flex / แชร์ ในหน้าจอก็ได้)
- จะแก้หัวข้อ คำบรรยาย ข้อความปุ่มได้จากหน้า Studio **โดยไม่ต้องแก้ JSON** แต่เป็นการเก็บเฉพาะอุปกรณ์ ไม่ใช่ระบบหลังบ้านของทุกคน
- ปุ่ม CTA เปิด LINE MINI App ใหม่; บนการ์ดม่วงมีปุ่มเพิ่มเพื่อน OA สำรอง
- **ยังไม่ได้ Deploy** บน `heeturbocharger.netlify.app`; ถ้าจะเผยแพร่ให้ลูกค้าต้องทดสอบแล้วอัปโหลดเวอร์ชันนี้ขึ้น Netlify ด้วยตนเอง
- `flex/gradient.json` และ `flex/purple.json` ยังมี placeholders `{{LIFF_URL}}` etc. ใช้ผ่านเว็บได้ทันที; ตัวอย่างที่แทนค่าแล้วจะอยู่ใน `ready-json/`
- การทดสอบ local รวม JSON syntax, การแทนค่า URL, ลักษณะธีม และตัวเลข/ข้อความ placeholder; **ยังไม่ได้ยืนยันผ่าน LINE Flex Simulator หรือแชร์มือถือจริง**

---

# เพิ่มใหม่ใน v2: เทมเพลต Flash Sale Style ที่พี่ส่งมา

- มี Campaign `flash` ใน `campaigns.json` และไฟล์ `flex/flash.json` แบบดำ-แดงตามสไตล์ต้นฉบับ
- จงใจตัด **ตัวนับเวลา 02:34:17, ราคา AirPods, -70%, จำนวนสินค้าคงเหลือ** ซึ่งเป็นค่าตัวอย่างออก ไม่อ้างว่าโปรโมชั่นมีจริง
- ตัวอย่างที่สร้างใหม่เปิด MINI App จริง `https://miniapp.line.me/2012104116-08P8b7g6?campaign=flash` ด้วยปุ่มใน Flex
- เปิด `/ ?studio=1` (ลบช่องว่าง) แล้วเลือก `⚡ Flash Sale Style (ตัวอย่าง)` เพื่อทดลองแชร์
- มีช่อง **แก้ข้อความ Flex แบบง่าย**: ชื่อโปรโมชั่น, รายละเอียด, ข้อความบนปุ่ม โดยไม่ต้องแก้ JSON
- ช่องแก้ข้อความเก็บเฉพาะเครื่อง/เบราว์เซอร์ที่แก้ **ไม่ใช่ Admin** และ **ไม่เผยแพร่**; ถ้าต้องการเผยแพร่ให้ทุกคนให้ส่งข้อความ/ภาพมาทำ release ZIP ใหม่แล้ว Deploy
- ยังไม่มี Backend หรือคูปองมีมูลค่า; อย่าใช้เพื่อแจกจริง

## วิธีทดลองโดยไม่กระทบเว็บปัจจุบัน
1. แตก ZIP ลงโฟลเดอร์ใหม่ และอัปโหลดขึ้น Netlify Site ใหม่แยกเป็น **preview** ก่อน
2. ทดสอบหน้า `/ ?studio=1` และ Flex แคมเปญ flash
3. เมื่ออนุมัติจึงค่อย Deploy ทับเว็บไซต์ `heeturbocharger.netlify.app`; `Endpoint` LINE MINI App ไม่ต้องเปลี่ยนหากใช้โดเมนเดิม
4. ดาวน์โหลด JSON จากหน้า Studio ได้ไฟล์ที่แทนลิงก์/ข้อความแล้ว สำหรับนำไปดูตัวอย่างใน LINE Flex Simulator แต่ **ไม่ใช่การ Deploy**
5. ต้องมีเพื่อนในบัญชี LINE จึงจะทดลองส่ง Share Target Picker ไปถึงผู้รับจริงได้

---

# LINE MINI App — Campaign Core v1 (เตรียมสำหรับ Template Flex ของจริง)

## สถานะ

- ตรวจ LIFF Login, `liff.getFriendship()`, `liff.requestFriendship()` และ `liff.shareTargetPicker()` จาก LINE จริง (ต้องทดสอบบนมือถือ)
- รองรับแชร์ Flex จริงให้ผู้รับที่ผู้ใช้เลือกเอง ไม่มีการเก็บ/อ่านรายชื่อเพื่อน
- รองรับ Campaign ID ผ่าน `?campaign=welcome` / `activity` / `news`
- แก้ Flex JSON รายแคมเปญแยกจากโค้ดใน `flex/` และแก้ข้อความ/ภาพใน `campaigns.json`
- **ยังไม่มีคูปองจริง ไม่บันทึกสิทธิ์ ไม่ป้องกันรับซ้ำ และยังไม่ใช่ระบบ Production สำหรับรางวัล**
- Studio เป็นเครื่องมือแชร์และแก้ JSON เฉพาะอุปกรณ์ **ไม่ใช่ Admin ที่มีการพิสูจน์ตัวตน** และการบันทึกใน Studio ไม่ได้อัปโหลดขึ้น Netlify

## ชุดข้อมูลที่ตั้งไว้

- Provider ID จากผู้ใช้: `7632464` (ยังไม่ตรวจการผูกจาก Console)
- LINE MINI App Channel: `2012104116` / Developing LIFF ID: `2012104116-08P8b7g6`
- OA: `@453yfyvc` / ลิงก์เพิ่มเพื่อน: https://lin.ee/Ql6Lqk2
- ปัจจุบัน Netlify staging: https://heeturbocharger.netlify.app/
- โค้ด/ภาพทั้งหมดแยกจาก Test D เดิม

## เทมเพลตที่กำลังรอ

นำรูปที่ได้รับมาใส่ `assets/` และ Flex JSON ลง `flex/` แล้วแก้ `campaigns.json` ของรายการนั้นให้ชี้ชื่อไฟล์ตรงกัน **ไม่ต้องแก้ logic ใน app.js**

Placeholder ที่ใช้ใน Flex JSON:

- `{{LIFF_URL}}` ลิงก์เปิด MINI App ของ campaign นั้น พร้อม query source
- `{{IMAGE_URL}}` URL ภาพจาก assets/ บนเว็บไซต์
- `{{TITLE}}`, `{{DESCRIPTION}}`, `{{CTA}}` ข้อความจาก campaigns.json
- `{{OA_URL}}` ลิงก์เพิ่มเพื่อนสำรอง

Flex JSON ต้องเป็นออบเจ็กต์ `type: "flex"`, `altText`, `contents: {type: "bubble"|"carousel", ...}`

## ทดสอบแบบไม่กระทบเว็บเดิม

1. แตก ZIP แล้วใช้ `python -m http.server 8080` ในโฟลเดอร์นี้ (ห้ามเปิดไฟล์ HTML ด้วย `file://` เพราะ fetch JSON ต้องใช้ HTTP)
2. เปิด http://localhost:8080/ เพื่อดูตัวอย่าง
3. เปิด http://localhost:8080/?studio=1 เพื่อดูหน้าแชร์และทดลอง Flex JSON
4. ทดสอบ `node --test tests/core.test.mjs` ถ้ามี Node.js
5. เมื่ออนุมัติแล้วให้ Backup เว็บไซต์ปัจจุบันก่อน แล้วอัปโหลดโฟลเดอร์ชุดนี้เข้า Netlify Site `heeturbocharger` (หรือสร้าง staging site สำรองเพื่อเปรียบเทียบ)
6. ยืนยันว่า Endpoint Developing ยังคงชี้ `https://heeturbocharger.netlify.app/` ถ้าใช้โดเมนเดิม
7. เปิด `https://miniapp.line.me/2012104116-08P8b7g6` ใน LINE เพื่อทดสอบ inClient=true

## เช็กสิทธิ์ก่อนใช้งานจริง

- Developer Console: MINI App → Basic settings → Linked OA ต้องเป็น `@453yfyvc`
- Web app settings: `openid`, `profile`, Add friend option On, shareTargetPicker enabled, HTTPS Endpoint
- LINE บนมือถือ version ใหม่; มีบัญชีเพื่อนทดสอบจริงอย่างน้อย 1 บัญชีในการทดสอบแชร์
- การแชร์สำเร็จของ LINE API ไม่เท่ากับรับรองว่าเครื่องผู้รับเห็นแล้ว
- ระบบ reward จริงต้องมี Backend: ตรวจ LINE token ฝั่ง Server, ตรวจการเป็นเพื่อน/สิทธิ์, บันทึก claim ป้องกันซ้ำ, audit, จำกัด rate และตั้งกติกาชัดเจน

## ความปลอดภัย

- ห้ามใส่ Channel Secret, Access Token, OTP ใน `config.js`, HTML หรือ JSON ของเว็บ
- Client-side localStorage ใน Studio เก็บเฉพาะ Flex JSON ที่ผู้ใช้แก้ ไม่เก็บ LINE ID / Token
- Studio เปิดเข้าถึงได้โดยทุกคนที่ทราบ URL **ไม่ใช่หน้า Admin ที่ปลอดภัย** อย่าใช้จัดการของมีมูลค่า
- ก่อนเปิดจริงให้จัดการ Privacy Policy/Terms และตรวจตามกฎ LINE MINI App
