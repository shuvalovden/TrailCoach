'use strict';
const { sanitizeHtml } = require('./sanitize');
const { metrics } = require('./metrics');

const ADMIN_CHAT_ID = 546691918;

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: sanitizeHtml(text), parse_mode: 'HTML' }),
  });
  if (!r.ok) {
    metrics.telegram.send_failures++;
    const errBody = await r.text();
    const sanitized = sanitizeHtml(text);
    console.error('[telegram] sendMessage failed:', errBody);
    console.error('[telegram] sanitized text (first 800 chars):', sanitized.slice(0, 800));
  }
}

function alertAdmin(message) {
  sendTelegramMessage(ADMIN_CHAT_ID, message).catch(() => {});
}

async function registerTelegramCommands() {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start',    description: 'Getting started and command list' },
        { command: 'connect',  description: 'Connect your Strava account' },
        { command: 'sync30d',  description: 'Sync data from Strava' },
        { command: 'feedback', description: 'Weekly training feedback' },
        { command: 'plan',     description: 'Training plan for the week' },
      ],
    }),
  });
  if (!r.ok) {
    const errBody = await r.text();
    console.error('[telegram] setMyCommands failed:', errBody);
  } else {
    console.log('[telegram] commands registered');
  }
}

module.exports = { sendTelegramMessage, alertAdmin, registerTelegramCommands };
