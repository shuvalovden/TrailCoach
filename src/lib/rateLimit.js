'use strict';
const { metrics } = require('./metrics');

const rateLimitMap = new Map();

function checkRateLimit(userId, command = 'unknown') {
  const today = new Date().toISOString().slice(0, 10);
  let entry = rateLimitMap.get(userId) ?? { count: 0, date: today };
  if (entry.date !== today) entry = { count: 0, date: today };
  if (entry.count >= 20) {
    metrics.ratelimit.hits_total++;
    console.log(`[ratelimit] hit user_id=${userId} command=${command}`);
    return false;
  }
  entry.count++;
  rateLimitMap.set(userId, entry);
  return true;
}

module.exports = { checkRateLimit };
