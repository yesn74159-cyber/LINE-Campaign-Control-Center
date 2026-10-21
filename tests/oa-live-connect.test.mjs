import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  sealOaSecret, openOaSecret, vaultKey, checkLineBotToken, registerOaConnectRoutes
} from '../dist/api/lineOaConnect.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const oa = '33333333-3333-4333-8333-333333333333';
const key = randomBytes(32);
const token = 'TEST_TOKEN_LONG_ENOUGH_abcdefghijklmnopqrstuvwxyz';
const secret = 'd'.repeat(32);

test('AES-256-GCM seals with randomized IV and strict tenant-bound AAD', () => {
  const one = sealOaSecret(token, a, oa, 'token', key);
  const two = sealOaSecret(token, a, oa, 'token', key);
  assert.notEqual(one, two);
  assert.equal(openOaSecret(one, a, oa, 'token', key), token);
  assert.throws(() => openOaSecret(one, b, oa, 'token', key));
  assert.throws(() => openOaSecret(one, a, oa, 'secret', key));
  assert.throws(() => openOaSecret(one, a, b, 'token', key));
  assert.throws(() => openOaSecret(one.slice(0,-3)+'xxx', a, oa, 'token', key));
});

test('vault is disabled without well-formed external key', () => {
  assert.throws(() => vaultKey('bad-key'));
  assert.throws(() => vaultKey());
  assert.equal(vaultKey(key.toString('base64')).length,32);
});

test('LINE token validation only performs read-only bot info GET', async () => {
  let called = false;
  const mock = async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.line.me/v2/bot/info');
    assert.equal(options.method,'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return new Response(JSON.stringify({ basicId:'@oa123', displayName:'QA LINE OA' }), {
      status:200, headers:{ 'content-type':'application/json' }
    });
  };
  const bot = await checkLineBotToken(token, mock);
  assert.deepEqual(bot, { basicId:'@oa123', displayName:'QA LINE OA' });
  assert.equal(called, true);
  await assert.rejects(() => checkLineBotToken(token, async () => new Response('{}', {status:401})), /rejected/);
  await assert.rejects(() => checkLineBotToken(token, async () => new Response('unexpected',{status:200})), /invalid LINE/);
});

function harness({ role = 'owner', active = true, valid = true, crossTenant = false, configured = true } = {}) {
  const calls = [];
  const rows = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('workspace_memberships')) return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] };
      if (sql.includes('from oa_integrations oa')) return { rowCount:0, rows:[] };
      return { rowCount:0, rows:[] };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (sql.includes('where basic_id=')) return { rowCount: crossTenant ? 1 : 0, rows: crossTenant ? [{}] : [] };
          if (sql.includes('insert into oa_integrations')) return {rowCount:1,rows:[{id:oa}]};
          if (sql.includes('oa_credential_vault')) rows.push({sql,params});
          return {rowCount:1,rows:[]};
        }, release() {}
      };
    }
  };
  const app = Fastify();
  const check = async t => {
    assert.equal(t,token);
    if (!valid) throw new Error('LINE rejected the channel access token');
    return { basicId:'@oa123',displayName:'QA LINE OA' };
  };
  const user = { id:'owner-a',email:'owner@qa.test',displayName:'Owner',workspaceId:a,role };
  registerOaConnectRoutes(app, pool, async req=>{req.user=user;}, (request,reply)=>{
    if (request.headers['x-csrf-token']!=='qa') return reply.code(403).send({error:'CSRF'});
  }, check);
  const original = process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
  if (configured) process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = key.toString('base64');
  else delete process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
  return {
    app,calls,rows,close: async () => {
      await app.close();
      if(original === undefined) delete process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = original;
    }
  };
}
const payload = { providerId:'provider123',messagingChannelId:'1234567890',channelAccessToken:token,channelSecret:secret };

test('owner saves verified token without leaking secret back to client', async () => {
  const {app,calls,rows,close}=harness();
  try {
    const r=await app.inject({method:'POST',url:'/api/workspace/oa-connect',headers:{'x-csrf-token':'qa'},payload});
    assert.equal(r.statusCode,201,r.body);
    assert.equal(r.json().accessTokenValidated,true);
    assert.equal(r.json().webhookSecretValidated,false);
    assert.equal(r.json().sendingEnabled,false);
    assert.ok(!r.body.includes(token) && !r.body.includes(secret));
    assert.equal(rows.length,1);
    assert.equal(openOaSecret(rows[0].params[2],a,oa,'token',key),token);
    assert.equal(openOaSecret(rows[0].params[3],a,oa,'secret',key),secret);
    assert.ok(calls.some(x=>x.sql.includes('workspace_id') && x.params.includes(a)));
  } finally {await close();}
});

test('unverified token never reaches database', async () => {
  const {app,rows,close}=harness({valid:false});
  try {
    const r=await app.inject({method:'POST',url:'/api/workspace/oa-connect',headers:{'x-csrf-token':'qa'},payload});
    assert.equal(r.statusCode,422,r.body);
    assert.equal(rows.length,0);
  } finally {await close();}
});

test('owner must be active with CSRF; no key means fail closed', async () => {
  for(const options of [{role:'viewer'}, {active:false}, {configured:false}]){
    const {app,rows,close}=harness(options);
    try{
      const r=await app.inject({method:'POST',url:'/api/workspace/oa-connect',headers:{'x-csrf-token':'qa'},payload});
      assert.ok([403,503].includes(r.statusCode),r.body);
      assert.equal(rows.length,0);
    }finally{await close();}
  }
  const {app,close}=harness();
  try {
    const r=await app.inject({method:'POST',url:'/api/workspace/oa-connect',payload});
    assert.equal(r.statusCode,403);
  } finally { await close(); }
});

test('existing ownership in different workspace prevents OA hijacking', async () => {
  const {app,rows,close}=harness({crossTenant:true});
  try {
    const r=await app.inject({method:'POST',url:'/api/workspace/oa-connect',headers:{'x-csrf-token':'qa'},payload});
    assert.equal(r.statusCode,409,r.body);
    assert.equal(rows.length,0);
  }finally{await close();}
});