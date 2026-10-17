import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submissionAction, verifySubmission } from '../worker/submission-verification.mjs';
import { protectRequest, rejectDuplicate } from '../worker/abuse-protection.mjs';
import worker from '../worker/index.js';

const env = () => ({ SUBMISSION_VERIFICATION: 'required', TURNSTILE_SITE_KEY: 'public-test-key', TURNSTILE_SECRET_KEY: 'private-test-key', UPLOAD_SIGNING_SECRET: 'test-signing-secret' });
const req = (headers = {}, host = 'www.shsid.online') => new Request(`https://${host}/api/posts`, { method: 'POST', headers: { 'X-Submission-Token': 'test-token', ...headers } });
const accepted = async () => Response.json({ success: true, hostname: 'www.shsid.online', action: 'post' });
const allow = { limit: async () => ({ success: true }) };

test('only content submissions require per-action verification', () => {
  assert.equal(submissionAction('POST', '/posts'), 'post');
  assert.equal(submissionAction('POST', '/posts/p/comments'), 'comment');
  for (const [method, path] of [['GET','/posts'],['DELETE','/posts/p'],['POST','/posts/p/like']]) assert.equal(submissionAction(method,path), '');
});
test('explicit staged rollout does not break existing clients', async () => {
  assert.deepEqual(await verifySubmission(req(), {}, 'post', () => { throw Error('called'); }), {});
});
test('enabled verification fails closed for missing configuration or tokens', async () => {
  for (const missing of ['TURNSTILE_SITE_KEY','TURNSTILE_SECRET_KEY','UPLOAD_SIGNING_SECRET']) {
    const e = env(); delete e[missing];
    assert.equal((await verifySubmission(req(), e, 'post')).response.status, 503);
  }
  for (const token of ['', 'x'.repeat(2049)]) {
    assert.equal((await verifySubmission(req({'X-Submission-Token':token}), env(), 'post', () => { throw Error('must not call provider'); })).response.status, 403);
  }
});
test('verification sends no post contents, owner identifier, or explicit client IP', async () => {
  let payload;
  const result = await verifySubmission(req({'CF-Connecting-IP':'192.0.2.1','X-Board-Owner-Token':'untrusted'}), env(), 'post', async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    payload = JSON.parse(options.body);
    return accepted();
  });
  assert.deepEqual(payload, {secret:'private-test-key',response:'test-token'});
  assert.match(result.visitor, /^[a-f0-9-]{36}$/);
  assert.match(result.cookie, /Secure; HttpOnly; SameSite=Strict/);
  assert.match(result.cookie, /^__Host-board-visitor=/);
});
test('wrong hostname, action, failed and replayed tokens cannot authorize a post', async () => {
  for (const result of [
    {success:false,'error-codes':['timeout-or-duplicate']},
    {success:true,hostname:'evil.example',action:'post'},
    {success:true,hostname:'www.shsid.online',action:'comment'},
    {success:'true',hostname:'www.shsid.online',action:'post'}
  ]) assert.equal((await verifySubmission(req(),env(),'post',async()=>Response.json(result))).response.status,403);
  assert.equal((await verifySubmission(req({},'evil.example'),env(),'post',accepted)).response.status,403);
});
test('provider failures fail closed without exposing provider or secret details', async () => {
  for (const fetcher of [async()=>{throw Error('secret network detail');},async()=>new Response('not json'),async()=>new Response('',{status:500})]) {
    const result = await verifySubmission(req(),env(),'post',fetcher);
    assert.equal(result.response.status,503);
    assert.doesNotMatch(await result.response.text(),/secret network|private-test-key/);
  }
});
test('signed visitor survives owner token and IP rotation; tampering is not trusted', async () => {
  const first = await verifySubmission(req(),env(),'post',accepted);
  const cookie = first.cookie.split(';')[0];
  const next = await verifySubmission(req({Cookie:cookie,'X-Board-Owner-Token':'rotated','CF-Connecting-IP':'192.0.2.99'}),env(),'post',accepted);
  assert.equal(next.visitor,first.visitor);
  assert.equal(next.cookie,undefined);
  const tampered = cookie.replace(first.visitor,'0'.repeat(36));
  assert.notEqual((await verifySubmission(req({Cookie:tampered}),env(),'post',accepted)).visitor,first.visitor);
  const changedSecret = {...env(),UPLOAD_SIGNING_SECRET:'rotated-signing-secret'};
  assert.notEqual((await verifySubmission(req({Cookie:cookie}),changedSecret,'post',accepted)).visitor,first.visitor);
});
test('visitor cookies expire and cannot bypass token validation', async () => {
  const originalNow = Date.now;
  const first = await verifySubmission(req(),env(),'post',accepted);
  const cookie = first.cookie.split(';')[0];
  assert.equal((await verifySubmission(req({Cookie:cookie,'X-Submission-Token':''}),env(),'post',accepted)).response.status,403);
  try {
    Date.now = () => originalNow() + 31*86400000;
    assert.notEqual((await verifySubmission(req({Cookie:cookie}),env(),'post',accepted)).visitor,first.visitor);
  } finally { Date.now = originalNow; }
});
test('unverified writes never reach D1 or the global read allowance', async () => {
  let globalCalls = 0;
  const e = {...env(), API_RATE_LIMIT:allow,WRITE_RATE_LIMIT:allow,POST_RATE_LIMIT:allow,
    GLOBAL_GUARD:{idFromName:x=>x,get:()=>({fetch:async()=>{globalCalls++;return new Response(null,{status:204});}})}};
  Object.defineProperty(e,'DB',{get(){throw Error('database accessed');}});
  const result = await worker.fetch(req({'X-Submission-Token':''}),e);
  assert.equal(result.status,403);
  assert.equal(globalCalls,0);
});
test('posting config does not use database, sessions or global capacity', async () => {
  const e = {...env(),API_RATE_LIMIT:allow};
  for (const key of ['DB','SESSIONS','GLOBAL_GUARD']) Object.defineProperty(e,key,{get(){throw Error('expensive access');}});
  const result = await worker.fetch(new Request('https://www.shsid.online/api/posting-config'),e);
  assert.deepEqual(await result.json(),{required:true,siteKey:'public-test-key'});
  assert.equal(result.headers.get('Cache-Control'),'no-store');
});
test('verified visitor, not the client-selected owner header, supplies sustained identity', async () => {
  const owners = [];
  const e = {DUPLICATE_RATE_LIMIT:allow,GLOBAL_GUARD:{idFromName:x=>x,get:()=>({fetch:async request=>{owners.push((await request.json()).owner);return new Response(null,{status:204});}})}};
  await rejectDuplicate(e,'/posts',{text:'First'},req({'X-Board-Owner-Token':'first'}),'server-id');
  await rejectDuplicate(e,'/posts',{text:'Second'},req({'X-Board-Owner-Token':'second'}),'server-id');
  assert.equal(owners[0],owners[1]);
});
test('regional abuse limits still execute before deferred verification', async () => {
  const e = {...env(),API_RATE_LIMIT:{limit:async()=>({success:false})}};
  assert.equal((await protectRequest(req(),e,'/posts',{deferContentBudget:true})).status,429);
});
