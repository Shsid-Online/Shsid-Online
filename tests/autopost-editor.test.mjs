import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const appSource = fs.readFileSync(new URL('../public/src/app.js', import.meta.url), 'utf8').split('initialize().catch(')[0];
function editor(job = { entries: [] }) {
  let controls = [];
  const context = vm.createContext({
    crypto: webcrypto, structuredClone, console, AbortSignal,
    window: { location: { hostname: 'localhost' } },
    localStorage: { getItem: () => null },
    document: { querySelector: () => null, querySelectorAll: selector => controls.filter(c => c.selector === selector), addEventListener() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const run = code => vm.runInContext(code, context);
  run(appSource);
  context.job = job;
  run('state.currentUser = {role:"admin"}; state.autopostJob = normalizeAutopostJob(job); render = () => {}; toast = message => { state.toast = message; };');
  function control(selector, dataset) {
    const c = { selector, dataset, addEventListener(type, fn) { this[type] = fn; } };
    controls = [c]; run('bindEvents()'); return c;
  }
  const click = dataset => control('[data-action]', dataset).click();
  const input = (id, value) => { const c = control('[data-autopost-text]', { autopostText: id }); c.value = value; c.input({target:c}); };
  return { run, context, click, input };
}
const entry = (id, text, extra={}) => ({id, text, ...extra});

test('duplicate legacy IDs and starter drafts stay independent through next/previous', async () => {
  const e = editor({entries:[entry('same','first'),entry('same','second')],defaultEntries:[entry('same','starter')]});
  assert.equal(e.run('new Set(state.autopostJob.entries.map(e=>e.id)).size'),2);
  const second = e.run('state.autopostJob.entries[1].id');
  await e.click({action:'autopost-navigate',index:'1'}); e.input(second,'edited second');
  await e.click({action:'autopost-navigate',index:'0'});
  assert.equal(e.run('state.autopostJob.entries[0].text'),'first');
  assert.equal(e.run('state.autopostJob.entries[1].text'),'edited second');
  await e.click({action:'autopost-load-defaults'});
  const firstId = e.run('state.autopostJob.entries[0].id');
  await e.click({action:'autopost-load-defaults'});
  assert.notEqual(e.run('state.autopostJob.entries[0].id'), firstId);
});

test('failed reload keeps editor, save buttons and selected photos; dirty reload never replaces drafts', async () => {
  const e = editor({entries:[entry('a','keep')]});
  e.run('autopostPhotoFilesByEntryId.set("a", [{name:"photo"}]); apiRequest = async () => {throw new Error("offline")};');
  await e.click({action:'autopost-reload'});
  assert.equal(e.run('state.autopostJob.entries[0].text'),'keep');
  assert.equal(e.run('autopostPhotoFilesByEntryId.size'),1);
  assert.match(e.run('renderAutopostAdminPanel()'),/Save queue/);
  assert.equal(e.run('autopostBusy'),false);
  e.input('a','unsaved');
  e.run('apiRequest = async () => ({job:{entries:[]}})');
  await e.click({action:'autopost-reload'});
  assert.equal(e.run('state.autopostJob.entries[0].text'),'unsaved');
});

test('save prevents overlapping actions and keeps selected ID after reordered response', async () => {
  const e = editor({entries:[entry('a','first'),entry('b','second')]});
  e.run('autopostEntryIndex=1; state.autopostDirty=true; var resolveSave; apiRequest=()=>new Promise(resolve=>resolveSave=resolve)');
  const pending=e.click({action:'autopost-save'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(e.run('autopostBusy'),true);
  await e.click({action:'autopost-add-entry'});
  assert.equal(e.run('state.autopostJob.entries.length'),2);
  e.run('resolveSave({job:{entries:[{id:"b",text:"second"},{id:"a",text:"first"}]}})');
  await pending;
  assert.equal(e.run('autopostEntryIndex'),0);
  assert.equal(e.run('autopostBusy'),false);
  assert.equal(e.run('state.autopostDirty'),false);
});

test('save failure unlocks editor and retains successful uploads for retry', async () => {
  const e = editor({entries:[entry('a','draft')]});
  e.run('state.autopostDirty=true; autopostPhotoFilesByEntryId.set("a",[{name:"photo"}]); var uploads=0; uploadPhotos=async()=>{uploads++;return [{url:"photo-url"}]}; apiRequest=async()=>{throw new Error("offline")};');
  await e.click({action:'autopost-save'});
  await e.click({action:'autopost-save'});
  assert.equal(e.run('uploads'),1);
  assert.equal(e.run('state.autopostJob.entries[0].media.length'),1);
  assert.equal(e.run('state.autopostDirty'),true);
  assert.equal(e.run('autopostBusy'),false);
});

test('posted history is hidden and duplicate keeps selected photos', async () => {
  const e=editor({entries:[entry('posted','history',{postedAt:'2026-01-01'}),entry('pending','draft')]});
  assert.deepEqual(e.run('state.autopostJob.entries.map(entry => entry.id)'),['pending']);
  assert.equal(e.run('state.autopostJob.postedCount'),0);
  e.run('autopostPhotoFilesByEntryId.set("pending",[{name:"photo"}])');
  await e.click({action:'autopost-duplicate-entry',id:'pending'});
  assert.equal(e.run('autopostPhotoFilesByEntryId.get(state.autopostJob.entries[1].id).length'),1);
});

test('late refresh cannot overwrite typing', async () => {
  const e=editor({entries:[entry('a','original')]});
  e.run('var resolveLoad; apiRequest=async path=>path.includes("instagram")?{}:new Promise(resolve=>resolveLoad=resolve)');
  const pending=e.run('fetchAutopostJob()');
  await new Promise(resolve=>setImmediate(resolve));
  e.input('a','typed while loading');
  e.run('resolveLoad({job:{entries:[{id:"a",text:"old"}]}})');
  await pending;
  assert.equal(e.run('state.autopostJob.entries[0].text'),'typed while loading');
});

const workerSource=fs.readFileSync(new URL('../worker/index.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace('export default {','const worker = {');
test('autopost quiet hours run from 03:00 through 07:59 in Seoul',()=>{
  const context=vm.createContext({crypto:webcrypto,TextEncoder,console});
  vm.runInContext(workerSource,context);
  assert.equal(vm.runInContext('isAutopostQuietTime(Date.parse("2026-10-04T17:59:00Z"))',context),false);
  assert.equal(vm.runInContext('isAutopostQuietTime(Date.parse("2026-10-04T18:00:00Z"))',context),true);
  assert.equal(vm.runInContext('isAutopostQuietTime(Date.parse("2026-10-04T22:59:59Z"))',context),true);
  assert.equal(vm.runInContext('isAutopostQuietTime(Date.parse("2026-10-04T23:00:00Z"))',context),false);
  assert.equal(vm.runInContext('new Date(nextAllowedAutopostTime(Date.parse("2026-10-04T20:15:00Z"))).toISOString()',context),'2026-10-04T23:00:00.000Z');
});

test('worker removes posted drafts and does not resurrect a post published since the editor loaded',async()=>{
  const context=vm.createContext({crypto:webcrypto,TextEncoder,console});
  vm.runInContext(workerSource,context);
  context.body={entries:[entry('done','stale pending'),entry('apq_local_blank',''),entry('new','new draft')]};
  context.job={id:'job',category:'school',next_index:1,queue_json:JSON.stringify([entry('done','published',{postedAt:'2026-01-01'}),entry('new','new draft')])};
  let saved;
  context.env={DB:{prepare(sql){return {bind(...values){if(sql.startsWith("update")) saved=values;return this},async run(){},async first(){return context.job}}}}};
  await vm.runInContext('saveAutopostJob(env,job,body)',context);
  const queue=JSON.parse(saved[1]);
  assert.deepEqual(queue.map(e=>e.id),['apq_local_blank','new']);
  assert.equal(queue[0].requestedAnonymousNumber,null);
  assert.equal(saved[2],0);
});

test('blank draft remains selected after save and cannot start the countdown', async () => {
  const e=editor({entries:[entry('a','existing'),entry('blank','')]});
  e.run('autopostEntryIndex=1; apiRequest=async(path,options)=>({job:{entries:options.body.entries}})');
  await e.click({action:'autopost-save'});
  assert.equal(e.run('state.autopostJob.entries[autopostEntryIndex].id'),'blank');
  await e.click({action:'autopost-start'});
  assert.match(e.run('autopostError'),/empty drafts/);
  assert.equal(e.run('autopostBusy'),false);
});

test('local backend removes posted drafts and preserves pending blank drafts',()=>{
  const source=fs.readFileSync(new URL('../server/server.js',import.meta.url),'utf8');
  function definition(name) {
    const start=source.indexOf(`function ${name}(`);
    return source.slice(start,source.indexOf('\n}',start)+2);
  }
  const context=vm.createContext({
    AUTPOST_CATEGORY:'school',AUTPOST_MIN_DELAY_MINUTES:60,AUTPOST_MAX_DELAY_MINUTES:360,MAX_TITLE_LEN:200,MAX_TEXT_LEN:10000,
    sanitizeCategory:v=>v||'school',sanitizeMediaItems:v=>v||[],ensureUnusedAnonymousAccountNumber:v=>v??null,
    now:()=> '2026-10-02',store:{save(){}},clampAutopostDelay:(v,f)=>v||f,
    body:{entries:[entry('done','stale'),entry('apq_local_blank','')]},
    job:{nextIndex:1,entries:[entry('done','history',{postedAt:'2026-01-01'})]},
  });
  vm.runInContext(['autopostEntriesFromJob','sanitizeAutopostDraftEntries','saveAutopostJobFromBody'].map(definition).join('\n'),context);
  const result=vm.runInContext('saveAutopostJobFromBody(job,body)',context);
  assert.deepEqual(Array.from(result.entries,e=>e.id),['apq_local_blank']);
  assert.equal(result.entries[0].requestedAnonymousNumber,null);
});
