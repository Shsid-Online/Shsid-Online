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
  if (nonEmptyParts.length && nonEmptyParts.every(part => /^gay(?:\s*#\d+)?$/.test(part))) return 'single_word_spam';
  if (normalizedText === 'automated spam poc — delete me') return 'automated_spam';
  if (/^stress \d{8}-\d{6}-[a-f0-9]+ #\d+\/\d+ please ignore, will delete$/.test(normalizedText)) return 'automated_spam';
  return '';
}

module.exports = { BLOCKED_CHINESE_PHRASE, blockedPostReason };
