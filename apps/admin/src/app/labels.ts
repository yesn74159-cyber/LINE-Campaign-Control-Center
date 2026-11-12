export const jobStatusLabel = (status: string) => ({ DRAFT: 'ร่าง', SCHEDULED: 'รอส่ง', PAUSED: 'หยุดชั่วคราว', COMPLETED: 'ส่งแล้ว', FAILED: 'ล้มเหลว', FAILED_FINAL: 'ล้มเหลว', CANCELLED: 'ยกเลิก', RETRYABLE: 'รอส่งใหม่' } as Record<string, string>)[status] || status;
export const approvalLabel = (status?: string) => ({ APPROVED: 'อนุมัติแล้ว', VALIDATED: 'ตรวจแล้ว · รออนุมัติ', DRAFT: 'ยังไม่ได้ตรวจ' } as Record<string, string>)[status || ''] || 'กำลังตรวจสถานะ';
export const maskLineKey = (key: string) => (key.length > 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key);
export const maskLineKeysInText = (text: string) => text.replace(/\bU[0-9a-f]{32}\b/gi, (key) => maskLineKey(key));
export const auditDetailText = (detail: string) => maskLineKeysInText(detail
  .replace(/^Preview and validation completed$/, 'ตรวจข้อความและดูตัวอย่างเสร็จแล้ว')
  .replace(/^Campaign approved for revision (\d+)$/, 'อนุมัติแคมเปญเวอร์ชัน $1')
  .replace(/^Campaign approved for Staging DRY_RUN scheduling$/, 'อนุมัติแคมเปญสำหรับตั้งเวลาทดสอบ')
  .replace(/^revision (\d+)$/, 'เวอร์ชัน $1')
  .replace(/^Referral status changed to ACTIVE$/, 'เปลี่ยนสถานะลิงก์เป็น ใช้งาน')
  .replace(/^Referral status changed to PAUSED$/, 'เปลี่ยนสถานะลิงก์เป็น หยุดชั่วคราว')
  .replace(/^Referral status changed to REVOKED$/, 'เปลี่ยนสถานะลิงก์เป็น ยกเลิก')
  .replace(/^Referral link created for member (.+)$/, 'สร้างลิงก์ให้ $1')
  .replace(/\bDRY_RUN\b/g, 'ทดสอบ')
  .replace(/\bLIVE\b/g, 'ส่งจริง'));
