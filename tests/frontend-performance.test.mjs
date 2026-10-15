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
