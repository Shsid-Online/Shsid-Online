import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../public/src/submission-verification.mjs', import.meta.url), 'utf8')).replace('export async function', 'async function');
function setup(provider) {
  const elements = [];
  const removed = [];
  const timers = new Map(); let serial = 0;
  const document = { createElement(tag) {
    const element = { tag, children: [], events: {}, append(...nodes) { this.children.push(...nodes); }, setAttribute() {},
      addEventListener(event, listener) { this.events[event] = listener; }, remove() { this.removed = true; } };
    elements.push(element); return element;
  }, body: { append() {} }, head: { append() {} } };
  const window = { turnstile: provider ? {render:provider,remove:id=>removed.push(id)} : undefined };
  const context = vm.createContext({document,window,Promise,Error,setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  return {context, elements, removed, timers, window, submit:()=>vm.runInContext("submissionToken('site-key','post')",context)};
}
const flush = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };

test('checks are lazy, interaction-only, and removed after success', async () => {
  let options;
  const ui = setup((host, value)=>{options=value;return 'widget';});
  assert.equal(ui.elements.length,0);
  const pending = ui.submit(); await flush();
  assert.equal(options.appearance,'interaction-only');
  assert.equal(options.action,'post');
  assert.equal(options.retry,'never');
  options.callback('one-use-token');
  assert.equal(await pending,'one-use-token');
  assert.deepEqual(ui.removed,['widget']);
  assert.equal(ui.timers.size,0);
  assert.equal(ui.elements.find(e=>e.tag==='section').removed,true);
});
test('cancel stops the submission and another attempt can start', async () => {
  let options;
  const ui = setup((host,value)=>{options=value;return 'widget';});
  const pending = ui.submit(); await flush();
  ui.elements.find(e=>e.tag==='button').events.click();
  await assert.rejects(pending,/cancelled.*draft/);
  options.callback('late-token');
  const retry = ui.submit(); await flush(); options.callback('fresh-token');
  assert.equal(await retry,'fresh-token');
});
test('concurrent checks are refused without sending anything twice', async () => {
  let options;
  const ui=setup((host,value)=>{options=value;return 'widget';});
  const first=ui.submit(); await flush();
  await assert.rejects(ui.submit(),/Another submission/);
  options.callback('token'); await first;
});
test('provider error, expiry and timeout preserve drafts and clean up', async () => {
  for(const callback of ['error-callback','expired-callback','timeout-callback']) {
    let options;const ui=setup((host,value)=>{options=value;return 'widget';});
    const pending=ui.submit();await flush();options[callback]();
    await assert.rejects(pending,/Verification/);
    assert.equal(ui.timers.size,0);
    assert.deepEqual(ui.removed,['widget']);
  }
});
test('script failure is retryable instead of hanging or failing open', async () => {
  const ui=setup();const pending=ui.submit();await flush();
  const script=ui.elements.find(e=>e.tag==='script');
  assert.equal(script.src,'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  script.onerror();await assert.rejects(pending,/Could not load verification/);
  const retry=ui.submit();await flush();
  assert.equal(ui.elements.filter(e=>e.tag==='script').length,2);
  ui.elements.filter(e=>e.tag==='script')[1].onerror();
  await assert.rejects(retry,/Could not load verification/);
});
