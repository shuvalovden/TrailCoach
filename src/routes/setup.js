'use strict';
const { Router } = require('express');
const { supabase, STRAVA_CLIENT_ID } = require('../lib/clients');
const { sendTelegramMessage } = require('../lib/telegram');
const { findOrCreateUser } = require('../lib/users');
const { metrics } = require('../lib/metrics');
const { clearSystemPromptCache } = require('../services/claude');

const router = Router();

// GET /setup/strava-webhook — one-time registration of Strava push subscription
router.get('/setup/strava-webhook', async (req, res) => {
  if (req.query.token !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const callbackUrl = `${process.env.APP_BASE_URL}/webhook/strava/${process.env.COMPOSIO_WEBHOOK_SECRET}`;
  const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: process.env.COMPOSIO_WEBHOOK_SECRET,
    }),
  });
  const data = await r.json();
  return res.status(r.status).json({ strava_status: r.status, data });
});

// GET /setup/strava-oauth — start Strava OAuth2 flow (one-time setup)
router.get('/setup/strava-oauth', (req, res) => {
  if (req.query.token !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const redirectUri = `${process.env.APP_BASE_URL}/setup/strava-callback`;
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=activity%3Aread_all&approval_prompt=force`;
  return res.redirect(url);
});

// GET /setup/strava-callback — Strava OAuth2 callback; stores tokens per user
router.get('/setup/strava-callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: 'No code' });
  if (!state) return res.status(400).json({ error: 'No state (chatId missing)' });
  const chatId = Number(state);
  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data });

    const user = await findOrCreateUser(chatId);

    const { error: tokenError } = await supabase.from('strava_tokens').upsert({
      user_id: user.id,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    });
    if (tokenError) {
      metrics.supabase.errors_total++;
      throw tokenError;
    }

    const { error: userError } = await supabase
      .from('users')
      .update({ strava_athlete_id: data.athlete.id })
      .eq('id', user.id);
    if (userError) {
      metrics.supabase.errors_total++;
      throw userError;
    }

    clearSystemPromptCache(chatId);

    await sendTelegramMessage(chatId,
      `✅ Strava connected! Hey, ${data.athlete.firstname}.\nRun /sync30d to load your activities.`
    );

    return res.send('<h2>✅ Done! Go back to Telegram.</h2>');
  } catch (err) {
    console.error('[strava-oauth] callback error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
