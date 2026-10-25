import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

test('published lightweight script matches the tested source', async () => {
  const source=readFileSync(new URL('../public/src/app.js',import.meta.url),'utf8');
  const built=readFileSync(new URL('../public/src/app.min.js',import.meta.url),'utf8');
  const result=await transform(source,{minify:true,format:'esm'});
  assert.equal(built,result.code,'Run npm run build:frontend after changing app.js');
  assert.ok(Buffer.byteLength(built)<Buffer.byteLength(source)*0.7);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/type="module" src="\.\/src\/app.min.js/);
  assert.match(html,/role="status">Loading threads/);
});
