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
