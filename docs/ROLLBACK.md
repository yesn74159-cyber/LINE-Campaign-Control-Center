# Deploy และ rollback ด้วย image tag

ทุก deploy ตั้งแต่ P1-6 สร้าง image ที่มี tag ของตัวเอง (`line-ccc-api:<tag>`, `line-ccc-admin:<tag>`) และเก็บ tag ที่กำลังรันอยู่ใน `.env.staging` (`RELEASE_TAG=...`) การย้อนกลับจึงเป็นการสั่ง `up -d` บน tag เก่า **ไม่ใช่** rebuild โค้ดเก่าที่อาจไม่ตรงกับฐานข้อมูลอีกต่อไป

## Deploy ปกติ

```bash
cd /srv/line-ccc-staging
git pull --ff-only
bash deploy/staging-migrate.sh migrate     # เฉพาะเมื่อมี migration ใหม่ (owner URL)
bash deploy/release.sh                     # build + up, tag = git short sha
```

`deploy/release.sh` จะ build `api` และ `admin` ก่อน แล้วตรวจว่า image ทั้งสองมีจริง จากนั้นเขียน `RELEASE_TAG` ลง `.env.staging` (atomic, คงสิทธิ์เดิม) แล้ว `up -d --no-build` ถ้าต้องการ tag ที่อ่านง่าย: `RELEASE_TAG=pilot-1 bash deploy/release.sh`

## Rollback

```bash
cd /srv/line-ccc-staging
docker images line-ccc-api --format '{{.Tag}}\t{{.CreatedAt}}' | head    # เลือก tag ก่อนหน้า
RELEASE_TAG=<tag-ก่อนหน้า> bash deploy/release.sh --no-build
```

ตรวจหลังย้อน:

```bash
curl -sS https://66t.online/health                     # ok:true, db:up, mode:DRY_RUN
SMOKE_BASE_URL=https://66t.online SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... \
  npm run smoke:staging                                # 21/21
docker ps --filter name=line-ccc --format '{{.Names}}\t{{.Image}}'
```

`.env.staging` ถูกเขียนโดย `release.sh` เท่านั้น — ถ้าแก้มือ ต้องคงบรรทัด `RELEASE_TAG=` ไว้ ไม่งั้นรอบถัดไปจะกลับไปใช้ `local`

## ข้อจำกัดที่ต้องรู้

- **Migration ไม่ย้อนตาม image** — `016`–`019` เป็นการเพิ่มคอลัมน์/คลาย constraint แบบ forward-only; image เก่าทำงานกับ schema ใหม่ได้ แต่ image ใหม่ที่รันไปแล้วจะไม่ถอย schema ให้ ถ้า release นั้นแก้ schema และต้องการถอยจริง ให้ restore จาก dump (`scripts/db-restore.mjs`) ไม่ใช่แค่เปลี่ยน tag
- **`local` ไม่ใช่ tag สำหรับ rollback** — image ที่ไม่มี tag จะถูกเขียนทับทุกครั้งที่ build; ห้ามใช้ `docker compose build` ตรง ๆ บน staging ให้ใช้ `deploy/release.sh`
- **worker ใช้ image เดียวกับ api** (`line-ccc-api:<tag>`) — rollback ครั้งเดียวเปลี่ยนทั้งคู่ (`up -d` recreate worker ด้วย)
- เก็บ image เก่าไว้อย่างน้อย 2 tag; ถ้าดิสก์ตึง ให้ลบเฉพาะ tag ที่ไม่ได้อยู่ใน `.env.staging`:
  `docker rmi line-ccc-api:<tag-เก่ามาก>` (ตรวจ `docker ps` ก่อน)

## ซ้อม rollback (ทำครั้งเดียวก่อนลงสนาม)

1. ระหว่างที่ไม่มีงานค้าง (`/api/scheduler/jobs` ไม่มี `SCHEDULED`/`SENDING`) ให้ deploy release ปกติหนึ่งครั้ง
2. จด tag ปัจจุบัน: `grep '^RELEASE_TAG=' .env.staging`
3. ย้อนด้วย tag ก่อนหน้าแล้วรอ healthcheck ผ่าน
4. `curl /health` + smoke ต้องผ่านเหมือนเดิม
5. กลับไป tag ล่าสุดด้วยคำสั่งเดียวกัน

ผลการซ้อมให้บันทึกใน `docs/WORKLOG.md` พร้อม tag ทั้งสองฝั่ง
