import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLivePushBody, assertExplicitLiveDelivery } from '../dist/api/livePushPayload.js';

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
