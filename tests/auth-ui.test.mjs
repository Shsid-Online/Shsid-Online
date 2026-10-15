import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = fs.readFileSync(new URL('../public/src/app.js', import.meta.url), 'utf8').split('initialize().catch(')[0];
function ui() {
  const fields = { '#auth-email': {value:'anon2221'}, '#auth-password': {value:'test-password'}, '#auth-password-confirm': {value:'test-password'}, '#auth-username': {value:'example-student'} };
  const context = vm.createContext({ crypto:webcrypto, structuredClone, console, AbortSignal, fields,
    window:{location:{hostname:'localhost'}},localStorage:{getItem:()=>null,setItem(){}},
    document:{querySelector:s=>fields[s] || null,querySelectorAll:()=>[],addEventListener(){}},
    setTimeout,clearTimeout,setInterval,clearInterval });
  const run = code => vm.runInContext(code, context);
  run(source);
  run('toast = m => {state.toast=m}; saveState=()=>{}; render=()=>{Object.values(fields).forEach(f=>f.value="")}; finishAuthFlow=async()=>{};');
  return {run,context};
}
test('registration preserves username and confirmation across loading render', async () => {
  const u=ui();
  u.run('state.authMode="register"; state.pendingEmail="test@example.invalid"; apiRequest=async(path,options)=>{state.submitted=options.body; return {user:{englishName:"example-student"},session:{token:"new"}}};');
  await u.run('submitPassword({preventDefault(){}})');
  assert.equal(u.run('state.submitted.username'),'example-student');
  assert.equal(u.run('state.submitted.password'),'test-password');
  assert.equal(u.run('state.token'),'new');
});
test('transient failures preserve session, authentication denial clears it', async () => {
  for (const status of [503,429,undefined,401,403]) {
    const u=ui(); u.context.status=status;
    u.run('state.token="valid"; apiRequest=async()=>{throw Object.assign(new Error("test"),{status})};');
    await u.run('fetchCurrentUser()');
    assert.equal(u.run('state.token'),[401,403].includes(status)?'':'valid');
  }
});
test('API errors preserve HTTP status for authentication decisions', async () => {
  const u=ui(); u.context.fetch=async()=>new Response(JSON.stringify({error:'Denied'}),{status:403});
  await assert.rejects(u.run('apiRequest("/me")'), e=>e.status===403);
});
test('hosting quota errors explain the reset without retrying', async () => {
  const u=ui(); let requests=0;
  u.context.fetch=async()=>{requests++;return new Response('error code: 1027',{status:429});};
  await assert.rejects(u.run('apiRequest("/posts")'), e=>e.status===429 && /daily hosting limit/.test(e.message));
  assert.equal(requests,1);
});
test('ordinary throttling is not mistaken for daily quota exhaustion', async () => {
  const u=ui();
  u.context.fetch=async()=>new Response(JSON.stringify({error:'Slow down'}),{status:429});
  await assert.rejects(u.run('apiRequest("/posts")'), e=>e.message==='Slow down');
});
test('login accepts a username and sends it as an identifier', async () => {
  const u=ui();
  u.run('state.authMode="login"; state.pendingEmail="anon2221"; apiRequest=async(path,options)=>{state.submitted=options.body; return {user:{role:"admin",englishName:"anon2221"},session:{token:"new"}}};');
  await u.run('submitPassword({preventDefault(){}})');
  assert.equal(u.run('state.submitted.identifier'),'anon2221');
  assert.equal(u.run('state.submitted.email'),undefined);
});
test('auth screen clearly supports username login without removing email registration', () => {
  const u=ui();
  const html=u.run('state.authOpen=true; state.authStep="email"; renderAuthModal()');
  assert.match(html,/Email or username/);
  assert.match(html,/Creating an account still requires an email/);
  assert.match(html,/autocomplete="username"/);
});
