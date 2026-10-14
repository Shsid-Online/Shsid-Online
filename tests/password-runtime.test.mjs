import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

test('password hashing works in the Cloudflare runtime at the deployed compatibility date', async () => {
  const mf = new Miniflare({ compatibilityDate: '2026-05-08', modules: [
    { type: 'ESModule', path: 'entry.mjs', contents: `import {hashPassword,verifyPassword} from './passwords.mjs';
      export default { async fetch() {
        const hash = await hashPassword('runtime-test-password');
        return Response.json({ valid: await verifyPassword('runtime-test-password', hash),
          rejectsWrong: !await verifyPassword('wrong', hash), hidden: !hash.includes('runtime-test-password') });
      } };` },
    { type: 'ESModule', path: 'passwords.mjs', contents: await readFile(new URL('../worker/passwords.mjs', import.meta.url), 'utf8') }
  ] });
  try {
    const response = await mf.dispatchFetch('https://test.invalid/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { valid: true, rejectsWrong: true, hidden: true });
  } finally { await mf.dispose(); }
});
