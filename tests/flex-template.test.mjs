import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fillFlexTemplate } from '../dist/api/flexTemplate.js';

const root = path.resolve(import.meta.dirname, '..');
const campaigns = JSON.parse(fs.readFileSync(path.join(root, 'campaigns.json'), 'utf8')).campaigns;
const braces = (flex) => JSON.stringify(flex).match(/\{\{[A-Z_]+\}\}/g) || [];

test('the card Flex Studio opens by default is sendable, not a template', () => {
  for (const campaign of campaigns) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, campaign.flexFile), 'utf8'));
    assert.ok(braces(raw).length > 0, `${campaign.flexFile} is expected to be written with slots`);
    assert.deepEqual(braces(fillFlexTemplate(campaign, raw)), [], `${campaign.id} still holds an unfilled slot after read-time substitution`);
  }
});

test('the filled slots point at URLs that actually exist on this host', () => {
  process.env.PUBLIC_APP_ORIGIN = 'https://ccc.bn9.one';
  process.env.LINE_LIFF_CHANNEL_ID = '12345678-AbCdEf';
  const campaign = campaigns.find((item) => item.id === 'welcome');
  const filled = JSON.stringify(fillFlexTemplate(campaign, JSON.parse(fs.readFileSync(path.join(root, campaign.flexFile), 'utf8'))));
  assert.match(filled, /https:\/\/liff\.line\.me\/12345678-AbCdEf/);
  assert.match(filled, new RegExp(`https://ccc\\.bn9\\.one/flex/${(campaign.image.split('/').pop()).replace(/\./g, '\\.')}`));
  assert.doesNotMatch(filled, /http:\/\/|localhost/, 'LINE only accepts https links and the image must be public');
  delete process.env.LINE_LIFF_CHANNEL_ID;
  assert.match(JSON.stringify(fillFlexTemplate(campaign, JSON.parse(fs.readFileSync(path.join(root, campaign.flexFile), 'utf8')))), /https:\/\/ccc\.bn9\.one\/share/);
});

test('a slot this app cannot know is left in place for the validator to refuse', () => {
  const filled = fillFlexTemplate(campaigns[0], { type: 'flex', altText: '{{COUPON_CODE}}', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '{{TITLE}}' }] } } });
  assert.deepEqual(braces(filled), ['{{COUPON_CODE}}'], 'only the known slot was substituted');
});
