'use strict';
const { Router } = require('express');
const { findOrCreateUser } = require('../lib/users');
const { sendTelegramMessage, alertAdmin } = require('../lib/telegram');
const { getCoachingResponse, getFeedbackResponse, getPlanResponse } = require('../services/claude');
const { syncStravaActivities } = require('../services/strava');
const { metrics } = require('../lib/metrics');
const { STRAVA_CLIENT_ID } = require('../lib/clients');

const router = Router();

router.post('/webhook/telegram', async (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  metrics.telegram.messages_total++;

  // Respond 200 immediately — Telegram retries on any non-2xx or timeout
  res.json({ ok: true });

  const message = req.body?.message;
  if (!message?.text) return;
  const chatId = message.chat.id;

  try {
    const userText = message.text.trim();

    const user = await findOrCreateUser(chatId);
    if (!user.is_active) {
      await sendTelegramMessage(chatId, 'Access restricted.');
      return;
    }

    let reply;
    if (userText.startsWith('/start')) {
      metrics.telegram.messages_by_command.start++;
      reply = `<b>Hey! I'm your personal trail-running coach 🏔</b>

I analyse your Strava workouts and give concrete training recommendations.

<b>Getting started:</b>
1. Connect Strava: /connect
2. Load workouts: /sync30d
3. Done — ask me anything!

<b>Commands:</b>
- /connect — connect your Strava account
- /sync30d — sync data from Strava (last 30 days)
- /feedback — analysis of the last 7 days
- /plan — training plan for the week
- Any question — just type it`;
    } else if (userText.startsWith('/connect')) {
      metrics.telegram.messages_by_command.connect++;
      if (user.strava_athlete_id) {
        reply = '✅ Strava is already connected. Use /sync30d to refresh your data.';
      } else {
        const redirectUri = `${process.env.APP_BASE_URL}/setup/strava-callback`;
        const oauthUrl = `https://www.strava.com/oauth/authorize` +
          `?client_id=${STRAVA_CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=activity%3Aread_all` +
          `&approval_prompt=force&state=${chatId}`;
        reply = `To connect Strava, open this link:\n${oauthUrl}\n\nAfter authorising, the bot will automatically have access to your activities.`;
      }
    } else if (userText.startsWith('/sync30d')) {
      metrics.telegram.messages_by_command.sync30d++;
      if (!user.strava_athlete_id) {
        reply = 'Connect Strava first: /connect';
      } else {
        await sendTelegramMessage(chatId, 'Syncing activities from Strava...');
        try {
          const count = await syncStravaActivities(user.id);
          reply = `Done — synced ${count} activities for the last 30 days.`;
        } catch (err) {
          reply = `Sync error: ${err.message}`;
        }
      }
    } else if (userText.startsWith('/feedback')) {
      metrics.telegram.messages_by_command.feedback++;
      reply = await getFeedbackResponse(user.id, chatId);
    } else if (userText.startsWith('/plan')) {
      metrics.telegram.messages_by_command.plan++;
      reply = await getPlanResponse(user.id, chatId);
    } else {
      metrics.telegram.messages_by_command.freetext++;
      reply = await getCoachingResponse(userText, user.id, chatId);
    }

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
    const isOverload = err?.status === 529 || err?.message?.includes('overloaded');
    const errMsg = isOverload
      ? 'Claude API is overloaded, try again in a minute.'
      : 'Something went wrong. Please try again.';
    if (!isOverload) alertAdmin(`[TrailCoach] handler error chat=${chatId}: ${err.message}`);
    sendTelegramMessage(chatId, errMsg).catch(() => {});
  }
});

module.exports = router;
