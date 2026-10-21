import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateCampaigns, chooseCampaign, campaignLink, prepareFlex, replaceFlexVars} from '../core.mjs';
const root=new URL('../',import.meta.url);
const load=path=>JSON.parse(fs.readFileSync(new URL(path,root),'utf8'));
const cfg={miniAppUrl:'https://miniapp.line.me/2012104116-08P8b7g6',oaAddFriendUrl:'https://lin.ee/Ql6Lqk2'};
const data=validateCampaigns(load('campaigns.json'));
test('manifest validates and sample assets/flex exist',()=>{assert.equal(data.campaigns.length,7);for(const c of data.campaigns){assert.ok(fs.existsSync(new URL(c.image,root)));assert.ok(fs.existsSync(new URL(c.flexFile,root)));}});
test('campaign selection defaults and falls back safely',()=>{assert.equal(chooseCampaign(data,'?campaign=news').id,'news');assert.equal(chooseCampaign(data,'?campaign=unknown').id,'welcome')});
test('per-campaign LIFF deep link and source',()=>{const u=new URL(campaignLink(cfg,'news','customer_share'));assert.equal(u.pathname,'/2012104116-08P8b7g6');assert.equal(u.searchParams.get('campaign'),'news');assert.equal(u.searchParams.get('utm_source'),'customer_share')});
test('all built-in Flex templates compile with proper HTTPS URI/image',()=>{for(const c of data.campaigns){const flex=prepareFlex(load(c.flexFile),cfg,c,'https://heeturbocharger.netlify.app/','owner_share');assert.equal(flex.type,'flex');assert.equal(flex.contents.type,'bubble');assert.match(JSON.stringify(flex),/miniapp\.line\.me/);if(JSON.stringify(load(c.flexFile)).includes('{{IMAGE_URL}}')) assert.match(JSON.stringify(flex),/heeturbocharger\.netlify\.app\/assets/);assert.doesNotMatch(JSON.stringify(flex),/\{\{/);}});
test('reject malformed Flex',()=>{assert.throws(()=>prepareFlex({type:'text'},cfg,data.campaigns[0],'https://example.com/'));});
test('reject unknown placeholders',()=>{assert.throws(()=>replaceFlexVars('Hey {{PASSWORD}}',{}));});
test('reject invalid local image path',()=>{const broken=structuredClone(data);broken.campaigns[0].image='../steal.png';assert.throws(()=>validateCampaigns(broken));});

test('flash example removes fake static countdown, prices and stock',()=>{const c=data.campaigns.find(x=>x.id==='flash'); const raw=load(c.flexFile); const flex=prepareFlex(raw,cfg,c,'https://heeturbocharger.netlify.app/');const j=JSON.stringify(flex); assert.match(j,/FLEX CAMPAIGN/);assert.doesNotMatch(j,/AirPods|9,990|32,900|Only 12|Ends In:/);assert.match(j,/2012104116-08P8b7g6/);});


test('new templates compile for LINE MINI App without misleading template claims',()=>{
 for(const id of ['gradient','purple']){
  const c=data.campaigns.find(x=>x.id===id); assert.ok(c);
  const compiled=prepareFlex(load(c.flexFile),cfg,c,'https://heeturbocharger.netlify.app/','owner_share');
  const body=JSON.stringify(compiled);
  assert.equal(compiled.contents.size,id==='purple'?'giga':'mega');
  assert.match(body,/2012104116-08P8b7g6/);
  assert.doesNotMatch(body,/TechFlow|Senior React|50-80K|50% OFF|Today only|AirPods|Apply Now/);
  const allButtons=[]; function walk(o){if(o&&typeof o==='object'){if(o.type==='button')allButtons.push(o);Object.values(o).forEach(walk);}} walk(compiled.contents);
  assert.ok(allButtons.length>=1);
  for(const b of allButtons){assert.match(b.action.uri,/^https:\/\//);assert.ok(b.action.label.length<=20);}
 }
});

test('gradient and purple styles preserved',()=>{
 const g=load('flex/gradient.json').contents;
 const p=load('flex/purple.json').contents;
 assert.equal(g.body.background.type,'linearGradient');
 assert.equal(g.body.background.angle,'45deg');
 assert.equal(p.header.backgroundColor,'#5C6BC0');
 assert.equal(p.body.contents[0].contents.length,4);
});


test('Profile Card: real OA link, no fabricated identity, figures, or postback follow',()=>{
 const c=data.campaigns.find(x=>x.id==='profile');assert.ok(c);
 const raw=load(c.flexFile);
 const compiled=prepareFlex(raw,cfg,c,'https://heeturbocharger.netlify.app/','owner_share');
 assert.equal(compiled.contents.size,'kilo');
 const body=JSON.stringify(compiled);
 assert.match(body,/@453yfyvc/);
 assert.match(body,/https:\/\/lin\.ee\/Ql6Lqk2/);
 assert.match(body,/2012104116-08P8b7g6/);
 assert.doesNotMatch(body,/Sarah Wilson|pravatar|sarah_designs|1\.2K|15\.3K|892|follow_user/);
 const btns=compiled.contents.footer.contents.filter(x=>x.type==='button');
 assert.equal(btns.length,2);
 assert.equal(btns[0].action.uri,'https://lin.ee/Ql6Lqk2');
 assert.ok(btns.every(x=>x.action.type==='uri'));
 assert.match(btns[1].action.uri,/campaign=profile/);
});

test('Profile ready JSON matches runtime-computed Flex',()=>{
 const c=data.campaigns.find(x=>x.id==='profile');
 const compiled=prepareFlex(load(c.flexFile),cfg,c,'https://heeturbocharger.netlify.app/','owner_share');
 assert.deepEqual(load('ready-json/profile-ready.json'),compiled);
});
