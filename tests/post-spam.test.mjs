import test from 'node:test';
import assert from 'node:assert/strict';
import spam from '../server/post-spam.cjs';

const { blockedPostReason } = spam;

test('blocks the requested Chinese phrase across punctuation and spacing', () => {
  assert.equal(blockedPostReason('', '马校长万岁，'), 'blocked_phrase');
  assert.equal(blockedPostReason('马 校长', '万岁!'), 'blocked_phrase');
  assert.equal(blockedPostReason('', '马校长今天万岁'), '');
});

test('blocks only standalone gay posts and preserves ordinary sentences', () => {
  for (const value of ['gay', ' GAY ', 'ｇａｙ']) assert.equal(blockedPostReason('', value), 'single_word_spam');
  assert.equal(blockedPostReason('gay', ''), 'single_word_spam');
  assert.equal(blockedPostReason('', 'I am gay'), '');
  assert.equal(blockedPostReason('discussion', 'gay rights'), '');
  assert.equal(blockedPostReason('gay', 'context'), '');
});

test('numbered spam and automated test batches are blocked', () => {
  assert.equal(blockedPostReason('GAY #384', 'GAY'), 'single_word_spam');
  assert.equal(blockedPostReason('gay', 'gay'), 'single_word_spam');
  assert.equal(blockedPostReason('spam #753', 'automated spam PoC — delete me'), 'automated_spam');
  assert.equal(blockedPostReason('', 'STRESS 20261014-144037-fb97ba53 #54/100 please ignore, will delete'), 'automated_spam');
  assert.equal(blockedPostReason('GAY #384 discussion', 'GAY'), '');
  assert.equal(blockedPostReason('', 'stress about exams'), '');
  assert.equal(blockedPostReason('YOU ARE HACKED #527', 'FUCK YOU UR HACKED'), 'automated_spam');
  assert.equal(blockedPostReason('Were you hacked?', 'How do I secure my account?'), '');
});
