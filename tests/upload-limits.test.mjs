import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadSizeError, rememberUpload, ownsUpload, partSizeLimit, validParts } from '../worker/upload-limits.mjs';
test('multipart ownership binds both account and object key', async () => {
  const records = new Map(); const env = { SESSIONS: { put: async (k,v) => records.set(k,v), get: async k => JSON.parse(records.get(k) || 'null') } };
  await rememberUpload(env, 'uploads/random', 'id', 'alice');
  assert.equal(await ownsUpload(env, 'uploads/random', 'id', 'alice'), true);
  assert.equal(await ownsUpload(env, 'uploads/random', 'id', 'bob'), false);
  assert.equal(await ownsUpload(env, 'verification/random', 'id', 'alice'), false);
  assert.equal(await ownsUpload(env, 'uploads/random', 'missing', 'alice'), false);
});
test('multipart chunks and completion lists cannot exceed total size budgets', () => {
  assert.equal(partSizeLimit('uploads/a', 4), 1024 * 1024);
  assert.equal(partSizeLimit('uploads/a', 5), 0);
  assert.equal(partSizeLimit('verification/a', 13), 4 * 1024 * 1024);
  assert.equal(partSizeLimit('verification/a', 14), 0);
  assert.equal(validParts('uploads/a', [{ partNumber: 1, etag: 'ok' }]), true);
  assert.equal(validParts('uploads/a', [{ partNumber: 1, etag: 'ok' }, { partNumber: 1, etag: 'ok' }]), false);
  assert.equal(validParts('uploads/a', [{ partNumber: 5, etag: 'ok' }]), false);
});
test('storage writes reject unknown, oversized, malformed and empty lengths', () => {
  for (const [value, status] of [[null, 411], ['abc', 411], ['101', 413], ['0', 400], ['100', null]]) {
    const request = new Request('https://test.invalid', { headers: value === null ? {} : { 'Content-Length': value } });
    assert.equal(uploadSizeError(request, 100)?.status ?? null, status);
  }
});
