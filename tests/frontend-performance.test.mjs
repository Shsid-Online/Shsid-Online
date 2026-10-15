import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../public/src/app.js', import.meta.url), 'utf8').split('initialize().catch(')[0];
function ui() {
  const timers = new Map(); let id = 0; let writes = 0; let renders = 0; let focused = 0;
  const input = { value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { this[type] = fn; }, focus() { focused++; }, setSelectionRange() {} };
  const document = { activeElement: input, querySelector: s => s === '#search-input' ? input : null,
    querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ crypto: webcrypto, structuredClone, console, AbortSignal,
    window: { location: { hostname: 'localhost' } }, document,
    localStorage: { getItem: () => null, setItem() { writes++; } },
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: fn => { timers.set(++id, fn); return id; }
  });
  const run = code => vm.runInContext(code, context);
  run(source); context.countRender = () => { renders++; };
  run('render = countRender; bindEvents();');
  return { input, document, context, run, timers,
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    get writes() { return writes; }, get renders() { return renders; }, get focused() { return focused; } };
}
test('typing a search burst produces one render and saves only final text', () => {
  const u = ui();
  for (const value of ['a','ab','abc']) { u.input.value=value; u.input.input({target:u.input}); }
  assert.equal(u.renders,0); assert.equal(u.timers.size,1);
  u.flush(); assert.equal(u.renders,1); assert.equal(u.writes,1);
  assert.equal(u.run('state.search'),'abc'); assert.equal(u.focused,1);
});
test('search does not interrupt Chinese input composition or steal focus', () => {
  const u=ui();u.input.value='中';u.input.input({target:u.input,isComposing:true});
  assert.equal(u.timers.size,0);
  u.input.compositionend({target:u.input});u.document.activeElement={};u.flush();
  assert.equal(u.renders,1);assert.equal(u.focused,0);
});
test('unchanged settings avoid repeated synchronous storage writes', () => {
  const u=ui();u.run('saveState(); saveState(); state.composerBody="draft"; saveState();');
  assert.equal(u.writes,1);
  u.run('state.board="school"; saveState();');assert.equal(u.writes,2);
});
test('unavailable storage does not crash actions and later saves retry', () => {
  const u=ui();let attempts=0;
  u.context.localStorage.setItem=()=>{attempts++;if(attempts===1)throw new Error('quota');};
  u.run('saveState();saveState();saveState();');assert.equal(attempts,2);
});
test('fallback scroll bursts perform one pagination check per frame', () => {
  const u=ui();u.run('var checks=0;maybeLoadMorePosts=()=>checks++;');
  u.run('schedulePostsScrollCheck();schedulePostsScrollCheck();schedulePostsScrollCheck();');
  assert.equal(u.timers.size,1);u.flush();assert.equal(u.run('checks'),1);
  u.run('schedulePostsScrollCheck();');u.flush();assert.equal(u.run('checks'),2);
});

test('edge challenges give recovery instructions without retrying writes or losing drafts', async () => {
  const u = ui(); let calls = 0;
  u.context.fetch = async () => { calls++; return new Response('<html>challenge</html>', {
    status: 403, headers: { 'cf-mitigated': 'challenge' }
  }); };
  u.run('state.composerBody = "keep this draft";');
  await assert.rejects(u.run('apiRequest("/posts", {method:"POST", body:{body:"draft"}})'),
    error => error.code === 'BROWSER_VERIFICATION_REQUIRED' && /Copy any unsent text/.test(error.message));
  assert.equal(calls, 1);
  assert.equal(u.run('state.composerBody'), 'keep this draft');
});

test('edge challenge on profile fetch preserves the login token', async () => {
  const u = ui(); u.run('state.token = "existing-token";');
  u.context.fetch = async () => new Response('', {status:403, headers:{'cf-mitigated':'challenge'}});
  await assert.rejects(u.run('fetchCurrentUser()'), error => error.code === 'BROWSER_VERIFICATION_REQUIRED');
  assert.equal(u.run('state.token'), 'existing-token');
});

test('real authentication failures still clear invalid tokens', async () => {
  const u = ui(); u.run('state.token = "expired";');
  u.context.fetch = async () => new Response('{"error":"Unauthorized"}', {status:401});
  await u.run('fetchCurrentUser()');
  assert.equal(u.run('state.token'), '');
});

test('successful API responses are unchanged', async () => {
  const u = ui();
  u.context.fetch = async () => new Response('{"posts":[]}');
  assert.equal(JSON.stringify(await u.run('apiRequest("/posts")')), '{"posts":[]}');
});

test('photo upload challenges are explained without replaying the upload', async () => {
  const u = ui(); let calls = 0;
  u.context.fetch = async () => ++calls === 1
    ? new Response('{"uploadUrl":"https://www.shsid.online/upload/example","method":"PUT"}')
    : new Response('', {status:403, headers:{'cf-mitigated':'challenge'}});
  await assert.rejects(u.run('uploadSinglePhoto({name:"photo.png", type:"image/png"})'),
    error => error.code === 'BROWSER_VERIFICATION_REQUIRED');
  assert.equal(calls, 2);
});

test('apex board API stays on the same host for browser clearance', () => {
  const u = ui();
  const context = vm.createContext({...u.context, window:{location:{hostname:'shsid.online'}}});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('API_BASE', context), 'https://shsid.online/api');
});
