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
    window: { location: { hostname: 'localhost' }, addEventListener() {} }, document,
    localStorage: { getItem: () => null, setItem() { writes++; } },
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: fn => { timers.set(++id, fn); return id; }
  });
  const run = code => vm.runInContext(code, context);
  run(source); context.countRender = () => { renders++; };
  run('var renderPage = render; render = countRender; bindEvents();');
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

test('Instagram queue shows cooldown, safe retry and uncertain-publication review separately', () => {
  const u = ui();
  u.context.queueFixture = { active: false, connected: true, pendingImmediate: true, retryAt: Date.now() + 60000,
    entries: [
      { id: 'waiting', status: 'processing', caption: 'Waiting', imageUrl: '/test.jpg', retryAt: Date.now() + 60000 },
      { id: 'failed', status: 'failed', caption: 'Failed', imageUrl: '/test.jpg', error: '<script>secret</script>' },
      { id: 'uncertain', status: 'review', caption: 'Review', imageUrl: '/test.jpg' }
    ] };
  u.run('instagramQueue = queueFixture;');
  const html = u.run('renderInstagramQueue()');
  assert.match(html, /Instagram cooldown until/);
  assert.match(html, /Selected item pending automatic publication/);
  assert.match(html, /\(automatic\)/);
  assert.match(html, /data-action="instagram-retry" data-id="failed"/);
  assert.doesNotMatch(html, /data-action="instagram-retry" data-id="uncertain"/);
  assert.match(html, /data-action="instagram-resolve" data-id="uncertain"/);
  assert.doesNotMatch(html, /<script>secret/);
});

test('moderator cards expose hide only, while admins see hidden status and restoration', () => {
  const u = ui();
  u.run('state.currentUser={id:"mod",role:"moderator",englishName:"gh2323"};');
  u.context.postFixture = { id: 'p', title: 'Post', text: 'Text', category: 'school', likes: [], comments: [], canHide: true };
  let html = u.run('renderThreadCard(normalizePost(postFixture),0)');
  assert.match(html, /data-action="hide-post"/);
  assert.doesNotMatch(html, /data-action="(?:restore-post|delete-post|instagram-queue|open-reply)"/);
  u.run('state.currentUser.role="admin";postFixture.hidden=true;');
  html = u.run('renderThreadCard(normalizePost(postFixture),0)');
  assert.match(html, /Hidden from readers/);
  assert.match(html, /data-action="restore-post"/);
  u.run('state.currentUser.role="student";');
  html = u.run('renderThreadCard(normalizePost(postFixture),0)');
  assert.doesNotMatch(html, /data-action="(?:hide-post|restore-post)"/);
});

test('signing out clears privileged posts and ignores an outstanding admin feed response', async () => {
  const u = ui(); let completeAdminFeed;
  u.run('state.token="admin";state.currentUser={id:"admin",role:"admin"};state.posts=[{id:"secret",hidden:true}];');
  u.context.fetch = async (url, options) => {
    if (url.includes('/posts') && options.headers.Authorization) return new Promise(resolve => { completeAdminFeed = resolve; });
    return Response.json(url.includes('/posts') ? {posts:[]} : {ok:true});
  };
  const pending = u.run('fetchPosts()');
  await u.run('logout()');
  completeAdminFeed(Response.json({posts:[{id:'secret',hidden:true}]}));
  await pending;
  assert.equal(u.run('state.posts.length'),0);
  assert.equal(u.run('state.currentUser'),null);
});

test('non-admin rendering filters previously loaded hidden posts', () => {
  const u = ui();
  u.run('state.currentUser=null;state.posts=[{id:"secret",hidden:true,category:"school"}];');
  assert.equal(u.run('filteredPosts().length'),0);
});

