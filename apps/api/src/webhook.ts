import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLineSignature(rawBody: string, signature: string | undefined, channelSecret: string | undefined) {
  if (!signature || !channelSecret) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function payloadHash(rawBody: string) { return createHash('sha256').update(rawBody).digest('hex'); }
