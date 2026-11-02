import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLivePushBody, assertExplicitLiveDelivery, buildManualTextPushBody, MANUAL_PUSH_TEXT_MAX_CHARS } from '../dist/api/livePushPayload.js';

const USER = 'U' + 'a'.repeat(32);
const FLEX = { type: 'flex', altText: 'Staff-only test', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } };

test('builds one validated LINE push body without network', () => {
  const input = structuredClone(FLEX);
  const result = buildLivePushBody({ lineUserId: USER, flexMessage: input });
  assert.deepEqual(result, { to: USER, messages: [FLEX] });
  input.altText = 'Updated';
  assert.equal(result.messages[0].altText, 'Staff-only test');
  assert.equal(result.messages.length, 1);
});

test('rejects missing or fabricated recipients, broadcast and invalid Flex', () => {
  for (const value of [undefined, '', [], ['U' + 'b'.repeat(32)], '@lineid', 'Uabc', 'everyone', 'U' + 'x'.repeat(32)]) {
    assert.throws(() => buildLivePushBody({ lineUserId: value, flexMessage: FLEX }), /recipient/);
  }
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { type: 'text', text: 'hi' } }), /invalid LINE Flex/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { ...FLEX, altText: ' ' } }), /altText must not be empty/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { ...FLEX, altText: 'a'.repeat(401) } }), /safety limits/);
});

test('a box without a layout is refused before it can reach LINE', () => {
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { type: 'flex', altText: 'x', contents: { type: 'bubble', body: { type: 'box', contents: [] } } } }), /without a valid layout/);
  assert.doesNotThrow(() => buildLivePushBody({ lineUserId: USER, flexMessage: { type: 'flex', altText: 'x', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } } }));
});

const VIDEO_HERO = { type: 'video', url: 'https://example.com/clip.mp4', previewUrl: 'https://example.com/clip.jpg', altContent: { type: 'image', url: 'https://example.com/clip.jpg' } };
const videoCard = (hero = VIDEO_HERO, size = 'giga') => ({ type: 'flex', altText: 'คลิปโปรโมชั่น', contents: { type: 'bubble', hero, body: { type: 'box', layout: 'vertical', contents: [] }, ...(size ? { size } : {}) } });

test('a video is accepted only where LINE can actually play it', () => {
  assert.equal(buildLivePushBody({ lineUserId: USER, flexMessage: videoCard() }).messages[0].contents.size, 'giga');
  assert.equal(buildLivePushBody({ lineUserId: USER, flexMessage: videoCard(VIDEO_HERO, null) }).messages[0].contents.type, 'bubble', 'size defaults to mega, which is allowed');
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: videoCard(VIDEO_HERO, 'micro') }), /kilo, mega or giga/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { type: 'flex', altText: 'x', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [VIDEO_HERO] } } } }), /hero of a bubble/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { type: 'flex', altText: 'x', contents: { type: 'carousel', contents: [videoCard().contents] } } }), /carousel/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: videoCard({ ...VIDEO_HERO, url: 'http://example.com/clip.mp4' }) }), /https url/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: videoCard({ ...VIDEO_HERO, previewUrl: 'javascript:alert(1)' }) }), /previewUrl/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: videoCard({ type: 'video', url: 'https://example.com/clip.mp4' }) }), /altContent/);
});

test('live gate refuses DRY_RUN and absent authorization', () => {
  assert.throws(() => assertExplicitLiveDelivery('DRY_RUN', true), /explicit LIVE/);
  assert.throws(() => assertExplicitLiveDelivery('LIVE', false), /explicit LIVE/);
  assert.doesNotThrow(() => assertExplicitLiveDelivery('LIVE', true));
});

test('manual text push builds one single-recipient text body', () => {
  assert.deepEqual(buildManualTextPushBody({ lineUserId: USER, text: '  สวัสดีครับ 🎁  ' }), {
    to: USER, messages: [{ type: 'text', text: 'สวัสดีครับ 🎁' }]
  });
});

test('manual text push rejects bad recipients and empty or oversized text', () => {
  for (const value of [undefined, '', '@heekoom', 'Uabc', 'U' + 'z'.repeat(32), ['U' + 'b'.repeat(32)], USER + 'x']) {
    assert.throws(() => buildManualTextPushBody({ lineUserId: value, text: 'hi' }), /recipient/);
  }
  for (const value of ['', '   ', undefined, 42]) {
    assert.throws(() => buildManualTextPushBody({ lineUserId: USER, text: value }), /must not be empty/);
  }
  assert.throws(() => buildManualTextPushBody({ lineUserId: USER, text: 'ก'.repeat(MANUAL_PUSH_TEXT_MAX_CHARS + 1) }), /5000 characters/);
  assert.doesNotThrow(() => buildManualTextPushBody({ lineUserId: USER, text: '😀'.repeat(MANUAL_PUSH_TEXT_MAX_CHARS) }));
});

const flexWith = (contents) => ({ type: 'flex', altText: 'โปรโมชั่น', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents } } });

test('an unreplaced {{placeholder}} never leaves the server', () => {
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: flexWith([{ type: 'text', text: '{{TITLE}}' }]) }), /unreplaced placeholder/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: flexWith([{ type: 'button', action: { type: 'uri', label: 'กด', uri: '{{LIFF_URL}}' } }]) }), /unreplaced placeholder/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: { ...flexWith([]), altText: '{{TITLE}}' } }), /unreplaced placeholder/);
  assert.doesNotThrow(() => buildLivePushBody({ lineUserId: USER, flexMessage: flexWith([{ type: 'text', text: 'ลด 20% วันนี้' }]) }));
});

test('a link is refused unless LINE can actually open it', () => {
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: flexWith([{ type: 'button', action: { type: 'uri', label: 'กด', uri: 'http://example.com' } }]) }), /must be an https:\/\/ or line:\/\/ link/);
  assert.throws(() => buildLivePushBody({ lineUserId: USER, flexMessage: flexWith([{ type: 'image', url: 'ftp://example.com/a.png' }]) }), /must be an https url/);
  assert.doesNotThrow(() => buildLivePushBody({ lineUserId: USER, flexMessage: flexWith([{ type: 'button', action: { type: 'uri', label: 'กด', uri: 'https://example.com' } }, { type: 'button', action: { type: 'uri', label: 'เพื่อน', uri: 'line://ti/p/@heekoom' } }]) }));
});
