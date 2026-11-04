import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeFlexTemplate, fillFlexTemplate } from '../dist/api/flexTemplate.js';

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

test('saving the filled card back hands the URLs to the database, not this host name', () => {
  process.env.PUBLIC_APP_ORIGIN = 'https://66t.online';
  process.env.LINE_LIFF_CHANNEL_ID = '12345678-AbCdEf';
  const campaign = campaigns.find((item) => item.id === 'welcome');
  const raw = JSON.parse(fs.readFileSync(path.join(root, campaign.flexFile), 'utf8'));
  const saved = JSON.stringify(canonicalizeFlexTemplate(campaign, fillFlexTemplate(campaign, raw)));
  assert.ok(saved.includes('{{IMAGE_URL}}') && saved.includes('{{LIFF_URL}}'), 'the URL slots come back, so a domain change reaches every stored card');
  assert.doesNotMatch(saved, /66t\.online|liff\.line\.me/, 'no host name survives the round trip');
  assert.equal(canonicalizeFlexTemplate(campaign, fillFlexTemplate(campaign, raw)).contents.body.contents[0].text, campaign.title, 'the copy stays literal in the revision, because only the URL slots come from configuration');
  const typed = fillFlexTemplate(campaign, raw);
  typed.contents.hero.url = 'https://brand.example/promo.png';
  assert.match(JSON.stringify(canonicalizeFlexTemplate(campaign, typed)), /https:\/\/brand\.example\/promo\.png/, 'a link the operator typed himself is not a filler value and stays literal');
  delete process.env.LINE_LIFF_CHANNEL_ID;
});

test('the add-friend slot never resolves to the bare site origin, which is the operator login page', () => {
  process.env.PUBLIC_APP_ORIGIN = 'https://66t.online';
  process.env.LINE_LIFF_CHANNEL_ID = '12345678-AbCdEf';
  const profile = campaigns.find((item) => item.id === 'profile');
  const raw = JSON.parse(fs.readFileSync(path.join(root, profile.flexFile), 'utf8'));
  const filled = JSON.stringify(fillFlexTemplate(profile, raw));
  assert.doesNotMatch(filled, /"uri":"https:\/\/66t\.online"/, 'a customer tapping เพิ่มเพื่อน OA must not reach the Admin sign-in screen');
  assert.match(filled, /https:\/\/66t\.online\/share/, 'the funnel page that answers the OA add-friend link is the fallback');
  process.env.LINE_OA_FRIEND_URL = 'https://line.me/R/ti/p/@453yfyvc';
  assert.match(JSON.stringify(fillFlexTemplate(profile, raw)), /line\.me\/R\/ti\/p\/@453yfyvc/);
  delete process.env.LINE_OA_FRIEND_URL;
  delete process.env.LINE_LIFF_CHANNEL_ID;
});

test('a slot this app cannot know is left in place for the validator to refuse', () => {
  const filled = fillFlexTemplate(campaigns[0], { type: 'flex', altText: '{{COUPON_CODE}}', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '{{TITLE}}' }] } } });
  assert.deepEqual(braces(filled), ['{{COUPON_CODE}}'], 'only the known slot was substituted');
});