test('moderator page renders without composer or administration panels', () => {
  const u = ui(); const app = {innerHTML:''};
  u.document.querySelector = selector => selector === '#app' ? app : null;
  u.run('state.currentUser={id:"mod",role:"moderator",englishName:"gh2323"};renderPage();');
  assert.match(app.innerHTML,/gh2323/);
  assert.match(app.innerHTML,/Moderator/);
  assert.doesNotMatch(app.innerHTML,/id="composer-(?:title|body)"/);
  assert.doesNotMatch(app.innerHTML,/data-action="instagram-/);
});

test('startup renders before network settles and hydrates the session and feed in one request', async () => {
  const u=ui(); let finish; const calls=[];
  u.run('state.token="mod-token";');
  u.context.fetch=async url=>{ calls.push(url); return new Promise(resolve=>{finish=resolve;}); };
  const pending=u.run('initialize()');
  assert.equal(u.renders,1);
  assert.equal(calls.length,1);
  assert.match(calls[0],/includeViewer=1/);
  finish(Response.json({viewer:{id:'mod',role:'moderator'},posts:[{id:'p',canHide:true}]}));
  await pending;
  assert.equal(u.run('state.currentUser.role'),'moderator');
  assert.equal(u.run('state.posts.length'),1);
  assert.equal(calls.length,1);
});

test('startup failure keeps the usable interface and existing token', async () => {
  const u=ui(); u.run('state.token="valid";');
  u.context.fetch=async()=>Response.json({error:'temporarily unavailable'},{status:503});
  await u.run('initialize()');
  assert.ok(u.renders>=2);
  assert.equal(u.run('postsLoading'),false);
  assert.equal(u.run('postsError'),'temporarily unavailable');
  assert.equal(u.run('state.token'),'valid');
});

test('expired session becomes a guest from the same feed response', async () => {
  const u=ui(); u.run('state.token="expired";');
  u.context.fetch=async()=>Response.json({viewer:null,posts:[{id:'public'}]});
  await u.run('initialize()');
  assert.equal(u.run('state.token'),'');
  assert.equal(u.run('state.currentUser'),null);
  assert.equal(u.run('state.posts[0].id'),'public');
});

test('successful login closes immediately and does not await secondary account requests', async () => {
  const u=ui();
  u.run('state.token="new";state.currentUser={id:"admin",role:"admin"};state.authOpen=true;fetchNotifications=()=>new Promise(()=>{});fetchAutopostJob=()=>new Promise(()=>{});fetchAdminBoardMetadata=()=>new Promise(()=>{});');
  u.context.fetch=async()=>Response.json({posts:[]});
  const done=u.run('finishAuthFlow()');
  assert.equal(u.run('state.authOpen'),false);
  assert.equal(u.renders,1);
  await done;
  assert.equal(u.run('state.token'),'new');
});

test('board refresh failure after login does not report failed authentication', async () => {
  const u=ui();
  u.run('state.token="new";state.currentUser={id:"mod",role:"moderator"};state.authOpen=true;');
  u.context.fetch=async()=>Response.json({error:'Feed unavailable'},{status:503});
  await u.run('finishAuthFlow()');
  assert.equal(u.run('state.authOpen'),false);
  assert.equal(u.run('state.token'),'new');
  assert.equal(u.run('postsError'),'Feed unavailable');
});

test('old notifications and admin metadata cannot reappear after logout', async () => {
  const u=ui(); const complete=[];
  u.run('state.token="admin";state.currentUser={role:"admin"};');
  u.context.fetch=async()=>new Promise(resolve=>complete.push(resolve));
  const notification=u.run('fetchNotifications()');
  const metadata=u.run('fetchAdminBoardMetadata()');
  u.run('state.token="";state.currentUser=null;');
  complete[0](Response.json({notifications:[{id:'private'}]}));
  complete[1](Response.json({adminAnonymousNumbers:[1234]}));
  await Promise.all([notification,metadata]);
  assert.equal(u.run('state.notifications.length'),0);
  assert.equal(u.run('state.adminAnonymousNumbers.length'),0);
});

test('background refresh does not redraw a login form being edited', async () => {
  const u=ui();u.run('state.authOpen=true;');
  await u.run('refreshSecondaryData()');
  assert.equal(u.renders,0);
});

test('feed rendering preserves a password and cursor already being entered', () => {
  const u=ui(); const app={innerHTML:''};
  const oldInput={id:'auth-password',value:'unsent-password',selectionStart:4,selectionEnd:4};
  const newInput={value:'',type:'password',focus(){this.focused=true;},setSelectionRange(a,b){this.selection=[a,b];}};
  u.document.activeElement=oldInput;
  u.document.querySelector=s=>s==='#app'?app:null;
  u.document.querySelectorAll=s=>s==='#auth-modal input'?[oldInput]:[];
  u.document.getElementById=()=>newInput;
  u.run('state.authOpen=true;state.authStep="password";renderPage();');
  assert.equal(newInput.value,'unsent-password');
  assert.equal(newInput.focused,true);
  assert.deepEqual(newInput.selection,[4,4]);
});

test('verification configuration failure never sends or retries a post', async () => {
  const u=ui(); const calls=[];
  u.context.fetch=async (url,options)=>{calls.push([url,options.method]);return Response.json({error:'temporarily unavailable'},{status:503});};
  u.run('state.composerBody="unsent draft";');
  await assert.rejects(u.run('apiRequest("/posts",{method:"POST",body:{text:"unsent draft"}})'),/temporarily unavailable/);
  assert.equal(calls.length,1);
  assert.match(calls[0][0],/\/posting-config$/);
  assert.equal(calls[0][1],'GET');
  assert.equal(u.run('state.composerBody'),'unsent draft');
});

test('staged rollout submits once and never replays a failed write', async () => {
  const u=ui();const calls=[];
  u.context.fetch=async (url,options)=>{
    calls.push([url,options.method]);
    if(url.endsWith('/posting-config')) return Response.json({required:false,siteKey:''});
    throw Error('network changed');
  };
  await assert.rejects(u.run('apiRequest("/posts",{method:"POST",body:{text:"draft"}})'),/network changed/);
  assert.deepEqual(calls.map(c=>c[1]),['GET','POST']);
});