export const connectionLabel = (status: string) => ({ DRY_RUN_READY: 'พร้อมทดสอบ', VERIFIED: 'เชื่อมต่อแล้ว', NOT_CONFIGURED: 'ยังไม่ตั้งค่า' } as Record<string, string>)[status] || status;
export const blockerLabel = (blocker: string) => ({ 'Campaign approval is required': 'ยังไม่ได้อนุมัติข้อความ', 'Campaign content changed since approval': 'ข้อความเปลี่ยนหลังอนุมัติ · ต้องตรวจและอนุมัติใหม่', 'System kill switch is active': 'ระบบถูกหยุดฉุกเฉินอยู่', 'OA kill switch is active': 'LINE OA ถูกหยุดฉุกเฉินอยู่', 'Campaign kill switch is active': 'แคมเปญนี้ถูกหยุดอยู่', 'A staging OA must be selected': 'ยังไม่ได้เลือก LINE OA', 'Selected OA is not an enabled staging OA': 'LINE OA ที่เลือกยังไม่เปิดใช้งาน' } as Record<string, string>)[blocker] || blocker;
export const auditActionLabel = (action: string) => ({
  ACCOUNT_INVITE_ISSUED: 'ออกลิงก์เชิญสมาชิก', ACCOUNT_RESET_ISSUED: 'ออกลิงก์รีเซ็ตรหัสผ่าน',
  CAMPAIGN_APPROVED: 'อนุมัติแคมเปญ', CAMPAIGN_VALIDATED: 'ตรวจข้อความแคมเปญ',
  CAMPAIGN_KILL_SWITCH_ON: 'หยุดแคมเปญชั่วคราว', CAMPAIGN_KILL_SWITCH_OFF: 'เปิดแคมเปญกลับ',
  CUSTOMER_OPT_OUT: 'ลูกค้ายกเลิกความยินยอม', DRY_RUN_ENQUEUED: 'ทดลองส่ง (ไม่ยิง LINE)',
  DRY_RUN_EXECUTED: 'ทดลองส่งสำเร็จ',
  FLEX_REVISION_CREATED: 'บันทึกเวอร์ชันการ์ด', MANUAL_PUSH_PREVIEWED: 'ดูตัวอย่างข้อความตรง',
  MANUAL_PUSH_SENT: 'ส่งข้อความตรง', MANUAL_PUSH_BLOCKED: 'ส่งข้อความตรงถูกบล็อก',
  MANUAL_PUSH_FAILED: 'ส่งข้อความตรงไม่สำเร็จ',
  MEMBER_INVITE_ACCEPTED: 'สมาชิกตั้งรหัสผ่านสำเร็จ', MEMBER_INVITED: 'เชิญสมาชิก', MEMBER_UPDATED: 'แก้ไขข้อมูลสมาชิก',
  OA_CONNECTION_CREATED: 'เพิ่มบัญชี LINE OA',
  OA_CREDENTIAL_REFERENCE_VALIDATED: 'ตรวจ credential ของ OA', OA_LIMITS_CHANGED: 'แก้เพดานการส่ง',
  OA_CHANNEL_VERIFIED: 'ยืนยันช่องทาง OA กับ LINE', OA_CHANNEL_METADATA_UPDATED: 'อัปเดตข้อมูลช่องทาง OA',
  OA_TOKEN_VERIFIED: 'ตรวจ token ของ OA ผ่าน', OA_TOKEN_RECHECKED: 'ตรวจ token ของ OA ซ้ำ',
  OA_VAULT_REKEYED: 'เปลี่ยนกุญแจเข้ารหัส credential',
  REFERRAL_CREATED: 'สร้างลิงก์แนะนำ', REFERRAL_ACTIVE: 'เปิดลิงก์แนะนำ',
  REFERRAL_PAUSED: 'หยุดลิงก์แนะนำชั่วคราว', REFERRAL_RESUMED: 'เปิดลิงก์แนะนำต่อ', REFERRAL_REVOKED: 'ยกเลิกลิงก์แนะนำ',
  STAGING_SEEDED: 'ติดตั้งข้อมูลตั้งต้น', WORKSPACE_RENAMED: 'เปลี่ยนชื่อ Workspace',
  WORKER_HEARTBEAT: 'worker ยังทำงานอยู่',
  OA_ENABLED: 'เปิดใช้งาน OA', OA_DISABLED: 'ปิดใช้งาน OA',
  OA_KILL_SWITCH_ON: 'หยุด OA ฉุกเฉิน', OA_KILL_SWITCH_OFF: 'ปิดการหยุด OA ฉุกเฉิน',
  SYSTEM_KILL_SWITCH_ON: 'หยุดระบบฉุกเฉิน', SYSTEM_KILL_SWITCH_OFF: 'เปิดระบบกลับ',
  OUTBOX_SENDING: 'กำลังส่งถึงผู้รับ', OUTBOX_SENT: 'ส่งถึงผู้รับแล้ว', OUTBOX_RECONCILED: 'กระทบยอดการส่ง',
  PASSWORD_RESET_COMPLETED: 'ตั้งรหัสผ่านใหม่สำเร็จ', QUOTA_EXCEEDED: 'โควตาการส่งเต็ม', QUOTA_NEAR_LIMIT: 'โควตาใกล้เต็ม',
  SCHEDULE_CREATED: 'สร้างงานตั้งเวลา', SCHEDULE_DRAFT_CREATED: 'สร้างงานแบบร่าง',
  SCHEDULE_SCHEDULED: 'ตั้งเวลาส่งแล้ว', SCHEDULE_PAUSED: 'หยุดงานชั่วคราว', SCHEDULE_RESUMED: 'ทำต่องานที่หยุด',
  SCHEDULE_CANCELLED: 'ยกเลิกงาน', SCHEDULE_RETRY: 'ลองส่งงานใหม่',
  WORKER_CLAIMED: 'worker รับงาน', WORKER_COMPLETED: 'worker ส่งงานสำเร็จ', WORKER_FAILED: 'worker ส่งงานไม่สำเร็จ', WORKER_RETRY: 'worker ลองใหม่', WORKER_RECOVERED: 'worker กู้งานค้าง',
  RATE_LIMITED: 'ถูกจำกัดอัตราการเรียก', SKIPPED: 'ข้ามรายการนี้', FAILED: 'ล้มเหลว'
} as Record<string, string>)[action] || action;
