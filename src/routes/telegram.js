'use strict';
const { Router } = require('express');
const { findOrCreateUser } = require('../lib/users');
const { sendTelegramMessage, alertAdmin } = require('../lib/telegram');
const { getCoachingResponse, getFeedbackResponse, getPlanResponse, clearSystemPromptCache } = require('../services/claude');
const { supabase } = require('../lib/clients');
const { syncStravaActivities } = require('../services/strava');
const { metrics } = require('../lib/metrics');
const { STRAVA_CLIENT_ID } = require('../lib/clients');
const { t } = require('../lib/i18n');

const router = Router();

const LANGUAGE_KEYBOARD = {
  inline_keyboard: [[
    { text: 'EN English', callback_data: 'lang:en' },
    { text: '🇷🇺 Русский', callback_data: 'lang:ru' },
    { text: '🇮🇹 Italiano', callback_data: 'lang:it' },
  ]],
};

async function answerCallbackQuery(callbackQueryId) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

router.post('/webhook/telegram', async (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  metrics.telegram.messages_total++;
  res.json({ ok: true });

  // Handle language selection callback
  const callbackQuery = req.body?.callback_query;
  if (callbackQuery?.data?.startsWith('lang:')) {
    const lang = callbackQuery.data.split(':')[1];
    const chatId = callbackQuery.message.chat.id;
    await answerCallbackQuery(callbackQuery.id);
    if (!['en', 'ru', 'it'].includes(lang)) return;
    await supabase.from('users').update({ language: lang }).eq('telegram_chat_id', chatId);
    await sendTelegramMessage(chatId, t(lang, 'language_set') + '\n\n' + t(lang, 'start'));
    return;
  }

  const message = req.body?.message;
  if (!message?.text) return;
  const chatId = message.chat.id;

  try {
    const userText = message.text.trim();

    const user = await findOrCreateUser(chatId);
    if (!user.is_active) {
      await sendTelegramMessage(chatId, t(user.language, 'access_restricted'));
      return;
    }

    const lang = user.language ?? 'en';
    let reply;
    let replyMarkup;

    if (userText.startsWith('/start')) {
      metrics.telegram.messages_by_command.start++;
      reply = t(lang, 'choose_language');
      replyMarkup = LANGUAGE_KEYBOARD;
    } else if (userText.startsWith('/connect')) {
      metrics.telegram.messages_by_command.connect++;
      if (user.strava_athlete_id) {
        reply = t(lang, 'strava_already_connected');
      } else {
        const redirectUri = `${process.env.APP_BASE_URL}/setup/strava-callback`;
        const oauthUrl = `https://www.strava.com/oauth/authorize` +
          `?client_id=${STRAVA_CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=activity%3Aread_all` +
          `&approval_prompt=force&state=${chatId}`;
        reply = t(lang, 'strava_connect_link', oauthUrl);
      }
    } else if (userText.startsWith('/sync30d')) {
      metrics.telegram.messages_by_command.sync30d++;
      if (!user.strava_athlete_id) {
        reply = t(lang, 'strava_connect_first');
      } else {
        await sendTelegramMessage(chatId, t(lang, 'syncing'));
        try {
          const count = await syncStravaActivities(user.id);
          reply = t(lang, 'sync_done', count);
        } catch (err) {
          reply = t(lang, 'sync_error', err.message);
        }
      }
    } else if (userText.startsWith('/profile')) {
      metrics.telegram.messages_by_command.profile = (metrics.telegram.messages_by_command.profile || 0) + 1;
      const profileText = userText.replace('/profile', '').trim();
      if (!profileText) {
        reply = t(lang, 'profile_prompt');
      } else {
        const { error } = await supabase
          .from('users')
          .update({ profile_text: profileText })
          .eq('telegram_chat_id', chatId);
        if (error) {
          reply = t(lang, 'profile_error');
        } else {
          clearSystemPromptCache(chatId);
          reply = t(lang, 'profile_saved');
        }
      }
    } else if (userText.startsWith('/feedback')) {
      metrics.telegram.messages_by_command.feedback++;
      reply = await getFeedbackResponse(user.id, chatId, lang);
    } else if (userText.startsWith('/plan')) {
      metrics.telegram.messages_by_command.plan++;
      reply = await getPlanResponse(user.id, chatId, lang);
    } else {
      metrics.telegram.messages_by_command.freetext++;
      reply = await getCoachingResponse(userText, user.id, chatId, lang);
    }

    await sendTelegramMessage(chatId, reply, replyMarkup);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
    const isOverload = err?.status === 529 || err?.message?.includes('overloaded');
    const errMsg = isOverload ? 'Claude API is overloaded, try again in a minute.' : 'Something went wrong. Please try again.';
    if (!isOverload) alertAdmin(`[TrailCoach] handler error chat=${chatId}: ${err.message}`);
    sendTelegramMessage(chatId, errMsg).catch(() => { });
  }
});

module.exports = router;
