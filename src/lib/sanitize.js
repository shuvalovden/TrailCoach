'use strict';

function sanitizeHtml(text) {
  const cleaned = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>/gi, '<b>').replace(/<\/strong>/gi, '</b>')
    .replace(/<em>/gi, '<i>').replace(/<\/em>/gi, '</i>')
    .replace(/<[^>]+>/g, (tag) => /^<\/?(b|i|u|s|code|pre|a)(\s|>)/i.test(tag) ? tag : '')
    // Escape bare < that are not the start of a valid Telegram HTML tag (e.g. "HR < 145")
    .replace(/</g, (m, offset, str) => /^<\/?(b|i|u|s|code|pre|a)[\s>]/i.test(str.slice(offset)) ? m : '&lt;');

  // Balance tags: remove stray end tags, auto-close unclosed opening tags
  const stack = [];
  const balanced = cleaned.replace(/<(\/?)([a-z]+)[^>]*>/gi, (match, slash, tag) => {
    const t = tag.toLowerCase();
    if (!slash) { stack.push(t); return match; }
    const idx = stack.lastIndexOf(t);
    if (idx === -1) return ''; // stray end tag — drop it
    let prefix = '';
    while (stack.length > idx + 1) prefix += `</${stack.pop()}>`;
    stack.pop();
    return prefix + match;
  });
  let suffix = '';
  while (stack.length > 0) suffix += `</${stack.pop()}>`;
  return balanced + suffix;
}

module.exports = { sanitizeHtml };
