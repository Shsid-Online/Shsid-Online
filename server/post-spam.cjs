'use strict';

const BLOCKED_CHINESE_PHRASE = '马校长万岁';

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function compact(value) {
  return normalize(value).replace(/[\s，,。.!！?？、;；:'"“”‘’（）()【】\[\]_-]+/gu, '');
}

function blockedPostReason(title, text) {
  const normalizedTitle = normalize(title);
  const normalizedText = normalize(text);
  if (compact(`${normalizedTitle} ${normalizedText}`).includes(BLOCKED_CHINESE_PHRASE)) return 'blocked_phrase';
  const nonEmptyParts = [normalizedTitle, normalizedText].filter(Boolean);
  if (nonEmptyParts.length === 1 && nonEmptyParts[0] === 'gay') return 'single_word_spam';
  return '';
}

module.exports = { BLOCKED_CHINESE_PHRASE, blockedPostReason };
